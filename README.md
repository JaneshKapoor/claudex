# Claudex

**Your AI subscription usage — Claude, ChatGPT and Codex — on your Android home screen and in your browser.**

Claudex shows how much of your 5-hour session cap and weekly cap you have burned
through, for every provider at once, refreshed in the background and synced across
devices.

---

## ⬇️ Download the app

### **[Download claudex.apk](https://github.com/JaneshKapoor/claudex/raw/main/dist/claudex.apk)** · 8.6 MB · Android 8.0+

A release build, signed and ready to install — no build step, no Android Studio.
The live backend URL is already compiled in, so it works the moment you open it.

### 🌐 Live dashboard & API: **https://api-2b9b-3000.prg1.zerops.app**

Same data as the widget, in the browser. Running on Zerops right now.

---

## Install it in four steps

1. **[Download the APK](https://github.com/JaneshKapoor/claudex/raw/main/dist/claudex.apk)** to your phone
   (or `adb install dist/claudex.apk`) and open it — allow installs from this source when asked.
2. The header should read **Backend reachable**. Nothing to configure.
3. Tap **Pair Claude** or **Pair ChatGPT** and sign in normally. Claudex captures the
   session cookie once and hands it to your backend — it never sees your password.
4. Long-press the home screen → **Widgets** → **Claudex Usage** → drag it out.

Pairing ChatGPT links Codex at the same time; they share one account session.

> **Tip:** if Google's sign-in refuses with *"this browser or app may not be secure"*,
> use email + password instead. Google blocks OAuth inside embedded WebViews. The
> cookie capture is identical either way.

---

## What it looks like

```
┌──────────────────────────────┐
│ Claudex              4m ago  │
│ ┌──────────────────────────┐ │
│ │ Claude                   │ │
│ │ Session            23%   │ │
│ │ █████░░░░░░░░░░░░░░░░░░  │ │  ← neutral below 60%
│ │ resets in 1h 32m         │ │
│ │ Weekly              4%   │ │
│ │ █░░░░░░░░░░░░░░░░░░░░░░  │ │
│ │ resets in 5d 18h         │ │
│ └──────────────────────────┘ │
│ ┌──────────────────────────┐ │
│ │ ChatGPT                  │ │
│ │ ...                      │ │
│ └──────────────────────────┘ │
└──────────────────────────────┘
```

Every card shares one 16dp radius token, one bar height and one bar inset. Bar colour
tracks **pressure, not brand** — neutral under 60%, warning 60–85%, alert above 85% —
so the whole widget is scannable at a glance. Percentages are monospaced so a change
from 9% to 89% never shifts the layout. Reset times are always relative countdowns.

---

## How it works

Token storage and provider polling live on the **backend**, not on the phone. A new
phone just re-pairs — all history and the working polling logic are already server-side.
And when a provider changes an internal endpoint, it is fixed in one place instead of
shipped as an app update to every device.

```
 Android app ──pair once──▶ ┌───────────────┐        ┌──────────────┐
 (WebView login,            │  Claudex API  │◀──────▶│  Postgres    │  accounts,
  reads session cookie)     │   (Fastify)   │        │              │  encrypted tokens,
                            └───────┬───────┘        └──────────────┘  snapshot history
 Android widget ──/v1/usage─────────┤                ┌──────────────┐
 Web dashboard ──/v1/usage──────────┤◀──────────────▶│  Valkey      │  read cache +
                                    │                └──────────────┘  poller lock
                            ┌───────▼───────┐        ┌──────────────┐
                            │    Worker     │───────▶│  Object      │  CSV exports,
                            │ polls ~25 min │        │  storage     │  pairing QR codes
                            └───────┬───────┘        └──────────────┘
                                    │
                    claude.ai · chatgpt.com (unofficial endpoints)
```

The phone talks to claude.ai / chatgpt.com **exactly once**, during pairing. After that
it only ever calls `/v1/usage` on your own backend. Reads never touch a provider — they
come from Valkey, falling back to Postgres — so a provider being slow can never slow
down the widget.

---

## Deployed on Zerops

Six services, created from [`zerops-project-import.yml`](zerops-project-import.yml) in
one command. All live:

| Service | Type | Role |
| --- | --- | --- |
| `api` | nodejs@22 | Fastify API + the dashboard, public |
| `worker` | nodejs@22 | background poller, private |
| `db` | postgresql@16 | accounts, encrypted tokens, snapshot history |
| `cache` | valkey@7.2 | read cache and poller lock |
| `storage` | object-storage | CSV exports, pairing QR PNGs |
| `dashboard` | nginx@1.22 | the static dashboard |

Health check, live: **https://api-2b9b-3000.prg1.zerops.app/v1/health**

```json
{"status":"ok","dependencies":{"postgres":"ok","redis":"ok","objectStorage":"configured"}}
```

Built to survive judging, not just first deploy:

- `api` holds `minContainers: 1`, so it is never cold.
- `/health` is dependency-free — a Postgres blip cannot get a healthy container killed.
- The API also serves the dashboard at `/`, so **one URL demos everything** even if the
  dashboard service is down.
- The worker holds a Valkey lock for a whole cycle, so a redeploy overlapping a running
  cycle cannot double-poll the providers.
- The database schema applies itself on boot. There is no manual migration step.

Full walkthrough: [docs/DEPLOY.md](docs/DEPLOY.md).

---

## The API

```
POST   /v1/pair                { provider, sessionToken, deviceSecret? }  → { accountId, deviceSecret }
GET    /v1/usage?accountId=…   → [{ provider, sessionPct, weeklyPct, sessionResetAt,
                                    weeklyResetAt, lastFetchedAt, status }]
GET    /v1/usage/history?accountId=…&provider=…&hours=168   → time series for the trend line
GET    /v1/usage/export.csv?accountId=…                     → CSV (also written to object storage)
POST   /v1/pair/code           → short code so the dashboard can join the account
GET    /v1/pair/qr?code=…      → that code as a QR PNG
POST   /v1/pair/redeem         { code } → { accountId, deviceSecret }
POST   /v1/refresh             (device header) → force a live poll now
GET    /v1/links?accountId=…   → per-link diagnostics: auth failure vs fetch failure
GET    /v1/links/raw?accountId=…&provider=…  → the provider's last payload beside what we parsed
GET    /v1/health              → dependency status
```

Reads are authorised by the account UUID; writes additionally require the
`x-claudex-device` secret issued at pairing.

---

## Security

- Provider tokens are encrypted at rest with **AES-256-GCM**, the key from a Zerops env
  secret. Plaintext never reaches Postgres.
- Device secrets are stored as SHA-256 digests, never in the clear.
- The app is TLS-only by construction (`usesCleartextTraffic="false"`).
- Any 401/403 from a provider marks that link `needs_repair`, **stops polling it**, and
  surfaces the state in the widget and dashboard rather than failing quietly.
- Pairing starts from a cleared cookie jar, so a dead session can never be re-paired by
  accident.

---

## Working against unofficial endpoints

No provider documents a personal-usage API. Every fetch module carries a
`// UNOFFICIAL — reverse-engineered, may break without notice` header, is isolated so one
provider failing cannot affect the others, and tries a **list** of candidate endpoints
rather than one hard-coded path. Responses go through a shape-tolerant parser that
searches for anything resembling a usage window, so a renamed wrapper key usually
changes nothing.

Failures are logged in two distinct kinds, which is what makes this maintainable:

| Log kind | Meaning | Action |
| --- | --- | --- |
| `provider_auth_failure` | 401/403, or an HTML login page instead of JSON | The token expired. The user re-pairs. |
| `provider_fetch_failure` | No candidate responded, or no recognisable window in the JSON | The endpoint moved. Add a URL. |

`GET /v1/links/raw` returns a provider's last payload next to what we parsed from it —
the tool for diagnosing a *wrong number* rather than a failed fetch.

Repair guide: [docs/REVERSE-ENGINEERING.md](docs/REVERSE-ENGINEERING.md).

---

## Verified, and known limits

Honest status, because these are undocumented endpoints.

**Verified in production**

- **Claude** works end to end. Session and weekly percentages and reset times match
  claude.ai's own usage page. Its payload is locked in as a regression test.
- **ChatGPT and Codex** pair, authenticate and fetch successfully.
- Pairing, encryption, polling, caching, `needs_repair` handling, CSV export and QR
  pairing all exercised against the live deployment.

**Known limits**

- **A ChatGPT "Go" plan exposes only a single 30-day window** — no 5-hour or weekly cap
  is returned by the provider. Claudex shows that window with its true countdown rather
  than inventing a session number. Plans that do report both windows will fill both bars.
- **Codex is not separately metered on that plan** — it returns the same payload as
  ChatGPT, so the two cards can show the same numbers. Claudex reports what the provider
  reports rather than fabricating a distinction.
- Google sign-in may be refused inside a WebView; email/password login works.
- Percentages can lag reality by up to ~25 minutes (the poll interval). **Refresh now**
  forces a live poll.

---

## Repository layout

| Path | What it is |
| --- | --- |
| [`dist/claudex.apk`](dist/claudex.apk) | **The installable release APK** |
| `server/` | Fastify API **and** background poller — one build, two entrypoints |
| `server/src/providers/` | Per-provider fetch modules, each marked unofficial |
| `server/scripts/selftest.mjs` | Crypto + parser tests, no infrastructure needed |
| `dashboard/` | The web dashboard: static HTML/CSS/JS, no build step |
| `android/` | Kotlin app: WebView pairing + Glance widget + WorkManager |
| `zerops.yml` | Build & run definitions for the three deployed services |
| `zerops-project-import.yml` | One-shot import of the whole Zerops project |
| `docs/DEPLOY.md` | Zerops deployment walkthrough |
| `docs/REVERSE-ENGINEERING.md` | How to repair a provider module when an endpoint moves |

---

## Local development

```bash
docker compose up -d                  # Postgres + KeyDB
cd server
cp .env.example .env                  # then set CLAUDEX_ENCRYPTION_KEY
npm ci && npm run build
npm run selftest                      # crypto + parser checks, no infra needed
npm run start:api                     # http://localhost:3000 (also serves the dashboard)
```

Build the APK yourself:

```bash
cd android
./gradlew assembleRelease             # app/build/outputs/apk/release/app-release.apk
```

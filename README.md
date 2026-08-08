# Claudex

An Android home-screen widget and web dashboard showing your AI subscription usage —
the 5-hour session cap and the weekly cap — for **Claude**, **ChatGPT** and **Codex**,
refreshed in the background and synced across devices.

```
┌──────────────────────────────┐
│ Claudex              4m ago  │
│ ┌──────────────────────────┐ │
│ │ Claude                   │ │
│ │ Session            42%   │ │
│ │ ███████░░░░░░░░░░░░░░░░  │ │
│ │ resets in 2h 14m         │ │
│ │ Weekly             88%   │ │
│ │ ███████████████████░░░░  │ │  ← alert tone at 85%+
│ │ resets in 3d 4h          │ │
│ └──────────────────────────┘ │
│ ┌──────────────────────────┐ │
│ │ ChatGPT     needs re-pair│ │
│ └──────────────────────────┘ │
└──────────────────────────────┘
```

## How it works

Token storage and provider polling live on the **backend**, not on the phone. Two
reasons: a new phone just re-pairs and all history is already there, and when a
provider changes its internal endpoint it is fixed in one place instead of shipped
as an app update to every device.

```
 Android app ──pair once──▶ ┌───────────────┐        ┌──────────────┐
 (WebView login,            │  Claudex API  │◀──────▶│  Postgres    │  accounts,
  reads session cookie)     │   (Fastify)   │        │              │  encrypted tokens,
                            └───────┬───────┘        └──────────────┘  snapshot history
 Android widget ──/v1/usage─────────┤                ┌──────────────┐
 Web dashboard ──/v1/usage──────────┤◀──────────────▶│  Valkey       │  read cache +
                                    │                └──────────────┘  poller lock
                            ┌───────▼───────┐        ┌──────────────┐
                            │    Worker     │───────▶│  Object      │  CSV exports,
                            │ polls ~25 min │        │  storage     │  pairing QR codes
                            └───────┬───────┘        └──────────────┘
                                    │
                    claude.ai · chatgpt.com (unofficial endpoints)
```

The phone talks to **claude.ai / chatgpt.com exactly once**, during pairing, to let
you log in normally in a WebView. After that it only ever calls `/v1/usage` on your
own backend.

## Repository layout

| Path | What it is |
| --- | --- |
| `server/` | Fastify API **and** the background poller — one build, two entrypoints |
| `server/src/providers/` | Per-provider fetch modules, each marked unofficial |
| `dashboard/` | The web dashboard: static HTML/CSS/JS, no build step |
| `android/` | Kotlin app: WebView pairing + Glance widget + WorkManager refresh |
| `zerops.yml` | Build & run definitions for the three deployed services |
| `zerops-project-import.yml` | One-shot import of the whole Zerops project |
| `dist/claudex.apk` | Built, installable release APK |

## Install the APK on your phone

`dist/claudex.apk` is a release build signed with the standard debug key, so it
installs without any extra setup.

1. Copy `dist/claudex.apk` to the phone (USB, Drive, or `adb install dist/claudex.apk`).
2. Open it and allow installing from this source when prompted.
3. Launch **Claudex** → put your backend URL in **API base URL** → **Save**.
   The header shows *Backend reachable* once it can see the API.
4. **Pair Claude** / **Pair ChatGPT** → sign in normally. The moment the provider
   sets its session cookie, the app captures it, sends it to your backend, and closes.
5. Long-press the home screen → **Widgets** → **Claudex Usage** → drag it out.

Pairing ChatGPT links Codex at the same time — they share one account session.

## The API

```
POST   /v1/pair                { provider, sessionToken, deviceSecret? }  → { accountId, deviceSecret }
GET    /v1/usage?accountId=…   → [{ provider, sessionPct, weeklyPct, sessionResetAt,
                                    weeklyResetAt, lastFetchedAt, status }]
GET    /v1/usage/history?accountId=…&provider=…&hours=168   → time series
GET    /v1/usage/export.csv?accountId=…                     → CSV (also written to object storage)
POST   /v1/pair/code           → short code so the dashboard can join the account
GET    /v1/pair/qr?code=…      → that code as a QR PNG
POST   /v1/pair/redeem         { code } → { accountId, deviceSecret }
POST   /v1/refresh             (device header) → force a poll now
GET    /v1/links?accountId=…   → per-link diagnostics (auth failure vs fetch failure)
GET    /v1/health              → dependency status
```

Reads are authorised by the account UUID. Writes additionally require the
`x-claudex-device` secret issued at pairing.

## Security

- Provider tokens are encrypted at rest with **AES-256-GCM**; the key comes from a
  Zerops env secret and plaintext never reaches Postgres.
- Device secrets are stored as SHA-256 digests, never in the clear.
- The app is TLS-only by construction (`usesCleartextTraffic="false"`).
- Any 401/403 from a provider marks that link `needs_repair`, **stops polling it**,
  and surfaces the state in both the widget and the dashboard rather than failing quietly.

## Unofficial endpoints

None of these providers documents a personal-usage API. Every fetch module carries a
`// UNOFFICIAL — reverse-engineered, may break without notice` header, is isolated so
one provider failing cannot affect the others, and logs `provider_auth_failure`
separately from `provider_fetch_failure` so an expired token is never confused with a
moved endpoint. See [docs/REVERSE-ENGINEERING.md](docs/REVERSE-ENGINEERING.md) for how
to repair a module when a provider changes something.

## Local development

```bash
docker compose up -d                  # Postgres + Valkey
cd server
cp .env.example .env                  # then set CLAUDEX_ENCRYPTION_KEY
npm ci && npm run build
npm run selftest                      # crypto + parser checks, no infra needed
npm run start:api                     # http://localhost:3000 (also serves the dashboard)
```

Build the APK:

```bash
cd android
./gradlew assembleRelease             # app/build/outputs/apk/release/app-release.apk
```

## Deploying to Zerops

See [docs/DEPLOY.md](docs/DEPLOY.md) — one project import creates Postgres, Valkey,
object storage, the API, the worker and the dashboard.

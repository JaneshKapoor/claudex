# Claudex — Build Brief for Claude Code (Opus 5)

Paste this whole document into Claude Code as the task. It is written as a direct instruction to you, the coding agent.

## What you're building

**Claudex**: an Android home-screen widget (plus a small web dashboard) that shows a user's AI subscription usage — the 5-hour session cap and weekly cap — for Claude, ChatGPT, and Codex, refreshed automatically and synced across devices.

This is for a hackathon where the deployed infrastructure is judged live, not demoed from a screen recording. Everything server-side runs on Zerops, and the project must stay reachable and working through judging, not just at first deploy.

## Non-negotiable constraint

There is no official public API for personal subscription usage on any of these providers. You are working against internal/undocumented endpoints that the providers' own apps use to render their own "usage" screens. Build accordingly:
- Isolate each provider's fetch logic behind its own module with a clear `// UNOFFICIAL — reverse-engineered, may break without notice` comment at the top.
- Never let one provider's fetch failing take down the others or the whole service.
- Log fetch failures distinctly from auth failures so it's obvious whether an endpoint changed vs. a token expired.

## Why the architecture is server-first, not on-device

Put the token storage and polling logic in one backend on Zerops instead of on each phone. This buys two things: (1) if the user changes phones, they just re-pair — all history and the working polling logic already live on the backend; (2) if a provider changes its internal endpoint, you fix it in one place instead of shipping an app update to every device.

## Architecture — use these Zerops services

1. **API service** (Node.js/TypeScript, Fastify) — deployed as a Zerops service. Handles pairing, serves cached usage to clients, never blocks on a live provider call.
2. **Postgres** (Zerops managed service) — accounts, encrypted provider tokens, usage snapshot history (for a simple trend line later).
3. **Redis or KeyDB** (Zerops managed service) — cache layer so widget/dashboard reads are fast, and to lock the poller so two runs don't race.
4. **Background worker** (separate Zerops service, runs on a schedule / long-lived loop) — polls each linked account's provider usage, writes a snapshot to Postgres, refreshes the Redis cache. Poll interval: every 20–30 minutes is enough for a 5-hour window; don't hammer the providers.
5. **S3-compatible object storage** (Zerops) — usage history CSV export, pairing QR code images.
6. **Web dashboard** (static or minimal Next.js, deployed on Zerops) — same usage view as the widget. This is your primary judged artifact — a URL that's alive and showing real data beats a phone screen recording. Build and deploy this first.
7. **Android app** (Kotlin) — thin client only. One-time pairing: open an embedded WebView, let the user log into claude.ai / chatgpt.com normally, extract the session cookie via `CookieManager`, POST it once to the Claudex API over TLS. After pairing, the app only ever talks to your own `/v1/usage` endpoint — never directly to Anthropic or OpenAI.

## Build order

1. Scaffold the Postgres schema + API service skeleton and deploy to Zerops immediately. Get a live URL up before writing any provider-fetch logic — that URL is what gets judged.
2. Build the ChatGPT/Codex fetch module first (most-documented starting point: `/backend-api/wham/usage` with a bearer token from the paired session). Wire it end to end: pair → poll → store → serve.
3. Build the web dashboard against that one provider to prove the full loop works and is live.
4. For Claude: there is no documented endpoint. Open Chrome DevTools (Network tab) while manually visiting Settings → Usage on claude.ai, find the request that returns session %, weekly %, and reset times, and build the fetch module against exactly that. Mark it clearly as reverse-engineered.
5. Add the Codex CLI local `/status` read as a fallback/cross-check data source if time allows — it's the one semi-official local read available.
6. Build the Android WebView pairing flow + widget last, pointed at the already-working backend.

## API contract (draft — refine as needed, keep it this small)

```
POST /v1/pair
  body: { provider: "claude" | "chatgpt", sessionToken: string }
  returns: { accountId: string }

GET /v1/usage?accountId=...
  returns: [{ provider, sessionPct, weeklyPct, sessionResetAt, weeklyResetAt, lastFetchedAt, status: "ok" | "needs_repair" }]

GET /v1/usage/history?accountId=...&provider=...
  returns: time series of snapshots for a simple trend line
```

## Security requirements

- Encrypt provider session tokens at rest (AES-256-GCM, key from a Zerops env-var secret, never plaintext in Postgres).
- TLS everywhere, especially the pairing endpoint.
- On any 401/403 from a provider, mark that account/provider link `needs_repair`, stop polling it, and surface that state to both the widget and dashboard instead of silently failing.

## Widget UX spec — follow this precisely, this is the part that has to look right

- One card per provider. Every card: same width, same height, same corner radius (pick one radius token, e.g. 16dp, and reuse it everywhere — don't hand-tune per card).
- Two bars per card, "Session" and "Weekly": identical bar height, identical corner radius, identical left/right padding across both bars and across every card, so nothing drifts visually between providers.
- Use tabular/monospaced figures for the percentage numbers so "12%" and "89%" don't shift the bar or text alignment as the number changes width.
- Color the bar fill by threshold, not by provider, using one consistent scale across the whole widget: under 60% neutral, 60–85% warning tone, 85%+ alert tone. This is what makes the whole widget scannable at a glance.
- Cap the palette at 2 accent colors + 1 neutral for the entire widget. Let the bar fill carry the signal; keep background, card outline, and text restrained.
- Show reset time as a relative countdown ("resets in 2h 14m"), not a raw timestamp.
- Always render a defined state per card: normal, loading/skeleton, or "needs re-pair" — never a blank tile or a crash.
- Reuse the Glance + WorkManager shell pattern from an existing widget project if one is available in this workspace; don't build the widget scaffolding from scratch if a working pattern already exists.

## Naming

Use "Claudex" consistently: repo name, Zerops project name, Android app label, dashboard title.

## What to ask me before proceeding

If anything below is ambiguous, ask once before building rather than guessing:
- Whether I want a real user-facing login (email/password) on top of the pairing flow, or if device-pairing alone is enough for now.
- Whether Codex should be tracked as its own provider or folded into the ChatGPT card.

# Repairing a provider module

None of these providers publishes a personal-usage API. Claudex reads the same
internal endpoints their own web apps call to draw their own usage screens, which
means **any of them can change without warning**. This document is how you fix that
in ten minutes instead of rewriting anything.

## The design that makes this cheap

- Each provider lives in its own file under `server/src/providers/`, each with a
  `// UNOFFICIAL — reverse-engineered, may break without notice` header.
- Every call goes through `safeFetchUsage()`, so one provider throwing can never
  take down a poll cycle, another provider, or a request.
- Each module tries a **list** of candidate endpoints, not one hard-coded path.
- Responses are parsed by `providers/parse.ts`, which searches the payload for
  anything shaped like a usage window (a percentage plus a reset hint) rather than
  binding to exact JSON paths. A renamed wrapper key usually changes nothing.

So in practice a break means adding one URL to one array.

## Telling the two failure modes apart

This is the whole point of the logging split:

| Log `kind` | Meaning | What to do |
| --- | --- | --- |
| `provider_auth_failure` | 401/403, or an HTML login page instead of JSON | The user's token expired. Nothing to fix in code — they re-pair. The link is set to `needs_repair` and polling stops. |
| `provider_fetch_failure` | Anything else: no candidate responded, or JSON arrived with no recognisable window | **The endpoint probably moved.** Follow the steps below. |
| `provider_module_crash` | The module threw unexpectedly | A real bug — read the stack trace. |

Check a specific account's links without reading logs:

```bash
curl "https://<api>/v1/links?accountId=<uuid>"
```

`last_error_kind` is `auth` or `fetch` per link.

## Finding the new endpoint

1. Open the provider in Chrome, logged in.
2. DevTools → **Network** → filter **Fetch/XHR** → tick **Preserve log**.
3. Hard-reload, then open the usage screen:
   - Claude: Settings → Usage
   - ChatGPT: Settings, or the usage panel in the composer
4. Find the response containing the session/weekly percentages and reset times.
   Sort by size — it is rarely the largest response.
5. Copy the **request path** and the **response JSON**.

## Applying the fix

Add the path to the candidate list at the top of the module:

- `server/src/providers/claude.ts` → `USAGE_PATHS` (org-scoped) or `FALLBACK_PATHS`
- `server/src/providers/chatgpt.ts` → `USAGE_ENDPOINTS`
- `server/src/providers/codex.ts` → `USAGE_ENDPOINTS`

Put the new path **first**. Leave the old ones — they cost nothing (a failed
candidate is skipped in milliseconds) and they keep working for anyone the change
has not rolled out to yet.

Then confirm the parser still recognises the payload. Paste the real response into
`server/scripts/selftest.mjs` as a new case and run:

```bash
cd server && npm run build && npm run selftest
```

If `usageFromPayload()` returns `null` for the new shape, the payload uses key names
the parser does not know. Add them to `PCT_KEYS`, `RESET_AT_KEYS`, `RESET_IN_KEYS` or
`WINDOW_MIN_KEYS` in `providers/parse.ts` — that fixes it for every provider at once.

## How windows are classified

`classifyWindows()` decides which reading is "session" and which is "weekly":

1. **Window length wins when the provider states it** — up to 24h is the session
   cap, longer is the weekly cap. This is the most reliable signal.
2. Otherwise, key names: `primary|session|five_hour|short` → session,
   `secondary|weekly|seven_day|long` → weekly.
3. Otherwise, position: providers list the short window first.

If a provider starts reporting a genuinely different window (say a monthly cap),
verify against DevTools before trusting the classification.

## Auth shapes, per provider

| Provider | What is captured | How it is used |
| --- | --- | --- |
| Claude | `sessionKey` cookie (`sk-ant-sid01-…`) | Sent as a `Cookie` header, plus `anthropic-client-platform: web_claude_ai` — without that header some paths 403 even with a valid cookie, which would otherwise look like an expired session |
| ChatGPT | `__Secure-next-auth.session-token` cookie (possibly split across `.0`, `.1`, … chunks, which the app rejoins) | Exchanged at `/api/auth/session` for a bearer token, exactly as the web client does on load |
| Codex | The ChatGPT session | Same bearer token, plus `originator: codex_cli_rs`; falls back to the `x-codex-primary-*` response headers the Codex CLI's own `/status` reads |

## Rate limiting yourself

The worker polls every ~25 minutes. That is ample resolution for a 5-hour window and
keeps Claudex far below anything that looks like abuse. If you shorten
`POLL_INTERVAL_MS`, remember it multiplies by the number of linked accounts.

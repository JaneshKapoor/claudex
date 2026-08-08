# Deploying Claudex to Zerops

Six services, one import. Roughly ten minutes end to end.

## 0. Install the CLI and log in

```bash
npm i -g @zerops/zcli
zcli login            # paste a personal access token from Zerops → Access token management
```

> `zcli login` is interactive. In Claude Code, run it yourself with `! zcli login`
> so the prompt lands in your own terminal.

## 1. Create the whole project in one shot

```bash
zcli project project-import zerops-project-import.yml
```

This creates, with the right dependencies wired between them:

| Service | Type | Why |
| --- | --- | --- |
| `db` | postgresql@16 | accounts, encrypted tokens, usage snapshot history |
| `cache` | valkey@7.2 | read cache for the widget/dashboard, and the poller lock |
| `storage` | object-storage | usage CSV exports and pairing QR code PNGs |
| `api` | nodejs@22 | Fastify API, public subdomain |
| `worker` | nodejs@22 | background poller, no public access |
| `dashboard` | nginx@1.22 | the static dashboard, public subdomain |

## 1b. Set the encryption key by hand (required)

The `<@generateRandomString(<64>)>` placeholder in the import YAML is **not**
expanded for `envSecrets` — the literal string is stored, and the API refuses to
boot with it. zcli has no env-var command, so set it in the GUI.

Generate a key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then in the Zerops GUI, for **both** the `api` and `worker` services:
**Environment variables → Secret variables →** set `CLAUDEX_ENCRYPTION_KEY` to that
value → **Save** → **Restart**.

The two must be **byte-identical**: the worker writes tokens the API reads back.

> **Do not rotate that key later.** Every stored provider token is encrypted with
> it; changing it forces every account to re-pair.

## 2. Push the code

```bash
zcli push --serviceId <api-service-id>       --setup api
zcli push --serviceId <worker-service-id>    --setup worker
zcli push --serviceId <dashboard-service-id> --setup dashboard
```

Service IDs are in the Zerops GUI, or `zcli service list -P <project-id>`.
`zcli push` also accepts the service **name** directly, e.g. `zcli push api -P <project-id> --setup api`.

> **Gotcha:** the `run.envVariables` block in `zerops.yml` *replaces* a service's
> env variables on every deploy. That is why the `${db_connectionString}` /
> `${cache_connectionString}` references live in `zerops.yml` and not only in the
> import YAML — anything set only at import time is wiped by the first push.
> `envSecrets` are separate and are not touched by a deploy.

Alternatively connect the GitHub repo (`JaneshKapoor/claudex`) to each service in
the GUI and enable build-on-push — the `zerops.yml` at the repo root already
defines all three setups.

## 3. Enable the public subdomains

In the Zerops GUI, on `api` and on `dashboard`: **Public access → Enable Zerops
subdomain**. You get URLs like:

```
https://api-claudex-<hash>.prg1.zerops.app
https://dashboard-claudex-<hash>.prg1.zerops.app
```

## 4. Fill in the two URL env vars

On the `api` service, set:

```
PUBLIC_BASE_URL = https://api-claudex-<hash>.prg1.zerops.app
DASHBOARD_URL   = https://dashboard-claudex-<hash>.prg1.zerops.app
```

These only affect the pairing QR link target. Restart the service after saving.

## 5. Verify it is live

```bash
curl https://api-claudex-<hash>.prg1.zerops.app/v1/health
```

Expect `status: ok` with `postgres: ok` and `redis: ok`. The schema is applied
automatically on first boot — there is no manual migration step.

Open the dashboard URL. With nothing paired yet it shows the empty state and the
service health line at the bottom; that alone proves the full stack is reachable.

## 6. Point the phone at it

In the Claudex app: **API base URL** → the `api` URL from step 3 → **Save**. The
header should read *Backend reachable*. Then pair a provider.

To show the same account on the dashboard: in the app tap **Link dashboard**, then
enter that code in the dashboard's **Account** panel (or open
`https://dashboard-…/?code=ABCD-EFGH`).

## Keeping it alive through judging

- `api` runs with `minContainers: 1` so it is never cold.
- `/health` is dependency-free, so a brief Postgres blip cannot get a healthy API
  container killed and restarted.
- The API also serves a copy of the dashboard at `/`, so even if the `dashboard`
  service is down the API URL alone still demonstrates the whole product.
- The worker holds a Valkey lock for a whole poll cycle, so a redeploy overlapping
  a running cycle cannot double-poll the providers.
- Reads never touch a provider — they come from Valkey, falling back to Postgres.
  A provider being slow or down cannot slow the judged URL.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `/v1/health` shows `postgres: down` | `DATABASE_URL` not resolving | Confirm the `db` service is running and the env var reads `${db_connectionString}` |
| Cards stuck on "waiting…" | Worker has not completed a cycle yet | Check `worker` logs; first pass runs ~5s after boot |
| A card says "needs re-pair" | Provider returned 401/403 | Re-pair that provider in the app — this is the intended behaviour, not a bug |
| Logs show `provider_fetch_failure` | The provider moved its endpoint | See [REVERSE-ENGINEERING.md](REVERSE-ENGINEERING.md) |
| `token could not be decrypted` | `CLAUDEX_ENCRYPTION_KEY` changed | Restore the old key, or have everyone re-pair |

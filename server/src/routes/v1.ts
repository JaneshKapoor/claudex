import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import QRCode from 'qrcode';
import { env } from '../lib/env.js';
import { log } from '../lib/log.js';
import { PROVIDERS, isProvider, type Provider } from '../lib/types.js';
import { providers } from '../providers/index.js';
import {
  accountExists,
  addDevice,
  authenticateDevice,
  createAccountWithDevice,
  deleteProviderLink,
  issuePairingCode,
  redeemPairingCode,
  upsertProviderLink,
} from '../lib/accounts.js';
import { getHistory, getUsageForAccount, historyCsv } from '../lib/usage.js';
import { runPollCycle, refreshCache } from '../lib/poller.js';
import { putObject, storageEnabled } from '../lib/storage.js';
import { query } from '../lib/db.js';

const DEVICE_HEADER = 'x-claudex-device';

const uuid = z.string().uuid();

/**
 * Reads are authorised by the account UUID alone (unguessable, and it is what the
 * widget holds). Writes additionally require the device secret issued at pairing.
 */
async function requireDevice(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const secret = req.headers[DEVICE_HEADER];
  if (typeof secret !== 'string' || secret.length < 16) {
    await reply.code(401).send({ error: 'missing_device_credential', detail: `send the ${DEVICE_HEADER} header` });
    return null;
  }
  const identity = await authenticateDevice(secret);
  if (!identity) {
    await reply.code(401).send({ error: 'unknown_device', detail: 'this device is not paired — pair again' });
    return null;
  }
  return identity.accountId;
}

async function requireAccountId(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const parsed = uuid.safeParse((req.query as { accountId?: string }).accountId);
  if (!parsed.success) {
    await reply.code(400).send({ error: 'bad_account_id', detail: 'accountId must be a UUID' });
    return null;
  }
  if (!(await accountExists(parsed.data))) {
    await reply.code(404).send({ error: 'unknown_account', detail: 'no such account — pair again' });
    return null;
  }
  return parsed.data;
}

const pairBody = z.object({
  provider: z.enum(PROVIDERS),
  sessionToken: z.string().min(8).max(8192),
  // `.nullish()` rather than `.optional()` throughout: clients legitimately send an
  // explicit null for "I don't have one yet" (the first pair has no device secret),
  // and rejecting that is a validation bug, not a safety property.
  /** Omit or null on first pair; the server mints a new account and device. */
  deviceSecret: z.string().min(16).nullish(),
  platform: z.string().max(40).nullish(),
  label: z.string().max(80).nullish(),
  /** Pairing ChatGPT also links Codex by default — same account session. */
  linkCodex: z.boolean().nullish(),
});

export async function registerV1(app: FastifyInstance): Promise<void> {
  app.get('/v1/providers', async () => ({
    providers: PROVIDERS.map((id) => ({
      id,
      displayName: providers[id].displayName,
      repairHint: providers[id].repairHint,
      /** The login origin the Android WebView should open for this provider. */
      loginUrl:
        id === 'claude' ? 'https://claude.ai/login' : 'https://chatgpt.com/auth/login',
      /** Codex has no login of its own; it rides the ChatGPT session. */
      pairable: id !== 'codex',
    })),
  }));

  // ---- pairing ------------------------------------------------------------

  app.post('/v1/pair', async (req, reply) => {
    const parsed = pairBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', detail: parsed.error.issues[0]?.message });
    }
    const { provider, sessionToken, deviceSecret, platform, label, linkCodex } = parsed.data;

    let accountId: string;
    let issuedSecret: string | undefined;
    let deviceId: string | undefined;

    if (deviceSecret) {
      const identity = await authenticateDevice(deviceSecret);
      if (!identity) {
        return reply.code(401).send({ error: 'unknown_device', detail: 'device secret not recognised' });
      }
      accountId = identity.accountId;
      deviceId = identity.deviceId;
    } else {
      const created = await createAccountWithDevice(platform ?? 'unknown', label ?? null);
      accountId = created.accountId;
      issuedSecret = created.deviceSecret;
      deviceId = created.deviceId;
    }

    await upsertProviderLink(accountId, provider, sessionToken);
    // Codex authenticates with the same ChatGPT session, so pairing one links both.
    if (provider === 'chatgpt' && linkCodex !== false) {
      await upsertProviderLink(accountId, 'codex', sessionToken);
    }
    await refreshCache(accountId);

    // Poll immediately so the widget has a number within seconds, but never block
    // the pairing response on a provider call.
    void runPollCycle(accountId).catch((err) =>
      log.error({ err: (err as Error).message, accountId }, 'post-pair poll failed'),
    );

    log.info({ accountId, provider, newAccount: Boolean(issuedSecret) }, 'provider paired');
    return reply.code(201).send({
      accountId,
      deviceId,
      ...(issuedSecret ? { deviceSecret: issuedSecret } : {}),
      provider,
      status: 'pending',
    });
  });

  /** Issues a short code so a second device (or the dashboard) can join this account. */
  app.post('/v1/pair/code', async (req, reply) => {
    const accountId = await requireDevice(req, reply);
    if (!accountId) return;
    const { code, expiresAt } = await issuePairingCode(accountId);
    const dashboard = env.dashboardUrl || env.publicBaseUrl;
    const linkUrl = dashboard ? `${dashboard.replace(/\/$/, '')}/?code=${code}` : '';
    let qrUrl: string | null = null;
    if (storageEnabled()) {
      const png = await QRCode.toBuffer(linkUrl || code, { width: 512, margin: 1 });
      qrUrl = await putObject(`pairing/${code}.png`, png, 'image/png');
    }
    return reply.send({ code, expiresAt, linkUrl, qrUrl });
  });

  /** Renders the QR inline — always works, even without object storage configured. */
  app.get('/v1/pair/qr', async (req, reply) => {
    const code = (req.query as { code?: string }).code;
    if (!code) return reply.code(400).send({ error: 'bad_request', detail: 'code is required' });
    const dashboard = env.dashboardUrl || env.publicBaseUrl;
    const linkUrl = dashboard ? `${dashboard.replace(/\/$/, '')}/?code=${code}` : code;
    const png = await QRCode.toBuffer(linkUrl, { width: 512, margin: 1 });
    return reply.header('content-type', 'image/png').header('cache-control', 'no-store').send(png);
  });

  app.post('/v1/pair/redeem', async (req, reply) => {
    const body = z
      .object({ code: z.string().min(4).max(32), platform: z.string().max(40).nullish(), label: z.string().max(80).nullish() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const device = await redeemPairingCode(body.data.code, body.data.platform ?? 'unknown', body.data.label ?? null);
    if (!device) {
      return reply.code(400).send({ error: 'invalid_code', detail: 'code is unknown, already used, or expired' });
    }
    return reply.code(201).send(device);
  });

  // ---- usage --------------------------------------------------------------

  app.get('/v1/usage', async (req, reply) => {
    const accountId = await requireAccountId(req, reply);
    if (!accountId) return;
    const rows = await getUsageForAccount(accountId);
    return reply.header('cache-control', 'no-store').send(rows);
  });

  app.get('/v1/usage/history', async (req, reply) => {
    const accountId = await requireAccountId(req, reply);
    if (!accountId) return;
    const q = req.query as { provider?: string; hours?: string; limit?: string };
    const provider: Provider | null = q.provider && isProvider(q.provider) ? q.provider : null;
    const hours = Math.min(Math.max(Number(q.hours ?? 168) || 168, 1), 24 * 90);
    const limit = Math.min(Math.max(Number(q.limit ?? 2000) || 2000, 1), 10000);
    const series = await getHistory(accountId, provider, hours, limit);
    return reply.send({ accountId, hours, series });
  });

  /** CSV export. Persisted to Zerops object storage when configured, streamed either way. */
  app.get('/v1/usage/export.csv', async (req, reply) => {
    const accountId = await requireAccountId(req, reply);
    if (!accountId) return;
    const hours = Math.min(Math.max(Number((req.query as { hours?: string }).hours ?? 720) || 720, 1), 24 * 365);
    const csv = await historyCsv(accountId, hours);
    if (storageEnabled()) {
      const url = await putObject(`exports/${accountId}/latest.csv`, csv, 'text/csv');
      if (url) reply.header('x-claudex-export-url', url);
    }
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="claudex-usage.csv"`)
      .send(csv);
  });

  /** Manual refresh — bounded, and still never blocks on a slow provider forever. */
  app.post('/v1/refresh', async (req, reply) => {
    const accountId = await requireDevice(req, reply);
    if (!accountId) return;
    const outcomes = await Promise.race([
      runPollCycle(accountId),
      new Promise<null>((r) => setTimeout(() => r(null), 20_000)),
    ]);
    if (outcomes === null) {
      return reply.code(202).send({ status: 'in_progress', detail: 'poll still running, read /v1/usage shortly' });
    }
    return reply.send({ status: 'done', outcomes, usage: await getUsageForAccount(accountId) });
  });

  app.delete('/v1/link/:provider', async (req, reply) => {
    const accountId = await requireDevice(req, reply);
    if (!accountId) return;
    const p = (req.params as { provider: string }).provider;
    if (!isProvider(p)) return reply.code(400).send({ error: 'bad_provider' });
    const removed = await deleteProviderLink(accountId, p);
    await refreshCache(accountId);
    return reply.send({ removed });
  });

  /** Link diagnostics — makes an endpoint change vs an expired token visible. */
  app.get('/v1/links', async (req, reply) => {
    const accountId = await requireAccountId(req, reply);
    if (!accountId) return;
    const res = await query(
      `SELECT provider, status, last_error, last_error_kind, consecutive_failures, last_fetched_at, created_at
         FROM provider_links WHERE account_id = $1 ORDER BY provider`,
      [accountId],
    );
    return reply.send(res.rows);
  });
}

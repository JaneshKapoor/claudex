import { query } from './db.js';
import { cacheGet, cacheSet, usageCacheKey } from './redis.js';
import { env } from './env.js';
import { providers } from '../providers/index.js';
import { PROVIDERS, type Provider, type ProviderUsage, type UsageRow, type LinkStatus } from './types.js';

interface LinkRow {
  provider: Provider;
  status: LinkStatus;
  last_error: string | null;
  last_error_kind: string | null;
  last_fetched_at: Date | null;
}

interface SnapshotRow {
  provider: Provider;
  session_pct: number | null;
  weekly_pct: number | null;
  session_reset_at: Date | null;
  weekly_reset_at: Date | null;
  captured_at: Date;
}

/**
 * Reads never touch a provider. They read the Redis cache, and fall back to
 * Postgres — so a provider being slow or down can never slow down the widget.
 */
export async function getUsageForAccount(accountId: string): Promise<UsageRow[]> {
  const cached = await cacheGet<UsageRow[]>(usageCacheKey(accountId));
  if (cached) return cached;
  const rows = await buildUsageFromDb(accountId);
  await cacheSet(usageCacheKey(accountId), rows, env.cacheTtlSeconds);
  return rows;
}

export async function buildUsageFromDb(accountId: string): Promise<UsageRow[]> {
  const links = await query<LinkRow>(
    `SELECT provider, status, last_error, last_error_kind, last_fetched_at
       FROM provider_links WHERE account_id = $1`,
    [accountId],
  );
  if (links.rowCount === 0) return [];

  // Latest snapshot per provider.
  const snaps = await query<SnapshotRow>(
    `SELECT DISTINCT ON (provider)
            provider, session_pct, weekly_pct, session_reset_at, weekly_reset_at, captured_at
       FROM usage_snapshots
      WHERE account_id = $1
      ORDER BY provider, captured_at DESC`,
    [accountId],
  );
  const byProvider = new Map<Provider, SnapshotRow>();
  for (const s of snaps.rows) byProvider.set(s.provider, s);

  const order = new Map(PROVIDERS.map((p, i) => [p, i]));
  return links.rows
    .sort((a, b) => (order.get(a.provider) ?? 99) - (order.get(b.provider) ?? 99))
    .map((link) => {
      const snap = byProvider.get(link.provider);
      const row: UsageRow = {
        provider: link.provider,
        displayName: providers[link.provider]?.displayName ?? link.provider,
        sessionPct: snap?.session_pct ?? null,
        weeklyPct: snap?.weekly_pct ?? null,
        sessionResetAt: snap?.session_reset_at?.toISOString() ?? null,
        weeklyResetAt: snap?.weekly_reset_at?.toISOString() ?? null,
        lastFetchedAt: link.last_fetched_at?.toISOString() ?? snap?.captured_at.toISOString() ?? null,
        // A link is only 'ok' for clients once it has actually produced a number.
        status: link.status === 'ok' && !snap ? 'pending' : link.status,
      };
      if (link.status === 'needs_repair') {
        row.message = providers[link.provider]?.repairHint ?? 'Re-pair this provider.';
      } else if (row.status === 'pending') {
        row.message = 'Waiting for the first reading…';
      }
      return row;
    });
}

export async function recordSnapshot(
  accountId: string,
  provider: Provider,
  usage: ProviderUsage,
  source = 'poller',
): Promise<void> {
  await query(
    `INSERT INTO usage_snapshots
       (account_id, provider, session_pct, weekly_pct, session_reset_at, weekly_reset_at, source, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      accountId,
      provider,
      usage.sessionPct,
      usage.weeklyPct,
      usage.sessionResetAt,
      usage.weeklyResetAt,
      source,
      usage.raw ? JSON.stringify(usage.raw).slice(0, 20000) : null,
    ],
  );
}

export interface HistoryPoint {
  capturedAt: string;
  sessionPct: number | null;
  weeklyPct: number | null;
}

export async function getHistory(
  accountId: string,
  provider: Provider | null,
  hours: number,
  limit: number,
): Promise<Record<string, HistoryPoint[]>> {
  const res = await query<SnapshotRow>(
    `SELECT provider, session_pct, weekly_pct, session_reset_at, weekly_reset_at, captured_at
       FROM usage_snapshots
      WHERE account_id = $1
        AND ($2::text IS NULL OR provider = $2)
        AND captured_at > now() - ($3 || ' hours')::interval
      ORDER BY captured_at ASC
      LIMIT $4`,
    [accountId, provider, String(hours), limit],
  );
  const out: Record<string, HistoryPoint[]> = {};
  for (const r of res.rows) {
    (out[r.provider] ??= []).push({
      capturedAt: r.captured_at.toISOString(),
      sessionPct: r.session_pct,
      weeklyPct: r.weekly_pct,
    });
  }
  return out;
}

export async function historyCsv(accountId: string, hours: number): Promise<string> {
  const res = await query<SnapshotRow>(
    `SELECT provider, session_pct, weekly_pct, session_reset_at, weekly_reset_at, captured_at
       FROM usage_snapshots
      WHERE account_id = $1 AND captured_at > now() - ($2 || ' hours')::interval
      ORDER BY captured_at ASC`,
    [accountId, String(hours)],
  );
  const lines = ['captured_at,provider,session_pct,weekly_pct,session_reset_at,weekly_reset_at'];
  for (const r of res.rows) {
    lines.push(
      [
        r.captured_at.toISOString(),
        r.provider,
        r.session_pct ?? '',
        r.weekly_pct ?? '',
        r.session_reset_at?.toISOString() ?? '',
        r.weekly_reset_at?.toISOString() ?? '',
      ].join(','),
    );
  }
  return lines.join('\n');
}

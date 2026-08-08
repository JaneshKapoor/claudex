import { query } from './db.js';
import { decryptSecret } from './crypto.js';
import { acquireLock, cacheDel, cacheSet, usageCacheKey } from './redis.js';
import { env } from './env.js';
import { log } from './log.js';
import { safeFetchUsage } from '../providers/index.js';
import { buildUsageFromDb, recordSnapshot } from './usage.js';
import type { Provider } from './types.js';

interface PollableLink {
  account_id: string;
  provider: Provider;
  encrypted_token: string;
}

/** Links we are willing to hit. `needs_repair` links are deliberately excluded. */
async function selectPollableLinks(accountId?: string): Promise<PollableLink[]> {
  const res = await query<PollableLink>(
    `SELECT account_id, provider, encrypted_token
       FROM provider_links
      WHERE status <> 'needs_repair'
        AND ($1::uuid IS NULL OR account_id = $1)
      ORDER BY COALESCE(last_fetched_at, 'epoch'::timestamptz) ASC`,
    [accountId ?? null],
  );
  return res.rows;
}

async function markOk(accountId: string, provider: Provider): Promise<void> {
  await query(
    `UPDATE provider_links
        SET status = 'ok', last_error = NULL, last_error_kind = NULL,
            consecutive_failures = 0, last_fetched_at = now(), updated_at = now()
      WHERE account_id = $1 AND provider = $2`,
    [accountId, provider],
  );
}

async function markNeedsRepair(accountId: string, provider: Provider, detail: string): Promise<void> {
  await query(
    `UPDATE provider_links
        SET status = 'needs_repair', last_error = $3, last_error_kind = 'auth', updated_at = now()
      WHERE account_id = $1 AND provider = $2`,
    [accountId, provider, detail.slice(0, 500)],
  );
}

async function markFetchFailure(accountId: string, provider: Provider, detail: string): Promise<void> {
  await query(
    `UPDATE provider_links
        SET last_error = $3, last_error_kind = 'fetch',
            consecutive_failures = consecutive_failures + 1, updated_at = now()
      WHERE account_id = $1 AND provider = $2`,
    [accountId, provider, detail.slice(0, 500)],
  );
}

export interface PollOutcome {
  accountId: string;
  provider: Provider;
  result: 'ok' | 'needs_repair' | 'fetch_failed' | 'skipped_locked';
}

async function pollLink(link: PollableLink): Promise<PollOutcome> {
  const lockKey = `claudex:lock:${link.account_id}:${link.provider}`;
  const release = await acquireLock(lockKey, 120);
  if (!release) {
    return { accountId: link.account_id, provider: link.provider, result: 'skipped_locked' };
  }

  try {
    let token: string;
    try {
      token = decryptSecret(link.encrypted_token);
    } catch (err) {
      // Almost always means CLAUDEX_ENCRYPTION_KEY was rotated without re-pairing.
      await markNeedsRepair(link.account_id, link.provider, 'stored token could not be decrypted');
      log.error(
        { kind: 'token_decrypt_failure', provider: link.provider, accountId: link.account_id, err: (err as Error).message },
        'token decryption failed — encryption key may have changed',
      );
      return { accountId: link.account_id, provider: link.provider, result: 'needs_repair' };
    }

    const result = await safeFetchUsage(link.provider, token, { accountId: link.account_id });

    if (result.ok) {
      await recordSnapshot(link.account_id, link.provider, result.usage);
      await markOk(link.account_id, link.provider);
      return { accountId: link.account_id, provider: link.provider, result: 'ok' };
    }

    if (result.kind === 'auth') {
      // Stop polling this link entirely until the user re-pairs.
      await markNeedsRepair(link.account_id, link.provider, result.detail);
      return { accountId: link.account_id, provider: link.provider, result: 'needs_repair' };
    }

    await markFetchFailure(link.account_id, link.provider, result.detail);
    return { accountId: link.account_id, provider: link.provider, result: 'fetch_failed' };
  } finally {
    await release();
  }
}

/** Refreshes the read cache for an account after its links change. */
export async function refreshCache(accountId: string): Promise<void> {
  try {
    const rows = await buildUsageFromDb(accountId);
    await cacheSet(usageCacheKey(accountId), rows, env.cacheTtlSeconds);
  } catch {
    await cacheDel(usageCacheKey(accountId));
  }
}

/**
 * One poll pass. Providers are polled with limited concurrency and each is fully
 * isolated — one failing provider never aborts the pass.
 */
export async function runPollCycle(accountId?: string, concurrency = 4): Promise<PollOutcome[]> {
  const links = await selectPollableLinks(accountId);
  if (links.length === 0) {
    log.info({ scope: accountId ?? 'all' }, 'poll cycle: nothing to poll');
    return [];
  }

  const outcomes: PollOutcome[] = [];
  const touched = new Set<string>();
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < links.length) {
      const link = links[cursor++]!;
      const outcome = await pollLink(link).catch((err) => ({
        accountId: link.account_id,
        provider: link.provider,
        result: 'fetch_failed' as const,
        err,
      }));
      outcomes.push(outcome);
      touched.add(link.account_id);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, links.length) }, worker));
  for (const id of touched) await refreshCache(id);

  const summary = outcomes.reduce<Record<string, number>>((acc, o) => {
    acc[o.result] = (acc[o.result] ?? 0) + 1;
    return acc;
  }, {});
  log.info({ scope: accountId ?? 'all', total: outcomes.length, ...summary }, 'poll cycle complete');
  return outcomes;
}

import { Redis } from 'ioredis';
import { env } from './env.js';
import { log } from './log.js';

export const redis = new Redis(env.redisUrl, {
  maxRetriesPerRequest: 2,
  enableOfflineQueue: true,
  lazyConnect: false,
  retryStrategy: (times: number) => Math.min(times * 500, 5000),
});

redis.on('error', (err: Error) => {
  // The cache is never on the critical path — a Redis outage degrades latency, not correctness.
  log.warn({ err: err.message }, 'redis error');
});

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch {
    /* cache writes are best-effort */
  }
}

export async function cacheDel(key: string): Promise<void> {
  try {
    await redis.del(key);
  } catch {
    /* ignore */
  }
}

/**
 * Poller lock, so two worker replicas (or a manual refresh) never race on the
 * same account/provider pair. Returns a release function, or null if not acquired.
 */
export async function acquireLock(key: string, ttlSeconds: number): Promise<(() => Promise<void>) | null> {
  const token = Math.random().toString(36).slice(2);
  try {
    const ok = await redis.set(key, token, 'EX', ttlSeconds, 'NX');
    if (ok !== 'OK') return null;
    return async () => {
      // Only release if we still hold it.
      const current = await redis.get(key).catch(() => null);
      if (current === token) await redis.del(key).catch(() => undefined);
    };
  } catch {
    // If Redis is down we would rather poll than stall entirely.
    return async () => undefined;
  }
}

export function usageCacheKey(accountId: string): string {
  return `claudex:usage:${accountId}`;
}

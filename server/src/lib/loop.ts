import { env } from './env.js';
import { log } from './log.js';
import { runPollCycle } from './poller.js';
import { acquireLock } from './redis.js';

const GLOBAL_LOCK = 'claudex:lock:poll-cycle';

/**
 * Long-lived poll loop. A Redis lock across the whole cycle means a second worker
 * replica (or an API running with RUN_WORKER_IN_API=1) skips instead of racing.
 */
export function startPollLoop(): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  async function tick(): Promise<void> {
    if (stopped) return;
    const release = await acquireLock(GLOBAL_LOCK, Math.ceil(env.pollIntervalMs / 1000));
    if (!release) {
      log.info('another poller holds the cycle lock, skipping this tick');
    } else {
      try {
        await runPollCycle();
      } catch (err) {
        // A whole cycle failing must not kill the loop.
        log.error({ err: (err as Error).message }, 'poll cycle threw');
      } finally {
        await release();
      }
    }
    if (!stopped) timer = setTimeout(() => void tick(), env.pollIntervalMs);
  }

  // First pass shortly after boot so a fresh deploy has data quickly.
  timer = setTimeout(() => void tick(), 5_000);
  log.info({ intervalMinutes: Math.round(env.pollIntervalMs / 60000) }, 'poll loop started');

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

import { createServer } from 'node:http';
import { env } from './lib/env.js';
import { log } from './lib/log.js';
import { pool, waitForDatabase } from './lib/db.js';
import { redis } from './lib/redis.js';
import { startPollLoop } from './lib/loop.js';

/**
 * The background poller, deployed as its own Zerops service off the same build.
 * It shares Postgres and Redis with the API but nothing else — if it dies, reads
 * keep working from cache and the last stored snapshots.
 */
async function main(): Promise<void> {
  log.info('claudex worker starting');
  await waitForDatabase();

  const stop = startPollLoop();

  // Zerops health-checks over HTTP, so expose a tiny liveness endpoint.
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'claudex-worker', time: new Date().toISOString() }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(env.port, env.host, () => log.info({ port: env.port }, 'worker health endpoint listening'));

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      log.info({ sig }, 'worker shutting down');
      stop();
      server.close();
      void pool.end().catch(() => undefined);
      redis.disconnect();
      setTimeout(() => process.exit(0), 500);
    });
  }
}

main().catch((err) => {
  log.error({ err: (err as Error).message, stack: (err as Error).stack }, 'worker failed to start');
  process.exit(1);
});

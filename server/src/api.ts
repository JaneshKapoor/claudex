import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { env } from './lib/env.js';
import { log } from './lib/log.js';
import { pool, runMigrations, waitForDatabase } from './lib/db.js';
import { redis } from './lib/redis.js';
import { registerV1 } from './routes/v1.js';
import { startPollLoop } from './lib/loop.js';

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 1024 * 256,
  });

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-claudex-device'],
    exposedHeaders: ['x-claudex-export-url'],
  });

  // Pairing is the one endpoint worth throttling hard — it mints accounts.
  await app.register(rateLimit, {
    global: false,
    max: 30,
    timeWindow: '1 minute',
  });

  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/v1/')) {
      log.debug({ method: req.method, url: req.url }, 'request');
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    log.error({ err: err.message, url: req.url, stack: err.stack }, 'request failed');
    void reply.code(err.statusCode && err.statusCode >= 400 ? err.statusCode : 500).send({
      error: 'internal_error',
      detail: env.isDev ? err.message : 'something went wrong on our side',
    });
  });

  /** Liveness — deliberately dependency-free so Zerops never restarts a healthy pod. */
  app.get('/health', async () => ({ status: 'ok', service: 'claudex-api', time: new Date().toISOString() }));

  /** Readiness — reports dependency state without failing the request. */
  app.get('/v1/health', async () => {
    const db = await pool
      .query('SELECT 1')
      .then(() => 'ok' as const)
      .catch(() => 'down' as const);
    const cache = await redis
      .ping()
      .then(() => 'ok' as const)
      .catch(() => 'down' as const);
    return {
      status: db === 'ok' ? 'ok' : 'degraded',
      service: 'claudex-api',
      version: '1.0.0',
      dependencies: { postgres: db, redis: cache, objectStorage: env.s3 ? 'configured' : 'not_configured' },
      time: new Date().toISOString(),
    };
  });

  await registerV1(app);

  // The dashboard is its own Zerops service, but the API also serves a copy so a
  // single URL is always enough to demo the whole thing.
  const dashboardDir = resolve(here, '../../dashboard');
  if (existsSync(dashboardDir)) {
    await app.register(fastifyStatic, { root: dashboardDir, prefix: '/' });
    log.info({ dashboardDir }, 'serving bundled dashboard at /');
  }

  log.info('waiting for postgres…');
  await waitForDatabase();
  await runMigrations();

  if (env.runWorkerInApi) {
    startPollLoop();
    log.warn('RUN_WORKER_IN_API=1 — polling inside the API process');
  }

  await app.listen({ port: env.port, host: env.host });
  log.info({ port: env.port, host: env.host }, 'claudex api listening');

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      log.info({ sig }, 'shutting down');
      void app.close().then(async () => {
        await pool.end().catch(() => undefined);
        redis.disconnect();
        process.exit(0);
      });
    });
  }
}

main().catch((err) => {
  log.error({ err: (err as Error).message, stack: (err as Error).stack }, 'api failed to start');
  process.exit(1);
});

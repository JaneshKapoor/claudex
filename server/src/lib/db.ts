import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { env } from './env.js';
import { log } from './log.js';

const { Pool } = pg;

// Zerops-managed Postgres is reached over the internal network; TLS is only
// negotiated for external connections, so keep verification off for those.
const needsSsl = /sslmode=require/.test(env.databaseUrl);

export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 8,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => {
  log.error({ err }, 'idle postgres client error');
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Applies migrations/001_init.sql. The file is idempotent, so running it on every
 * boot is safe and means a brand-new Zerops Postgres service self-provisions.
 */
export async function runMigrations(): Promise<void> {
  // dist/lib/db.js -> ../../migrations, src/lib/db.ts -> ../../migrations
  const path = resolve(here, '../../migrations/001_init.sql');
  const sql = await readFile(path, 'utf8');
  await pool.query(sql);
  log.info('database schema ensured');
}

export async function waitForDatabase(attempts = 30, delayMs = 2000): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i === attempts) throw err;
      log.warn({ attempt: i, attempts }, 'postgres not ready yet, retrying');
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

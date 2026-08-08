import 'dotenv/config';

/**
 * Zerops injects service connection details as env vars named after the service
 * (e.g. `db_connectionString` for a Postgres service called `db`). We accept both
 * the Zerops-native names and generic overrides so the same build runs locally.
 */
function pick(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim() !== '') return v.trim();
  }
  return undefined;
}

function required(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(
      `Missing required configuration: ${label}. Set it as a Zerops env variable (or in server/.env locally).`,
    );
  }
  return value;
}

function buildPostgresUrl(): string {
  const direct = pick('DATABASE_URL', 'db_connectionString', 'POSTGRES_URL');
  if (direct) return direct;
  // Zerops also exposes the parts individually.
  const host = pick('db_hostname', 'PGHOST');
  const port = pick('db_port', 'PGPORT') ?? '5432';
  const user = pick('db_user', 'PGUSER');
  const password = pick('db_password', 'PGPASSWORD');
  const name = pick('db_dbName', 'PGDATABASE') ?? 'claudex';
  if (host && user && password) {
    return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${name}`;
  }
  return required(undefined, 'DATABASE_URL');
}

function buildRedisUrl(): string {
  const direct = pick('REDIS_URL', 'cache_connectionString', 'KEYDB_URL');
  if (direct) return direct;
  const host = pick('cache_hostname', 'REDIS_HOST');
  const port = pick('cache_port', 'REDIS_PORT') ?? '6379';
  const password = pick('cache_password', 'REDIS_PASSWORD');
  if (host) {
    return password
      ? `redis://:${encodeURIComponent(password)}@${host}:${port}`
      : `redis://${host}:${port}`;
  }
  return required(undefined, 'REDIS_URL');
}

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function buildS3(): S3Config | null {
  const endpoint = pick('S3_ENDPOINT', 'storage_apiUrl');
  const bucket = pick('S3_BUCKET', 'storage_bucketName');
  const accessKeyId = pick('S3_ACCESS_KEY_ID', 'storage_accessKeyId');
  const secretAccessKey = pick('S3_SECRET_ACCESS_KEY', 'storage_secretAccessKey');
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: pick('S3_REGION') ?? 'us-east-1',
  };
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'production',
  isDev: (process.env.NODE_ENV ?? 'production') !== 'production',
  port: Number(pick('PORT') ?? 3000),
  host: pick('HOST') ?? '0.0.0.0',
  logLevel: pick('LOG_LEVEL') ?? 'info',

  databaseUrl: buildPostgresUrl(),
  redisUrl: buildRedisUrl(),
  s3: buildS3(),

  /** 32-byte key, hex or base64, used for AES-256-GCM token encryption. */
  encryptionKey: required(pick('CLAUDEX_ENCRYPTION_KEY', 'ENCRYPTION_KEY'), 'CLAUDEX_ENCRYPTION_KEY'),

  /** Public base URL of the API, used to render pairing QR codes. */
  publicBaseUrl: pick('PUBLIC_BASE_URL') ?? '',
  /** Public base URL of the dashboard, used in pairing QR codes. */
  dashboardUrl: pick('DASHBOARD_URL') ?? '',

  /** Worker cadence. 20-30 min is plenty for a 5-hour window. */
  pollIntervalMs: Number(pick('POLL_INTERVAL_MS') ?? 25 * 60 * 1000),
  /** How long a cached usage payload is considered fresh for readers. */
  cacheTtlSeconds: Number(pick('CACHE_TTL_SECONDS') ?? 30 * 60),
  /** Set to "1" to let the API process also run the poll loop (single-service mode). */
  runWorkerInApi: pick('RUN_WORKER_IN_API') === '1',
} as const;

export type Env = typeof env;

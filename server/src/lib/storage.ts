import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { env } from './env.js';
import { log } from './log.js';

/**
 * Zerops object storage (S3-compatible). Used for two things:
 *   - usage history CSV exports
 *   - pairing QR code PNGs
 * Optional by design: if the bucket is not configured the API still serves both,
 * it just streams them inline instead of handing back a durable object URL.
 */

let client: S3Client | null = null;

export function storageEnabled(): boolean {
  return env.s3 !== null;
}

function getClient(): S3Client | null {
  if (!env.s3) return null;
  if (!client) {
    client = new S3Client({
      endpoint: env.s3.endpoint,
      region: env.s3.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.s3.accessKeyId,
        secretAccessKey: env.s3.secretAccessKey,
      },
    });
  }
  return client;
}

export async function putObject(
  key: string,
  body: Buffer | string,
  contentType: string,
): Promise<string | null> {
  const c = getClient();
  if (!c || !env.s3) return null;
  try {
    await c.send(
      new PutObjectCommand({
        Bucket: env.s3.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    const base = env.s3.endpoint.replace(/\/$/, '');
    return `${base}/${env.s3.bucket}/${key}`;
  } catch (err) {
    log.warn({ err: (err as Error).message, key }, 'object storage write failed');
    return null;
  }
}

import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { env } from './env.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function loadKey(): Buffer {
  const raw = env.encryptionKey.trim();

  // Preferred form: 64 hex chars.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');

  // Or base64 that decodes to exactly 32 bytes.
  const b64 = Buffer.from(raw, 'base64');
  if (b64.length === 32 && /^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return b64;

  // Zerops' <@generateRandomString(<64>)> yields a 64-char alphanumeric secret,
  // which is neither hex nor base64. Derive the key from it rather than refusing
  // to boot — still 256 bits of entropy as long as the secret is long.
  if (raw.length >= 32) return createHash('sha256').update(raw, 'utf8').digest();

  throw new Error(
    'CLAUDEX_ENCRYPTION_KEY is too short. Use 64 hex chars: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
  );
}

const key = loadKey();

/**
 * AES-256-GCM. Output layout: iv(12) | tag(16) | ciphertext, base64-encoded.
 * Provider session tokens are never written to Postgres in any other form.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptSecret(payload: string): string {
  const buf = Buffer.from(payload, 'base64');
  if (buf.length < IV_LEN + TAG_LEN) throw new Error('ciphertext too short');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Device secrets are stored as SHA-256 digests, never in the clear. */
export function hashDeviceSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Short, human-readable pairing code (no ambiguous characters). */
export function newPairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
    if (i === 3) out += '-';
  }
  return out;
}

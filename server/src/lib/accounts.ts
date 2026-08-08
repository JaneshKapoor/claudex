import { query } from './db.js';
import { encryptSecret, hashDeviceSecret, newPairingCode, newToken } from './crypto.js';
import type { Provider } from './types.js';

export interface DeviceIdentity {
  accountId: string;
  deviceId: string;
}

export interface CreatedDevice extends DeviceIdentity {
  deviceSecret: string;
}

/** Creates a fresh account plus its first device. Used by the very first pair call. */
export async function createAccountWithDevice(
  platform: string,
  label: string | null,
): Promise<CreatedDevice> {
  const account = await query<{ id: string }>(
    'INSERT INTO accounts (label) VALUES ($1) RETURNING id',
    [label],
  );
  const accountId = account.rows[0]!.id;
  const device = await addDevice(accountId, platform, label);
  return { accountId, ...device };
}

export async function addDevice(
  accountId: string,
  platform: string,
  label: string | null | undefined,
): Promise<{ deviceId: string; deviceSecret: string }> {
  const deviceSecret = newToken(32);
  const res = await query<{ id: string }>(
    'INSERT INTO devices (account_id, secret_hash, platform, label) VALUES ($1, $2, $3, $4) RETURNING id',
    [accountId, hashDeviceSecret(deviceSecret), platform, label],
  );
  return { deviceId: res.rows[0]!.id, deviceSecret };
}

/** Resolves a device secret to its account, refreshing last-seen timestamps. */
export async function authenticateDevice(secret: string): Promise<DeviceIdentity | null> {
  const res = await query<{ id: string; account_id: string }>(
    'SELECT id, account_id FROM devices WHERE secret_hash = $1',
    [hashDeviceSecret(secret)],
  );
  const row = res.rows[0];
  if (!row) return null;
  await query('UPDATE devices SET last_seen_at = now() WHERE id = $1', [row.id]);
  await query('UPDATE accounts SET last_seen_at = now() WHERE id = $1', [row.account_id]);
  return { accountId: row.account_id, deviceId: row.id };
}

export async function accountExists(accountId: string): Promise<boolean> {
  const res = await query('SELECT 1 FROM accounts WHERE id = $1', [accountId]);
  return res.rowCount === 1;
}

const PAIRING_CODE_TTL_MINUTES = 15;

export async function issuePairingCode(accountId: string): Promise<{ code: string; expiresAt: string }> {
  const code = newPairingCode();
  const res = await query<{ expires_at: Date }>(
    `INSERT INTO pairing_codes (code, account_id, expires_at)
     VALUES ($1, $2, now() + ($3 || ' minutes')::interval)
     RETURNING expires_at`,
    [code, accountId, String(PAIRING_CODE_TTL_MINUTES)],
  );
  return { code, expiresAt: res.rows[0]!.expires_at.toISOString() };
}

/** Redeems a pairing code, attaching a new device to the existing account. */
export async function redeemPairingCode(
  code: string,
  platform: string,
  label: string | null,
): Promise<CreatedDevice | null> {
  const res = await query<{ account_id: string }>(
    `UPDATE pairing_codes SET consumed_at = now()
     WHERE code = $1 AND consumed_at IS NULL AND expires_at > now()
     RETURNING account_id`,
    [code.trim().toUpperCase()],
  );
  const row = res.rows[0];
  if (!row) return null;
  const device = await addDevice(row.account_id, platform, label);
  return { accountId: row.account_id, ...device };
}

/**
 * Stores (or replaces) a provider session token for an account. Tokens are
 * AES-256-GCM encrypted here and never written in plaintext.
 */
export async function upsertProviderLink(
  accountId: string,
  provider: Provider,
  token: string,
  tokenKind = 'session',
): Promise<void> {
  await query(
    `INSERT INTO provider_links (account_id, provider, encrypted_token, token_kind, status, last_error, last_error_kind, consecutive_failures, updated_at)
     VALUES ($1, $2, $3, $4, 'pending', NULL, NULL, 0, now())
     ON CONFLICT (account_id, provider) DO UPDATE
       SET encrypted_token = EXCLUDED.encrypted_token,
           token_kind = EXCLUDED.token_kind,
           status = 'pending',
           last_error = NULL,
           last_error_kind = NULL,
           consecutive_failures = 0,
           updated_at = now()`,
    [accountId, provider, encryptSecret(token), tokenKind],
  );
}

export async function deleteProviderLink(accountId: string, provider: Provider): Promise<boolean> {
  const res = await query('DELETE FROM provider_links WHERE account_id = $1 AND provider = $2', [
    accountId,
    provider,
  ]);
  return (res.rowCount ?? 0) > 0;
}

-- Claudex initial schema.
-- Written to be idempotent: it is applied on every API boot so a fresh Zerops
-- Postgres service becomes usable without a manual migration step.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS accounts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per paired device (phone, browser). Secrets are stored as SHA-256 digests.
CREATE TABLE IF NOT EXISTS devices (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  secret_hash  TEXT NOT NULL,
  platform     TEXT NOT NULL DEFAULT 'unknown',
  label        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS devices_account_idx ON devices (account_id);
CREATE UNIQUE INDEX IF NOT EXISTS devices_secret_hash_idx ON devices (secret_hash);

-- Short-lived codes that let a second device (or the dashboard) join an existing account.
CREATE TABLE IF NOT EXISTS pairing_codes (
  code        TEXT PRIMARY KEY,
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pairing_codes_account_idx ON pairing_codes (account_id);

-- One row per (account, provider). `encrypted_token` is AES-256-GCM ciphertext.
CREATE TABLE IF NOT EXISTS provider_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,
  encrypted_token TEXT NOT NULL,
  token_kind      TEXT NOT NULL DEFAULT 'session',
  status          TEXT NOT NULL DEFAULT 'ok',
  last_error      TEXT,
  last_error_kind TEXT,
  last_fetched_at TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT provider_links_provider_chk CHECK (provider IN ('claude', 'chatgpt', 'codex')),
  CONSTRAINT provider_links_status_chk CHECK (status IN ('ok', 'needs_repair', 'pending'))
);
CREATE UNIQUE INDEX IF NOT EXISTS provider_links_account_provider_idx
  ON provider_links (account_id, provider);

-- Append-only history, powers the trend line and the CSV export.
CREATE TABLE IF NOT EXISTS usage_snapshots (
  id               BIGSERIAL PRIMARY KEY,
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL,
  session_pct      DOUBLE PRECISION,
  weekly_pct       DOUBLE PRECISION,
  session_reset_at TIMESTAMPTZ,
  weekly_reset_at  TIMESTAMPTZ,
  source           TEXT NOT NULL DEFAULT 'poller',
  raw              JSONB,
  captured_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_snapshots_lookup_idx
  ON usage_snapshots (account_id, provider, captured_at DESC);

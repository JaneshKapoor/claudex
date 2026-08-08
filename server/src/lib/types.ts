export const PROVIDERS = ['claude', 'chatgpt', 'codex'] as const;
export type Provider = (typeof PROVIDERS)[number];

export function isProvider(v: string): v is Provider {
  return (PROVIDERS as readonly string[]).includes(v);
}

export type LinkStatus = 'ok' | 'needs_repair' | 'pending';

/** Normalised shape every provider module must produce. */
export interface ProviderUsage {
  /** 0-100, or null when the provider does not expose that window. */
  sessionPct: number | null;
  weeklyPct: number | null;
  /** ISO-8601 instants, or null when unknown. */
  sessionResetAt: string | null;
  weeklyResetAt: string | null;
  /** Untouched provider payload, kept for debugging when an endpoint shifts. */
  raw?: unknown;
}

export type ProviderFetchResult =
  | { ok: true; usage: ProviderUsage }
  /** Credentials rejected (401/403). The link is marked needs_repair and polling stops. */
  | { ok: false; kind: 'auth'; status: number; detail: string }
  /** Anything else: endpoint moved, shape changed, network failure, rate limit. */
  | { ok: false; kind: 'fetch'; status?: number; detail: string };

export interface ProviderModule {
  id: Provider;
  displayName: string;
  /** Human hint shown in the app when a link needs re-pairing. */
  repairHint: string;
  fetchUsage(token: string, ctx: { accountId: string }): Promise<ProviderFetchResult>;
}

export interface UsageRow {
  provider: Provider;
  sessionPct: number | null;
  weeklyPct: number | null;
  sessionResetAt: string | null;
  weeklyResetAt: string | null;
  lastFetchedAt: string | null;
  status: LinkStatus;
  displayName: string;
  message?: string;
}

export function clampPct(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

/**
 * Providers variously report 0-1 fractions or 0-100 percentages under the same
 * key names, so this has to be disambiguated by value.
 *
 * Only values strictly between 0 and 1 can be fractions — anything at 1 or above
 * is already a percentage. The earlier rule (`n <= 1` means fraction) turned
 * claude.ai's "1" (one percent) into 100%, which read as a maxed-out weekly cap
 * when barely any of it had been used.
 *
 * The residual ambiguity is a true fraction of exactly 1.0 (i.e. 100%), which is
 * indistinguishable from 1%. No provider observed so far reports full usage that
 * way, and under-reporting there is caught by the next reading.
 */
export function fractionToPct(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return clampPct(n > 0 && n < 1 ? n * 100 : n);
}

export function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'number') {
    // Heuristic: values below 1e12 are second-precision epochs.
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

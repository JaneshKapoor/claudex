// UNOFFICIAL — reverse-engineered, may break without notice
//
// Shared, deliberately forgiving parsing helpers for provider usage payloads.
//
// None of these providers documents its usage response, and all three have
// reshaped it before. Rather than binding to one exact JSON path, we walk the
// payload looking for objects that *look like* a rate-limit window (a percentage
// plus a reset hint) and classify them into "session" (the ~5 hour cap) and
// "weekly" (the 7 day cap) by their window length or key name.
//
// The upside: a renamed wrapper key does not take the fetch down. The downside:
// if a provider starts reporting a genuinely different window, verify against
// DevTools before trusting the number. See docs/REVERSE-ENGINEERING.md.

import { clampPct, fractionToPct, toIso, type ProviderUsage } from '../lib/types.js';

type Json = Record<string, unknown>;

const PCT_KEYS = [
  'used_percent',
  'usedPercent',
  'utilization',
  'percent_used',
  'percentUsed',
  'percent',
  'usage_percent',
  'usagePercent',
  'used_pct',
];

const RESET_AT_KEYS = ['resets_at', 'resetsAt', 'reset_at', 'resetAt', 'resets_at_utc', 'expires_at'];
const RESET_IN_KEYS = [
  'resets_in_seconds',
  'resetsInSeconds',
  'seconds_until_reset',
  'reset_in_seconds',
  'resets_in',
];
const WINDOW_MIN_KEYS = ['window_minutes', 'windowMinutes', 'window_size_minutes'];
const WINDOW_SEC_KEYS = ['window_seconds', 'windowSeconds'];

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function firstKey(obj: Json, keys: string[]): unknown {
  for (const k of keys) {
    if (k in obj && obj[k] != null) return obj[k];
  }
  return undefined;
}

export interface Window {
  pct: number;
  resetAt: string | null;
  /** Length of the window in minutes when the provider tells us. */
  windowMinutes: number | null;
  /** The key path this was found at — used to classify and to debug drift. */
  path: string;
}

/** Recursively collect every object in the payload that looks like a usage window. */
export function collectWindows(payload: unknown, path = '$', depth = 0, out: Window[] = []): Window[] {
  if (depth > 8) return out;
  if (Array.isArray(payload)) {
    payload.forEach((item, i) => collectWindows(item, `${path}[${i}]`, depth + 1, out));
    return out;
  }
  if (!isObject(payload)) return out;

  const rawPct = firstKey(payload, PCT_KEYS);
  if (rawPct !== undefined) {
    // `utilization` is usually a 0-1 fraction; the *_percent keys are 0-100.
    const isFractionKey = 'utilization' in payload && firstKey(payload, PCT_KEYS) === payload['utilization'];
    const pct = isFractionKey ? fractionToPct(rawPct) : clampPct(rawPct);
    if (pct !== null) {
      let resetAt = toIso(firstKey(payload, RESET_AT_KEYS));
      if (!resetAt) {
        const inSec = firstKey(payload, RESET_IN_KEYS);
        const n = typeof inSec === 'string' ? Number(inSec) : inSec;
        if (typeof n === 'number' && Number.isFinite(n) && n >= 0) {
          resetAt = new Date(Date.now() + n * 1000).toISOString();
        }
      }
      const wm = firstKey(payload, WINDOW_MIN_KEYS);
      const ws = firstKey(payload, WINDOW_SEC_KEYS);
      const windowMinutes =
        typeof wm === 'number' ? wm : typeof ws === 'number' ? Math.round(ws / 60) : null;
      out.push({ pct, resetAt, windowMinutes, path });
    }
  }

  for (const [k, v] of Object.entries(payload)) {
    collectWindows(v, `${path}.${k}`, depth + 1, out);
  }
  return out;
}

const SESSION_HINTS = /(primary|session|five_?hour|5_?hour|short|hourly|current)/i;
const WEEKLY_HINTS = /(secondary|weekly|week|seven_?day|7_?day|long)/i;

/** Sort windows into the two buckets the widget renders. */
export function classifyWindows(windows: Window[]): {
  session: Window | null;
  weekly: Window | null;
} {
  let session: Window | null = null;
  let weekly: Window | null = null;

  for (const w of windows) {
    // Window length is the most reliable signal when the provider gives it:
    // anything up to ~24h is the session cap, longer is the weekly cap.
    const byLength = w.windowMinutes != null ? (w.windowMinutes <= 24 * 60 ? 'session' : 'weekly') : null;
    const byName = WEEKLY_HINTS.test(w.path) ? 'weekly' : SESSION_HINTS.test(w.path) ? 'session' : null;
    const bucket = byLength ?? byName;

    if (bucket === 'weekly') {
      if (!weekly) weekly = w;
    } else if (bucket === 'session') {
      if (!session) session = w;
    }
  }

  // Fall back to positional order: providers list the short window first.
  if (!session && !weekly && windows.length > 0) {
    session = windows[0] ?? null;
    weekly = windows[1] ?? null;
  } else if (!session && windows.length > 0) {
    session = windows.find((w) => w !== weekly) ?? null;
  } else if (!weekly && windows.length > 1) {
    weekly = windows.find((w) => w !== session) ?? null;
  }

  return { session, weekly };
}

/** Full pipeline: payload in, normalised usage out. Returns null if nothing usable was found. */
export function usageFromPayload(payload: unknown): ProviderUsage | null {
  const windows = collectWindows(payload);
  if (windows.length === 0) return null;
  const { session, weekly } = classifyWindows(windows);
  if (!session && !weekly) return null;
  return {
    sessionPct: session?.pct ?? null,
    weeklyPct: weekly?.pct ?? null,
    sessionResetAt: session?.resetAt ?? null,
    weeklyResetAt: weekly?.resetAt ?? null,
    raw: payload,
  };
}

/**
 * Several of these endpoints also mirror the limits into response headers
 * (the Codex CLI reads them this way). Header form:
 *   x-codex-primary-used-percent / x-codex-primary-reset-after-seconds
 */
export function usageFromHeaders(headers: Record<string, string | string[] | undefined>): ProviderUsage | null {
  const get = (name: string): string | undefined => {
    const v = headers[name] ?? headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  const build = (prefix: string): Window | null => {
    const pct = clampPct(get(`x-codex-${prefix}-used-percent`));
    if (pct === null) return null;
    const after = Number(get(`x-codex-${prefix}-reset-after-seconds`));
    const resetAt = Number.isFinite(after) ? new Date(Date.now() + after * 1000).toISOString() : null;
    const wm = Number(get(`x-codex-${prefix}-window-minutes`));
    return { pct, resetAt, windowMinutes: Number.isFinite(wm) ? wm : null, path: `$.${prefix}` };
  };
  const primary = build('primary');
  const secondary = build('secondary');
  if (!primary && !secondary) return null;
  return {
    sessionPct: primary?.pct ?? null,
    weeklyPct: secondary?.pct ?? null,
    sessionResetAt: primary?.resetAt ?? null,
    weeklyResetAt: secondary?.resetAt ?? null,
    raw: { source: 'headers' },
  };
}

import pino from 'pino';
import { env } from './env.js';

export const log = pino({
  level: env.logLevel,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * The brief requires fetch failures and auth failures to be distinguishable in logs,
 * so an endpoint change never looks like an expired token. These two helpers are the
 * only sanctioned way to report a provider problem.
 */
export function logAuthFailure(fields: {
  provider: string;
  accountId: string;
  status: number;
  detail?: string;
}): void {
  log.warn({ kind: 'provider_auth_failure', ...fields }, 'provider rejected our credentials — link needs re-pair');
}

export function logFetchFailure(fields: {
  provider: string;
  accountId: string;
  status?: number;
  detail?: string;
}): void {
  log.error({ kind: 'provider_fetch_failure', ...fields }, 'provider fetch failed — endpoint may have changed');
}

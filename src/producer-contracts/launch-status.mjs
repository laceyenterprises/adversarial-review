import { readFileSync } from 'node:fs';

// Generated from the dependency-free session-ledger owner, never from fixtures.
const vocabulary = JSON.parse(readFileSync(new URL('./launch-request-statuses.json', import.meta.url)));
export const LAUNCH_REQUEST_STATUSES = new Set(vocabulary.statuses);
export const TERMINAL_LAUNCH_REQUEST_STATUSES = new Set(vocabulary.terminal);

/**
 * @param {unknown} value
 * @returns {{status: string|null, terminal: boolean, succeeded: boolean, blockedNeedsDecision: boolean, diagnostic: string|null}}
 * Terminality supplies no publication, retry or process-exit authority.
 */
export function readLaunchRequestStatus(value) {
  const known = typeof value === 'string' && LAUNCH_REQUEST_STATUSES.has(value);
  return {
    status: known ? value : null,
    terminal: known && TERMINAL_LAUNCH_REQUEST_STATUSES.has(value),
    succeeded: value === 'succeeded',
    blockedNeedsDecision: value === 'blocked_needs_decision',
    diagnostic: known ? null : `session_ledger: launch_requests.status ${value == null ? 'missing' : `unrecognized value ${JSON.stringify(value)}`}`,
  };
}

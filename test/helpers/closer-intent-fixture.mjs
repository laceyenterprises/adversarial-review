import assert from 'node:assert/strict';
import { acquireAmaCloserLease, readAmaCloserLease, rekeyAmaCloserLease } from '../../src/ama/closer-lease.mjs';
import { readAmaCloserDispatchRecord, updateAmaCloserDispatchRecord } from '../../src/ama/dispatch-closer.mjs';

export const intentStarted = '2026-01-01T00:00:00Z';
export const intentExpired = '2026-01-01T01:00:00Z';
export const intentEarly = '2026-01-01T00:00:30Z';
export const intentDead = () => { throw Object.assign(Error('synthetic absent PID'), { code: 'ESRCH' }); };

export function seedCloserIntent(rootDir, identity, { rekeyedHead, scenario = 'absent' } = {}) {
  const key = 'synthetic-closer-attempt';
  updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity,
    state: 'dispatching', dispatchPhase: 'submitting', dispatchIdempotencyKey: key,
    lastAttemptedAt: intentStarted, dispatchTimeoutMs: 120_000, retryCount: 2,
    workerClass: 'hammer', targetRemediationSha: identity.headSha,
    ...(scenario === 'live-child' ? { dispatchSubmitter: { pid: 424243, startedAt: intentStarted } } : {}),
  }));
  assert.equal(acquireAmaCloserLease({ rootDir, ...identity, watcherPid: 424242,
    now: intentStarted, dispatchTimeoutMs: 120_000 }).acquired, true);
  if (rekeyedHead) assert.equal(rekeyAmaCloserLease({ rootDir, ...identity,
    fromHeadSha: identity.headSha, toHeadSha: rekeyedHead, now: intentEarly }).rekeyed, true);
  const currentIdentity = { ...identity, headSha: rekeyedHead || identity.headSha };
  const receipt = { launch_request_id: 'lrq_synthetic_closer', idempotency_key: key,
    ticket_ref: `AMA-PR-${identity.prNumber}`, target_repo: identity.repo,
    head_sha: identity.headSha, requested_at: intentStarted, status: 'running' };
  let reads = 0;
  const options = {
    readPullRequestStateImpl: async () => ({ state: 'OPEN' }),
    readIntentReceiptImpl: async () => {
      reads++;
      if (scenario === 'unreadable') return { ok: false, reason: 'synthetic-unreadable' };
      return { ok: true, rows: scenario === 'receipt' ? [receipt]
        : scenario === 'ambiguous' ? [receipt, { ...receipt, launch_request_id: 'lrq_synthetic_other' }] : [] };
    },
    readLegacyIntentLaunchesImpl: async () => { throw Error('keyed automatic recovery uses existing key rules'); },
    captureProcessImpl: () => ({ startedAt: intentStarted }),
    processKillImpl: scenario === 'live' ? () => {} : intentDead,
    processExecFileSyncImpl: () => {
      if (scenario === 'early-absent') return '515151 Thu Jan  1 00:00:00 2026 synthetic-worker\n';
      if (scenario === 'live-child') return '424243 Thu Jan  1 00:00:00 2026 synthetic-submitter\n';
      throw Error('synthetic process table unreadable');
    },
    deliverAlertImpl: async () => {},
  };
  return { options, currentIdentity, receipt, reads: () => reads,
    lease: () => readAmaCloserLease(rootDir, currentIdentity),
    record: () => readAmaCloserDispatchRecord(rootDir, identity) };
}

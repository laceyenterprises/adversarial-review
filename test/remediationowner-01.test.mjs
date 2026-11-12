// REMEDIATIONOWNER-01: a follow-up remediation job never starts on a PR whose
// branch a live HQ launch already owns. Synthetic repos, PRs and launch ids.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  claimNextFollowUpJob,
  createFollowUpJob,
  getFollowUpJobDir,
  readFollowUpJob,
} from '../src/follow-up-jobs.mjs';
import { consumeNextFollowUpJob } from '../src/follow-up-remediation.mjs';
import {
  LIVE_PR_OWNER_DEFERRED,
  LIVE_PR_OWNER_LOOKUPS_PER_CLAIM,
  LIVE_PR_OWNER_UNKNOWN,
  claimWithLivePrOwnerGate,
  createLivePrOwnerLookup,
  parseLivePrOwnerReply,
} from '../src/remediation-live-pr-owner.mjs';

const REPO = 'example-org/sample-service';
const CLAIMED_AT = '2026-04-21T10:00:00.000Z';
const quiet = { log() {}, warn() {}, error() {}, info() {} };

function tempRoot(t) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'remediationowner-01-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

function pendingJob(rootDir, prNumber, extra = {}) {
  return createFollowUpJob({
    rootDir,
    repo: REPO,
    prNumber,
    branch: `synthetic/pr-${prNumber}`,
    reviewerModel: 'claude',
    linearTicketId: null,
    reviewBody: '## Summary\nSynthetic finding.\n\n## Blocking issues\n- Fix the synthetic bug.\n\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-04-21T08:00:00.000Z',
    critical: true,
    ...extra,
  });
}

const liveUpdate = (launchRequestId = 'lrq_synthetic_update') => ({
  state: 'owned',
  owner: { launchRequestId, workerClass: 'claude-code', launchStatus: 'running', kind: 'pr-update' },
});

function claimOnce(rootDir, lookupImpl, { delayedPendingPaths = new Set(), observedAt = CLAIMED_AT } = {}) {
  return claimWithLivePrOwnerGate({
    lookupImpl, observedAt, log: quiet,
    claim: (claimedAt, livePrOwnerDecision) => claimNextFollowUpJob({
      rootDir, claimedAt, returnStopped: true, delayedPendingPaths, livePrOwnerDecision,
    }),
  });
}

test('parseLivePrOwnerReply reads free, owned and refusal replies; malformed is unknown', () => {
  assert.deepEqual(parseLivePrOwnerReply('{"ok":true,"owner":null}\n'), { state: 'free' });
  assert.deepEqual(parseLivePrOwnerReply('noise\n{"ok":true,"owner":{"launchRequestId":"lrq_a1","workerClass":"hammer","status":"leased","kind":"closer"}}'), {
    state: 'owned',
    owner: { launchRequestId: 'lrq_a1', workerClass: 'hammer', launchStatus: 'leased', kind: 'closer' },
  });
  assert.deepEqual(parseLivePrOwnerReply('{"ok":false,"reason":"ledger-unavailable"}'),
    { state: 'unknown', reason: 'ledger-unavailable' });
  assert.equal(parseLivePrOwnerReply('').state, 'unknown');
  assert.equal(parseLivePrOwnerReply('{"ok":true}').state, 'unknown', 'a missing owner field is not absence');
  assert.equal(parseLivePrOwnerReply('{"ok":true,"owner":{"launchRequestId":"../x"}}').state, 'unknown');
});

test('createLivePrOwnerLookup asks hq merge-agent pr-owner and treats failures and timeouts as unknown', async () => {
  const calls = [];
  const env = { HQ_BIN: '/synthetic/bin/hq', HQ_ROOT: '/synthetic/hq-root' };
  const ok = createLivePrOwnerLookup({ env, timeoutMs: 1000, execFileImpl: async (bin, args) => {
    calls.push([bin, args]);
    return { stdout: '{"ok":true,"owner":null}\n' };
  } });
  assert.deepEqual(await ok({ repo: REPO, prNumber: 4101 }), { state: 'free' });
  assert.deepEqual(calls, [['/synthetic/bin/hq',
    ['merge-agent', 'pr-owner', '--repo', REPO, '--pr', '4101', '--json', '--root', '/synthetic/hq-root']]]);

  const timedOut = createLivePrOwnerLookup({ env, timeoutMs: 1000, execFileImpl: async () => {
    throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
  } });
  assert.equal((await timedOut({ repo: REPO, prNumber: 4101 })).reason, 'lookup-timeout');

  const refused = createLivePrOwnerLookup({ env, timeoutMs: 1000, execFileImpl: async () => {
    throw Object.assign(new Error('exit 75'), { code: 75, stdout: '{"ok":false,"reason":"ledger-unavailable"}\n' });
  } });
  assert.deepEqual(await refused({ repo: REPO, prNumber: 4101 }), { state: 'unknown', reason: 'ledger-unavailable' });

  const missing = createLivePrOwnerLookup({ env, timeoutMs: 1000, execFileImpl: async () => {
    throw Object.assign(new Error('spawn hq ENOENT'), { code: 'ENOENT' });
  } });
  assert.equal((await missing({ repo: REPO, prNumber: 4101 })).reason, 'lookup-failed');

  // Any other usage failure stays unknown; only the exact unknown-subcommand
  // reply from an older HQ CLI is the companion-deploy seam.
  const usage = createLivePrOwnerLookup({ env, timeoutMs: 1000, log: quiet, execFileImpl: async () => {
    throw Object.assign(new Error('exit 64'), { code: 64, stdout: '', stderr: '[hq] error: --repo must be owner/name' });
  } });
  assert.equal((await usage({ repo: REPO, prNumber: 4101 })).state, 'unknown');
});

test('an HQ CLI without the pr-owner subcommand keeps the previous claim behavior and warns', async (t) => {
  const warnings = [];
  const lookup = createLivePrOwnerLookup({
    env: { HQ_BIN: '/synthetic/bin/hq' }, timeoutMs: 1000,
    log: { ...quiet, warn: message => warnings.push(message) },
    execFileImpl: async () => { throw Object.assign(new Error('exit 64'), { code: 64, stdout: '',
      stderr: 'Usage: hq merge-agent rescue <PR#> [options]\n[hq] error: unknown merge-agent subcommand: pr-owner\n' }); },
  });
  assert.deepEqual(await lookup({ repo: REPO, prNumber: 4112 }), { state: 'unsupported' });
  assert.equal(warnings.length, 1);

  const rootDir = tempRoot(t);
  const { job } = pendingJob(rootDir, 4112);
  const claimed = await claimOnce(rootDir, lookup);
  assert.equal(claimed.job.jobId, job.jobId);
  assert.equal(claimed.job.livePrOwnerDeferral, undefined);
});

test('a live PR-update owner defers the remediation job before claim and names the owning launch', async (t) => {
  const rootDir = tempRoot(t);
  const { jobPath } = pendingJob(rootDir, 4101);
  const delayedPendingPaths = new Set();
  const asked = [];
  const claimed = await claimOnce(rootDir, async (args) => { asked.push(args); return liveUpdate(); },
    { delayedPendingPaths });

  assert.equal(claimed, null, 'no job is claimed while the PR has a live owner');
  assert.deepEqual(asked, [{ repo: REPO, prNumber: 4101 }]);
  assert.ok(existsSync(jobPath), 'the job stays pending');
  assert.ok(delayedPendingPaths.has(jobPath), 'the job is skipped for the rest of this pass');
  const job = readFollowUpJob(jobPath);
  assert.equal(job.status, 'pending');
  assert.equal(job.remediationPlan.currentRound, 0, 'no remediation round is charged');
  assert.deepEqual(job.livePrOwnerDeferral, {
    reason: LIVE_PR_OWNER_DEFERRED,
    launchRequestId: 'lrq_synthetic_update',
    workerClass: 'claude-code',
    launchStatus: 'running',
    kind: 'pr-update',
    observedAt: CLAIMED_AT,
    since: CLAIMED_AT,
  });
});

test('a terminal owner lets the job proceed on the next pass and clears the deferral', async (t) => {
  const rootDir = tempRoot(t);
  const { jobPath, job } = pendingJob(rootDir, 4102);
  assert.equal(await claimOnce(rootDir, async () => liveUpdate()), null);
  assert.equal(readFollowUpJob(jobPath).livePrOwnerDeferral.reason, LIVE_PR_OWNER_DEFERRED);

  // Next pass: the PR-update reached a terminal state, so HQ reports no live owner.
  const claimed = await claimOnce(rootDir, async () => ({ state: 'free' }),
    { observedAt: '2026-04-21T10:05:00.000Z' });
  assert.ok(claimed?.job, 'the job is claimed once the owner is terminal');
  assert.equal(claimed.job.jobId, job.jobId);
  assert.equal(claimed.job.status, 'in_progress');
  assert.equal(claimed.job.livePrOwnerDeferral, undefined, 'the stale deferral does not outlive the owner');
  assert.equal(existsSync(jobPath), false);
});

test('an owner lookup that fails, throws or answers nothing defers; unknown is not free', async (t) => {
  for (const lookup of [
    async () => ({ state: 'unknown', reason: 'lookup-timeout' }),
    async () => { throw new Error('synthetic transport failure'); },
    async () => undefined,
  ]) {
    const rootDir = tempRoot(t);
    const { jobPath } = pendingJob(rootDir, 4103);
    assert.equal(await claimOnce(rootDir, lookup), null);
    const job = readFollowUpJob(jobPath);
    assert.equal(job.status, 'pending');
    assert.equal(job.livePrOwnerDeferral.reason, LIVE_PR_OWNER_UNKNOWN);
    assert.match(job.livePrOwnerDeferral.lookupReason, /^lookup-(timeout|failed)$/);
  }
});

test('a deferred PR does not block a different PR in the same claim', async (t) => {
  const rootDir = tempRoot(t);
  const owned = pendingJob(rootDir, 4104, { reviewPostedAt: '2026-04-21T07:00:00.000Z' });
  const free = pendingJob(rootDir, 4105, { reviewPostedAt: '2026-04-21T09:00:00.000Z' });
  const claimed = await claimOnce(rootDir, async ({ prNumber }) =>
    (prNumber === 4104 ? liveUpdate('lrq_synthetic_hammer') : { state: 'free' }));
  assert.equal(claimed.job.jobId, free.job.jobId);
  assert.equal(readFollowUpJob(owned.jobPath).livePrOwnerDeferral.launchRequestId, 'lrq_synthetic_hammer');
});

test('repeat deferrals keep the first observation and do not rewrite an unchanged record', async (t) => {
  const rootDir = tempRoot(t);
  const { jobPath } = pendingJob(rootDir, 4106);
  await claimOnce(rootDir, async () => liveUpdate());
  const first = readFileSync(jobPath, 'utf8');
  await claimOnce(rootDir, async () => liveUpdate(), { observedAt: '2026-04-21T10:01:00.000Z' });
  assert.equal(readFileSync(jobPath, 'utf8'), first);
  await claimOnce(rootDir, async () => liveUpdate('lrq_synthetic_next'), { observedAt: '2026-04-21T10:02:00.000Z' });
  const changed = readFollowUpJob(jobPath).livePrOwnerDeferral;
  assert.equal(changed.launchRequestId, 'lrq_synthetic_next');
  assert.equal(changed.since, CLAIMED_AT, 'the waiting-since time survives an owner hand-off');
});

test('one claim spends a bounded number of owner lookups', async (t) => {
  const rootDir = tempRoot(t);
  for (let i = 0; i <= LIVE_PR_OWNER_LOOKUPS_PER_CLAIM; i++) pendingJob(rootDir, 5000 + i);
  let lookups = 0;
  const claimed = await claimOnce(rootDir, async () => { lookups++; return liveUpdate(); });
  assert.deepEqual(claimed, { ownerLookupBudget: true });
  assert.equal(lookups, LIVE_PR_OWNER_LOOKUPS_PER_CLAIM);
});

test('without a lookup the claim path is unchanged', async (t) => {
  const rootDir = tempRoot(t);
  const { job } = pendingJob(rootDir, 4107);
  const claimed = await claimOnce(rootDir, null);
  assert.equal(claimed.job.jobId, job.jobId);
  assert.equal(claimed.job.livePrOwnerDeferral, undefined);
});

test('consumeNextFollowUpJob defers under a live owner and never touches a running remediation', async (t) => {
  const rootDir = tempRoot(t);
  // A remediation already running for another PR, owned by this daemon.
  const runningDir = getFollowUpJobDir(rootDir, 'inProgress');
  mkdirSync(runningDir, { recursive: true });
  const runningPath = path.join(runningDir, 'synthetic-running.json');
  const runningJob = { schemaVersion: 1, jobId: 'synthetic-running', repo: REPO, prNumber: 4108,
    status: 'in_progress', remediationWorker: { processId: 999999, state: 'spawned' } };
  writeFileSync(runningPath, `${JSON.stringify(runningJob, null, 2)}\n`);
  const runningBytes = readFileSync(runningPath, 'utf8');
  const { jobPath } = pendingJob(rootDir, 4109);

  const asked = [];
  const result = await consumeNextFollowUpJob({
    rootDir,
    now: () => CLAIMED_AT,
    promptTemplate: 'synthetic prompt',
    ensureWorkerRegistryReadyImpl: async () => {},
    execFileImpl: async () => { throw new Error('no command may run while the PR is owned'); },
    spawnImpl: () => { throw new Error('no worker may spawn while the PR is owned'); },
    livePrOwnerLookupImpl: async (args) => { asked.push(args.prNumber); return liveUpdate(); },
    log: quiet,
  });

  assert.deepEqual(result, { consumed: false, reason: 'no-pending-jobs' });
  assert.deepEqual(asked, [4109], 'only pending jobs are checked; running jobs are not re-gated');
  assert.equal(readFollowUpJob(jobPath).livePrOwnerDeferral.launchRequestId, 'lrq_synthetic_update');
  assert.equal(readFileSync(runningPath, 'utf8'), runningBytes, 'the running remediation is not cancelled or rewritten');
});

test('concurrent gated claims still reserve repo#pr synchronously, so one PR is claimed once', async (t) => {
  const rootDir = tempRoot(t);
  pendingJob(rootDir, 4110, { reviewPostedAt: '2026-04-21T07:00:00.000Z' });
  pendingJob(rootDir, 4110, { reviewPostedAt: '2026-04-21T07:01:00.000Z' });
  pendingJob(rootDir, 4111, { reviewPostedAt: '2026-04-21T07:02:00.000Z' });
  const reserved = new Set();
  const lookup = async () => { await new Promise(resolve => setTimeout(resolve, 5)); return { state: 'free' }; };
  const gated = () => claimWithLivePrOwnerGate({
    lookupImpl: lookup, observedAt: CLAIMED_AT, log: quiet,
    claim: (claimedAt, livePrOwnerDecision) => {
      const next = claimNextFollowUpJob({ rootDir, claimedAt, returnStopped: true,
        excludedRepoPrKeys: reserved, livePrOwnerDecision });
      if (next?.job && !next.stopped) reserved.add(`${next.job.repo.toLowerCase()}#${next.job.prNumber}`);
      return next;
    },
  });
  const claims = await Promise.all([gated(), gated(), gated()]);
  const prs = claims.filter(c => c?.job).map(c => c.job.prNumber).sort();
  assert.deepEqual(prs, [4110, 4111]);
});

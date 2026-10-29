import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeAmaAuditEntry } from '../src/ama/audit.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordHammerCiStop } from '../src/ama/hammer-ci-stop.mjs';
import { releaseRecoveredCiInfrastructureOwner, updateAmaCloserDispatchRecord, readAmaCloserDispatchRecord } from '../src/ama/dispatch-closer.mjs';
import { acquireAmaCloserLease, updateAmaCloserLease, readAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { closureOwnerShadowEvidence } from '../src/pr-next-action-consumer.mjs';
import { deriveNextActionSnapshot, nextAction } from '../src/pr-next-action.mjs';
import { resolveSharedNextAction } from '../src/pr-next-action-shadow.mjs';
import { readHammerStopForHead, isInfrastructureStop } from '../src/ama/hammer-stop-hold.mjs';

const repo = 'example/fixture', prNumber = 42, headSha = 'a'.repeat(40);
const now = '2026-01-01T00:00:00Z', launchRequestId = 'lrq_fixture-capacity';
const identity = { repo, prNumber, headSha };
const blocked = { name: 'unit', conclusion: 'FAILURE', steps: [],
  output: { summary: 'The job was not started because an Actions budget is preventing further use.' } };
const green = { name: 'unit', conclusion: 'SUCCESS' };
const logger = { log() {}, warn() {}, error() {} };
function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-capacity-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}
function stop(rootDir, checks = [blocked]) {
  return recordHammerCiStop({ repo, prNumber, pr: { state: 'OPEN', headRefOid: headSha, statusCheckRollup: checks },
    env: { HAM_HQ_ROOT: rootDir, HQ_LAUNCH_REQUEST_ID: launchRequestId },
    execFileImpl: async () => assert.fail('fixture has complete job evidence') });
}
function owner(rootDir) {
  acquireAmaCloserLease({ rootDir, ...identity, watcherPid: process.pid, now });
  updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: launchRequestId, now });
  updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity,
    state: 'dispatched', launchRequestId, lastObservedStatus: 'blocked_needs_decision' }));
}
function probe(status = 'blocked_needs_decision', extra = {}) {
  return { ok: true, row: { launch_request_id: launchRequestId, status }, retryChain: [], ...extra };
}
function selection(rootDir, launch = null, checks = [green]) {
  const evidence = closureOwnerShadowEvidence({ currentHead: headSha,
    lease: readAmaCloserLease(rootDir, identity), launchRecord: readAmaCloserDispatchRecord(rootDir, identity),
    reviewState: { verdict: 'approved', headSha, blockingFindingState: 'known', blockingFindingCount: 0,
      nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 }, strictMode: true, roundsLeft: false,
  }, { subjectKey: `${repo}#${prNumber}`, rootDir, observedAt: now, autonomousMergeExecutionEnabled: true,
    candidate: { headSha, prState: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', labels: [] }, checksRollup: checks });
  // Supply the fixture ledger observation only when a reference still exists.
  if (evidence.readLaunches) evidence.observations.launches = { closer: { headSha, probe: launch || probe() } };
  else evidence.observations.launches = { closer: null };
  return nextAction(deriveNextActionSnapshot(evidence));
}

test('CIBLOCKRESUME-01 closing tooling records an infrastructure stop before lease/decision', async t => {
  const rootDir = fixture(t);
  const result = await stop(rootDir);
  assert.equal(result.reason, 'ci-infrastructure');
  assert.equal(result.outcome, 'failed-without-merge');
  const recorded = readHammerStopForHead({ hqRoot: rootDir, ...identity });
  assert.equal(isInfrastructureStop(recorded), true);
  assert.equal(recorded.refusal, null);
  assert.equal(readAmaCloserLease(rootDir, identity), null);
  assert.equal(await stop(rootDir, [{ ...blocked, steps: [{ conclusion: 'failure' }] }]), null);
  assert.equal(await stop(rootDir, [blocked, { name: 'test', conclusion: 'FAILURE', steps: [{ conclusion: 'failure' }] }]), null);
});

test('CIBLOCKRESUME-01 legacy decision ownership releases and selects closer in the same pass', async t => {
  const rootDir = fixture(t);
  // Legacy hammers used an older generic CI reason before raising a decision.
  writeAmaAuditEntry({ hqRoot: rootDir, ...identity, now,
    attempt: { path: 'hammer', head: headSha, outcome: 'failed-without-merge',
      reason: 'github-gate-not-green', launchRequestId,
      githubGate: { reasons: ['ci-not-green'], badChecks: [blocked] } } });
  owner(rootDir);
  assert.equal(selection(rootDir).row, 'R03-live-owner');
  const args = { rootDir, hqRoot: rootDir, repo, prNumber, now, logger,
    prMetadata: { isOpen: true, headSha, statusCheckRollup: [blocked] }, readLaunchImpl: async () => probe() };
  assert.equal(await releaseRecoveredCiInfrastructureOwner(args), false);
  assert.equal(selection(rootDir).row, 'R03-live-owner');
  assert.equal(await releaseRecoveredCiInfrastructureOwner({ ...args,
    prMetadata: { ...args.prMetadata, statusCheckRollup: [green] } }), true);
  assert.equal(readAmaCloserLease(rootDir, identity), null);
  assert.equal(readAmaCloserDispatchRecord(rootDir, identity).recoveredLaunchRequestId, launchRequestId);
  assert.equal(selection(rootDir).row, 'R15-daemon');
  assert.equal(selection(rootDir, null, []).action, 'wait-for-CI');
  assert.equal(selection(rootDir, null, [{ ...green, conclusion: 'FAILURE' }]).action, 'hammer');
});

for (const [name, changed] of [
  ['running owner', probe('running')], ['unknown descendants', probe('blocked_needs_decision', { retryChainUnreadable: true })],
  ['live retry', probe('blocked_needs_decision', { retryChain: [{ launch_request_id: 'lrq_retry', status: 'running' }] })],
  ['foreign launch', { ok: true, row: { launch_request_id: 'lrq_foreign', status: 'blocked_needs_decision' } }],
]) test(`CIBLOCKRESUME-01 retains ${name}`, async t => {
  const rootDir = fixture(t); await stop(rootDir); owner(rootDir);
  assert.equal(await releaseRecoveredCiInfrastructureOwner({ rootDir, hqRoot: rootDir, repo, prNumber, now, logger,
    prMetadata: { isOpen: true, headSha, statusCheckRollup: [green] }, readLaunchImpl: async () => changed }), false);
  assert.equal(readAmaCloserDispatchRecord(rootDir, identity).launchRequestId, launchRequestId);
  assert.ok(readAmaCloserLease(rootDir, identity));
});


test('CIBLOCKRESUME-01 recovered receipt replaces a cached live-owner snapshot in one pass', async t => {
  const rootDir = fixture(t); await stop(rootDir); owner(rootDir);
  const passSnapshot = deriveNextActionSnapshot({ subjectKey: `${repo}#${prNumber}`, head: headSha,
    observedAt: now, observations: { pr: { headSha, state: 'OPEN', isDraft: false, labels: [], mergeable: 'MERGEABLE' },
      policy: { autonomousMergeExecutionEnabled: true }, leases: { closer: readAmaCloserLease(rootDir, identity) },
      launches: { closer: { headSha, probe: probe() } } } });
  const before = await resolveSharedNextAction({ passSnapshot, evidence: { observations: {} } });
  assert.equal(before.decision.row, 'R03-live-owner');
  await releaseRecoveredCiInfrastructureOwner({ rootDir, hqRoot: rootDir, repo, prNumber, now, logger,
    prMetadata: { isOpen: true, headSha, statusCheckRollup: [green] }, readLaunchImpl: async () => probe() });
  const evidence = closureOwnerShadowEvidence({ currentHead: headSha, lease: null,
    launchRecord: readAmaCloserDispatchRecord(rootDir, identity), roundsLeft: false,
    reviewState: { verdict: 'approved', headSha, blockingFindingState: 'known', blockingFindingCount: 0,
      nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 } },
    { rootDir, subjectKey: `${repo}#${prNumber}`, observedAt: now, autonomousMergeExecutionEnabled: true,
      candidate: { headSha, prState: 'OPEN', isDraft: false, labels: [], mergeable: 'MERGEABLE' }, checksRollup: [green] });
  const after = await resolveSharedNextAction({ passSnapshot, evidence, refreshEvidence: true });
  assert.equal(after.decision.row, 'R15-daemon');
});


test('CIBLOCKRESUME-01 closing CLI emits a typed stop without invoking an HQ decision', t => {
  const rootDir = fixture(t), path = join(rootDir, 'pr.json');
  writeFileSync(path, JSON.stringify({ state: 'OPEN', headRefOid: headSha, statusCheckRollup: [blocked] }));
  const result = spawnSync(process.execPath, [new URL('../bin/hammer-ci-stop.mjs', import.meta.url).pathname, path], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, HAM_HQ_ROOT: rootDir, HAM_REPO: repo,
      HAM_PR_NUMBER: String(prNumber), HQ_LAUNCH_REQUEST_ID: launchRequestId },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 20, result.stderr);
  assert.equal(JSON.parse(result.stdout).reason, 'ci-infrastructure');
  assert.equal(JSON.parse(result.stdout).noMerge, true);
  assert.ok(isInfrastructureStop(readHammerStopForHead({ hqRoot: rootDir, ...identity })));
});

for (const [name, prMetadata, requiredCheckContexts] of [
  ['moved head', { isOpen: true, headSha: 'b'.repeat(40), statusCheckRollup: [green] }, []],
  ['closed PR', { isOpen: false, headSha, statusCheckRollup: [green] }, []],
  ['missing required context', { isOpen: true, headSha, statusCheckRollup: [green] }, ['unit', 'lint']],
  ['pending replacement', { isOpen: true, headSha, statusCheckRollup: [{ name: 'unit', status: 'IN_PROGRESS' }] }, []],
]) test(`CIBLOCKRESUME-01 retains custody for ${name}`, async t => {
  const rootDir = fixture(t); await stop(rootDir); owner(rootDir);
  assert.equal(await releaseRecoveredCiInfrastructureOwner({ rootDir, hqRoot: rootDir, repo, prNumber,
    prMetadata, requiredCheckContexts, now, logger, readLaunchImpl: async () => probe() }), false);
  assert.equal(readAmaCloserDispatchRecord(rootDir, identity).launchRequestId, launchRequestId);
});


test('CIBLOCKRESUME-01 recovery preflight never evaluates a packaging stop', async t => {
  const rootDir = fixture(t);
  writeAmaAuditEntry({ hqRoot: rootDir, ...identity, now,
    attempt: { path: 'hammer', head: headSha, outcome: 'failed-without-merge',
      reason: 'missing-dispatch-phase-scripts', launchRequestId } });
  assert.equal(await releaseRecoveredCiInfrastructureOwner({ rootDir, hqRoot: rootDir, repo, prNumber,
    prMetadata: { isOpen: true, headSha, statusCheckRollup: [green] },
    evaluateStopImpl: async () => assert.fail('other infrastructure hold semantics must remain unchanged') }), false);
});

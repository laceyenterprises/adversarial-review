import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReviewFindings } from '../src/kernel/review-findings.mjs';
import { normalizeFindingsCount } from '../src/reviewed-attestation.mjs';
import { classifyBlockingFindings, classifyNonBlockingFindings } from '../src/merge-agent-review-classification.mjs';
import { recoverAmaAutomation } from "../src/ama/automated-recovery.mjs";
import { reconcileRecoveryLaunches } from '../src/ama/recovery-launch-reconciliation.mjs';
import { matrixPair, HEAD, OLD, AT, clean } from './helpers/next-action-matrix.mjs';

for (const [name, blocking, nonBlocking] of [
  ['ar-1208-2026-10-03T2323.md', 0, 11],
  ['comment-only-merge-eligible.md', 0, 0],
  ['request-changes-blocker-missing-category.md', 1, 0],
]) {
  test(`shared counts and identities: ${name}`, () => {
    const body = readFileSync(new URL(`./fixtures/review-bodies/${name}`, import.meta.url), 'utf8');
    const parsed = parseReviewFindings(body);
    assert.deepEqual(classifyBlockingFindings(body), { count: blocking, state: 'known' });
    assert.deepEqual(classifyNonBlockingFindings(body), { count: nonBlocking, state: 'known' });
    assert.equal(parsed.blocking.count, blocking);
    assert.equal(parsed.nonBlocking.count, nonBlocking);
    assert.equal(normalizeFindingsCount(body), blocking + nonBlocking);
    assert.equal(parsed.findingsCount, blocking + nonBlocking);
  });
}

test('malformed missing sections fail closed, nested fields are not findings', () => {
  assert.equal(normalizeFindingsCount('## Verdict\nComment only'), null);
  const body = '## Blocking issues\n- None.\n## Non-blocking issues\n- **A**\n  - **File:** a\n  - **Lines:** 1\n  - **Problem:** broken\n- **B**\n  - **File:** b\n  - **Lines:** 2\n  - **Problem:** broken';
  assert.equal(normalizeFindingsCount(body), 2);
  assert.equal(normalizeFindingsCount(body.replaceAll('\n', '\r\n')), 2);
});

function harness(t, result, overrides = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'amafind-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const calls = { rereview: [], hammer: 0, page: [], events: [] };
  const args = { rootDir, repo: 'subject-07', prNumber: 7, headSha: HEAD, result,
    reviewStateRow: { review_status: 'posted', posted_at: 'first-pass' },
    requestRereviewImpl: async (options) => { calls.rereview.push(options); return { triggered: true }; },
    dispatchHammer: async () => { calls.hammer += 1; return { dispatched: true }; },
    pageImpl: async (...args) => { calls.page.push(args); },
    logger: { error: (event) => calls.events.push(JSON.parse(event)), warn() {}, log() {} },
    ...overrides };
  return { args, calls };
}

test('phantom launch reclaimed, live or unreadable launches remain held', async (t) => {
  const { args } = harness(t, {});
  const dispatchPath = join(args.rootDir, 'record.json');
  const record = { repo: args.repo, prNumber: 1, headSha: 'head', launchRequestId: 'lrq', dispatchPath, state: 'dispatched' };
  writeFileSync(dispatchPath, JSON.stringify(record));
  // Isolate ordinary recovery routing; elapsed ownerless admission is covered
  // by remorphan-01 and the closure integration tests.
  const input = { recoverOrphanImpl: async () => null, rootDir: args.rootDir, logger: args.logger, listActiveImpl: () => [record],
    isPhantomImpl: (row) => row.pid === 0,
    readStatusImpl: async () => ({ ok: true, row: { status: 'running', pid: 0 } }) };
  assert.deepEqual(await reconcileRecoveryLaunches(input), { reclaimed: 1, active: 0, uncertain: 0 });
  assert.equal(JSON.parse(readFileSync(dispatchPath)).lastObservedStatus, 'failed');
  assert.deepEqual(await reconcileRecoveryLaunches({ ...input, readStatusImpl: async () => ({ ok: false }) }), { reclaimed: 0, active: 0, uncertain: 1 });
  assert.deepEqual(await reconcileRecoveryLaunches({ ...input, readStatusImpl: async () => ({ ok: true, row: { status: 'running', pid: 123 } }) }), { reclaimed: 0, active: 1, uncertain: 0 });
});

test('per-head launch reconciliation ignores unrelated active and uncertain launches', async () => {
  const records = [
    { repo: 'other/repo', prNumber: 1, headSha: 'head' },
    { repo: 'fixture/repo', prNumber: 2, headSha: 'head' },
    { repo: 'fixture/repo', prNumber: 1, headSha: 'old' },
    { repo: 'fixture/repo', prNumber: 1, headSha: 'head', launchRequestId: 'own' },
  ];
  const probed = [];
  const result = await reconcileRecoveryLaunches({ rootDir: '/unused', repo: 'fixture/repo', prNumber: 1, headSha: 'head',
    listActiveImpl: () => records, isPhantomImpl: () => false,
    readStatusImpl: async ({ launchRequestId }) => {
      probed.push(launchRequestId);
      return { ok: true, row: { status: 'running' } };
    },
  });
  assert.deepEqual(probed, ['own']);
  assert.deepEqual(result, { reclaimed: 0, active: 1, uncertain: 0 });
  assert.deepEqual(await reconcileRecoveryLaunches({ rootDir: '/unused', repo: 'fixture/repo', prNumber: 3, headSha: 'head',
    listActiveImpl: () => records, isPhantomImpl: () => false,
    readStatusImpl: async () => { throw new Error('unrelated launch probed'); },
  }), { reclaimed: 0, active: 0, uncertain: 0 });
});


function selected(t, observations, overrides = {}) {
  const shared = matrixPair(observations);
  return harness(t, { nextAction: shared.decision }, { now: () => Date.parse(AT), ...overrides });
}

test('shared review intent reserves one rereview until a new posting', async t => {
  const { args, calls } = selected(t, { reviews: { ...clean, headSha: OLD } });
  assert.equal((await recoverAmaAutomation(args)).recovery.action, 'rereview');
  await recoverAmaAutomation(args);
  await recoverAmaAutomation({ ...args, reviewStateRow: { review_status: 'reviewing' } });
  assert.equal(calls.rereview.length, 1);
  assert.equal(calls.rereview[0].targetRevisionRef, HEAD);
  assert.equal(calls.hammer, 0);
});

test('recovery reservations retain the existing real attempt cap and one durable page', async t => {
  let time = Date.parse(AT);
  const { args, calls } = selected(t, { checks: { conclusion: 'FAILURE' } }, {
    now: () => time, maxAttempts: 2, stuckDeadlineMs: 1000,
  });
  assert.equal((await recoverAmaAutomation(args)).outcome, 'ama-dispatched');
  assert.equal((await recoverAmaAutomation(args)).outcome, 'ama-dispatched');
  assert.equal((await recoverAmaAutomation(args)).recovery.action, 'attempt-cap');
  time += 1000;
  for (let poll = 0; poll < 3; poll++) assert.equal((await recoverAmaAutomation(args)).outcome, 'recovery-exhausted');
  assert.equal(calls.hammer, 2);
  assert.equal(calls.page.length, 1);
  assert.equal(calls.events.length, 1);
  assert.equal(calls.events[0].nextAction.actor, 'hammer');
  assert.match(calls.page[0][0], /action=hammer actor=hammer reason=ci-red-final/);
});

test('a refused alert retries without charging another action or sliding its anchor', async t => {
  let time = Date.parse(AT), deliveries = 0;
  const { args } = selected(t, { controls: { stop: { deterministic: true, fingerprint: 'stop-07' } } }, {
    now: () => time, stuckDeadlineMs: 1000, pageImpl: async () => {
      deliveries++;
      if (deliveries === 1) throw new Error('synthetic delivery refusal');
    },
  });
  const first = await recoverAmaAutomation(args);
  time += 1000;
  await recoverAmaAutomation(args);
  const delivered = await recoverAmaAutomation(args);
  await recoverAmaAutomation(args);
  assert.equal(deliveries, 2);
  assert.equal(delivered.recovery.attempts, 0);
  assert.equal(delivered.recovery.firstActionableAt, AT);
  assert.equal(delivered.recovery.nextAction.decisionKey, first.recovery.nextAction.decisionKey);
});

for (let trial = 0; trial < 10; trial++) test(`recovery flock preserves one review reservation: ${trial}`, async t => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const { args, calls } = selected(t, { reviews: { ...clean, headSha: OLD } }, {
    requestRereviewImpl: async () => { calls.rereview.push('reserved'); await blocked; return { triggered: true }; },
  });
  const first = recoverAmaAutomation(args);
  await new Promise(resolve => setImmediate(resolve));
  const second = await recoverAmaAutomation(args);
  assert.equal(second.recovery.action, 'recovery-in-progress');
  release();
  await first;
  await recoverAmaAutomation(args);
  assert.equal(calls.rereview.length, 1);
  assert.equal(calls.hammer, 0);
});

for (const code of ['ABORT_ERR', 'AMA_COEXISTENCE_ABORTED', 'AMA_COEXISTENCE_OPERATION_TIMEOUT']) {
  test(`cancellation preserves recovery budget: ${code}`, async t => {
    const error = Object.assign(new Error('synthetic cancellation'), { code });
    const { args } = selected(t, { checks: { conclusion: 'FAILURE' } }, {
      dispatchHammer: async () => { throw error; },
    });
    await assert.rejects(recoverAmaAutomation(args), candidate => candidate === error);
    const resumed = await recoverAmaAutomation({ ...args, dispatchHammer: async () => ({ dispatched: false,
      nextAction: matrixPair({ checks: { conclusion: 'PENDING' } }).decision }) });
    assert.equal(resumed.recovery.attempts, 0);
  });
}

for (const observations of [
  { checks: { conclusion: 'PENDING' } },
  { leases: null, controls: { stop: { deterministic: true, fingerprint: 'stop-07' } } },
  { progress: { mergeReceipt: { merged: true, headSha: HEAD, path: 'hammer' } } },
]) test('unknown, stopped and unconfirmed receipts retain an observer without dispatch', async t => {
  const { args, calls } = selected(t, observations);
  const outcome = await recoverAmaAutomation(args);
  assert.notEqual(outcome.outcome, 'pr-terminal');
  assert.equal(calls.hammer, 0);
  assert.equal(calls.rereview.length, 0);
});

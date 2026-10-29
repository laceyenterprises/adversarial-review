import test from 'node:test';
import assert from 'node:assert/strict';
import fsExt from 'fs-ext';
import { openSync, closeSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operatorLabelInputs } from '../src/ama/operator-label-inputs.mjs';
import { writeAmaAuditEntry, readAmaAuditEntry } from '../src/ama/audit.mjs';
import { evaluateHammerStopHold, readHammerStopForHead } from '../src/ama/hammer-stop-hold.mjs';
import { recordHammerRetryDispatch, evaluateHammerRetryCap, readHammerRetryCapLedger,
  hammerRetryCapFilePath, rearmOperatorApprovedCloser, markHammerRetryCapExhausted } from '../src/ama/hammer-retry-cap.mjs';

const headSha = 'a'.repeat(40), otherHead = 'b'.repeat(40);
const identity = { repo: 'fixture-owner/fixture-repo', prNumber: 900002 };
const now = '2026-01-01T00:05:00Z';
const logger = { log() {}, warn() {} };
function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'approval-rearm-unit-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const args = { rootDir, hqRoot: rootDir, ...identity, headSha, reviewedSha: headSha, logger, now,
    deliverAlertImpl: async () => {},
    prMetadata: { headSha, isOpen: true, labels: [], mergeableState: 'MERGEABLE' } };
  for (let i = 1; i <= 2; i++) {
    recordHammerRetryDispatch(rootDir, identity, { jobKey: headSha, headSha,
      launchRequestId: `fixture-launch-${i}`, now: `2026-01-01T00:0${i}:00Z` });
    writeAmaAuditEntry({ hqRoot: rootDir, ...identity, headSha,
      now: `2026-01-01T00:0${i}:10Z`, attempt: { outcome: 'failed-without-merge',
        attemptPhase: 'hammer-gh-pr-merge', validatedHead: headSha,
        reason: 'activation-gate', closingStatus: 'Activation gate requires operator-approved label.' } });
  }
  return args;
}

test('APPROVALREARM-01: audit records the awaited input; legacy activation notes remain readable', t => {
  const args = fixture(t);
  const audit = readAmaAuditEntry(args.hqRoot, identity.repo, identity.prNumber, headSha);
  const awaitedInputs = [{ kind: 'operator-label', label: 'operator-approved' }];
  assert.deepEqual(audit.attempts.at(-1).awaitedInputs, awaitedInputs);
  assert.deepEqual(operatorLabelInputs({ closingStatus: 'Activation gate requires `operator-approved` label.' }), awaitedInputs);
  assert.deepEqual(operatorLabelInputs({ closingStatus: 'operator-approved mentioned without a requirement' }), []);
  const stop = readHammerStopForHead({ ...args, readAuditImpl: () => ({ ...audit,
    attempts: audit.attempts.map(({ awaitedInputs: _inputs, ...attempt }) => attempt) }) });
  assert.deepEqual(stop.refusal.awaitedInputs, awaitedInputs);
});

test('APPROVALREARM-01: hold releases only for the named approval on an open exact head', async t => {
  const args = fixture(t);
  assert.equal((await evaluateHammerStopHold(args)).action, 'hold');
  assert.equal((await evaluateHammerStopHold({ ...args,
    prMetadata: { ...args.prMetadata, labels: ['fixture-unrelated'] } })).action, 'hold');
  const approved = { ...args, prMetadata: { ...args.prMetadata, labels: [{ name: 'operator-approved' }] } };
  assert.equal((await evaluateHammerStopHold({ ...approved, prMetadata: { ...approved.prMetadata, isOpen: false } })).action, 'hold');
  for (let i = 0; i < 2; i++) {
    const released = await evaluateHammerStopHold(approved);
    assert.equal(released.action, 'release');
    assert.deepEqual(released.changed, ['operator-approval-applied']);
  }
});

test('APPROVALREARM-01: durable grant survives suppression/review changes and is consumed once without refunds', t => {
  const args = fixture(t);
  const stop = readHammerStopForHead(args);
  const options = { jobKey: headSha, headSha, stop, now: '2026-01-01T00:05:00.500Z', prMetadata: { ...args.prMetadata, labels: ['operator-approved'] } };
  const grant = overrides => rearmOperatorApprovedCloser(args.rootDir, identity, { ...options, ...overrides });
  assert.equal(grant({ prMetadata: { ...args.prMetadata, labels: ['fixture-unrelated'] } }).granted, false);
  assert.equal(grant({ headSha: otherHead }).granted, false);
  assert.equal(grant().granted, true);
  assert.equal(grant().granted, false, 'repeated polls/restart reuse the persisted slot');
  const read = () => readHammerRetryCapLedger(args.rootDir, identity);
  assert.equal(evaluateHammerRetryCap(read(), { jobKey: headSha, headSha }).capExhausted, false);
  assert.equal(evaluateHammerRetryCap(read(), { jobKey: headSha, headSha, lifetimeDispatchCeiling: 0 }).capExhausted, true);
  assert.equal(evaluateHammerRetryCap(read(), { jobKey: headSha, headSha: otherHead }).capExhausted, true);
  recordHammerRetryDispatch(args.rootDir, identity, { jobKey: headSha, headSha,
    launchRequestId: 'fixture-approved-launch', dispatchKey: 'fixture-approved-charge', now });
  assert.equal(read().attemptCount, 3);
  assert.equal(read().lifetimeAttemptCount, 3);
  assert.equal(read().targetAttemptCount, 3);
  assert.equal(evaluateHammerRetryCap(read(), { jobKey: headSha, headSha }).capExhausted, true);
  assert.equal(grant().granted, false);
  markHammerRetryCapExhausted(args.rootDir, identity, { jobKey: otherHead, headSha: otherHead, now });
  assert.equal(read().operatorApprovalRearms[headSha].state, 'consumed');
  recordHammerRetryDispatch(args.rootDir, identity, { jobKey: otherHead, headSha: otherHead, now });
  assert.equal(read().operatorApprovalRearms[headSha].state, 'consumed');
});

test('APPROVALREARM-01: missing inputs, terminal heads, disabled dispatch and corrupt counts cannot grant', t => {
  const args = fixture(t);
  const stop = readHammerStopForHead(args);
  const options = { jobKey: headSha, headSha, stop, now,
    prMetadata: { ...args.prMetadata, labels: ['operator-approved'] } };
  const grant = overrides => rearmOperatorApprovedCloser(args.rootDir, identity, { ...options, ...overrides });
  assert.equal(grant({ lifetimeDispatchCeiling: 0 }).granted, false);
  assert.equal(grant({ prMetadata: { ...options.prMetadata, isOpen: false } }).granted, false);
  assert.equal(grant({ prMetadata: { ...options.prMetadata, state: 'MERGED' } }).granted, false);
  assert.equal(grant({ prMetadata: { ...options.prMetadata, headSha: otherHead } }).granted, false);
  assert.equal(grant({ prMetadata: { ...options.prMetadata, labels: undefined } }).granted, false);
  assert.equal(grant({ stop: { ...stop, refusal: { ...stop.refusal,
    awaitedInputs: [...stop.refusal.awaitedInputs, { kind: 'operator-label', label: 'fixture-other-approval' }] } } }).granted, false);
  assert.equal(grant().granted, true);
  const ledger = readHammerRetryCapLedger(args.rootDir, identity);
  assert.equal(evaluateHammerRetryCap(ledger, { jobKey: headSha, headSha, lifetimeDispatchCeiling: 1 }).capExhausted, false,
    'the single allowance also works at an exhausted configured lifetime cap');
  assert.equal(evaluateHammerRetryCap({ ...ledger, __corrupt: true }, { jobKey: headSha, headSha }).operatorApprovalApplied, undefined);
  assert.equal(evaluateHammerRetryCap({ ...ledger, attemptCount: 'invalid' }, { jobKey: headSha, headSha }).operatorApprovalApplied, undefined);
  assert.equal(evaluateHammerRetryCap(ledger, { jobKey: otherHead, headSha }).operatorApprovalApplied, undefined);
});


test('APPROVALREARM-01: an existing receipt avoids the busy writer lock', t => {
  const args = fixture(t);
  const options = { jobKey: headSha, headSha, stop: readHammerStopForHead(args), now,
    prMetadata: { ...args.prMetadata, labels: ['operator-approved'] } };
  assert.equal(rearmOperatorApprovedCloser(args.rootDir, identity, options).granted, true);
  const fd = openSync(hammerRetryCapFilePath(args.rootDir, identity) + '.lock', 'a');
  try {
    fsExt.flockSync(fd, 'exnb');
    assert.equal(rearmOperatorApprovedCloser(args.rootDir, identity, options).granted, false);
  } finally { closeSync(fd); }
});

test('APPROVALREARM-01: typed-only approvals have an actionable fallback', t => {
  const args = fixture(t);
  const stop = readHammerStopForHead({ ...args, readAuditImpl: () => ({ attempts: [{
    head: headSha, path: 'hammer', outcome: 'failed-without-merge', startedAt: now,
    awaitedInputs: [{ kind: 'operator-label', label: 'fixture-approval' }],
  }] }) });
  assert.deepEqual(stop.refusal.reasons, []);
  assert.equal(stop.refusal.next, 'Apply the awaited approval label(s): fixture-approval.');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pendingRepairEpoch, reserveRepairEpoch, bindRepairHead } from '../src/repair-epochs.mjs';
import { hammerRetryCapFilePath, updateHammerRetryCapLedger } from '../src/ama/hammer-retry-cap.mjs';
import { amaCloserLeaseFilePath } from '../src/ama/closer-lease.mjs';
import { amaCloserDispatchFilePath } from '../src/ama/dispatch-record-read.mjs';
import { tryAcquireCloserIntentLock } from '../src/ama/pre-receipt-intent.mjs';
import { getFollowUpJobDir } from '../src/follow-up-jobs.mjs';
import { mergeLeaseFilePath, readMergeLeaseHolders } from '../src/ama/merge-lease.mjs';

const identity = { repo: 'fixture/widgets', prNumber: 17, baseHead: 'a'.repeat(40),
  epochId: 'repair-aabbccdd-0000-1111-2222-333344445555',
  ownerKey: `in-place-repair-${'b'.repeat(64)}`, handoffRound: 3 };
const cwpIdentity = { repo: identity.repo, prNumber: identity.prNumber, baseHead: identity.baseHead,
  epochId: identity.epochId, ownerKey: `cwp-${'b'.repeat(24)}`, currentHead: 'e'.repeat(40),
  conflictWorkerId: 'codex-conflict-pr-17-rebase-a1b2c3d4', bootTraceOffset: 163 };
const absenceIdentity = { ...cwpIdentity, ledgerAbsence: true };
const reservedAt = '2026-11-21T00:00:00Z';
const cliSource = new URL('../bin/retire-legacy-repair.mjs', import.meta.url);

function fixture(t, changeEpoch = () => {}, selector = identity) {
  const workspace = mkdtempSync(join(realpathSync(tmpdir()), 'legacy-repair-retirement-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const root = join(workspace, 'tools/adversarial-review');
  const cli = join(root, 'bin/retire-legacy-repair.mjs');
  mkdirSync(dirname(cli), { recursive: true });
  copyFileSync(cliSource, cli);
  for (const directory of ['src', 'node_modules', 'migrations', 'templates']) {
    symlinkSync(fileURLToPath(new URL(`../${directory}`, import.meta.url)), join(root, directory), 'dir');
  }
  for (const path of ['package.json', 'package-lock.json', 'config.json',
    'bin/legacy-lane-write.mjs', 'bin/hammer-merge.sh']) {
    copyFileSync(new URL(`../${path}`, import.meta.url), join(root, path));
  }
  const historical = { id: 'historical', ownerKey: 'older', reviewHead: 'c'.repeat(40) };
  const epoch = { id: selector.epochId, ownerKey: selector.ownerKey, baseHead: selector.baseHead,
    reservedAt, ownerState: 'unknown', ownerLaunch: null, reviewHead: null, priorSpend: { series: 3 },
    refundedSpend: { old: ['closer'] }, ownerObservedAt: reservedAt };
  if (selector.currentHead) epoch.cause = 'conflict-without-owner';
  const ledger = { repo: identity.repo, prNumber: identity.prNumber, repairEpochs: [historical, epoch],
    attemptCount: 3, targetAttemptCount: 2, lifetimeAttemptCount: 5, suppressed: true,
    dispatchCharges: { opener: { started: true } }, selfErrorRefunds: { closer: ['old'] },
    unrelatedHistory: { a: 1 } };
  changeEpoch(epoch, ledger);
  const write = (path, value) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  };
  const path = hammerRetryCapFilePath(root, identity);
  write(path, ledger);
  const runtime = join(workspace, 'modules/worker-pool/lib/hq-python-runtime.sh');
  mkdirSync(dirname(runtime), { recursive: true });
  writeFileSync(runtime, 'hq_exec_python3_runtime() { "$FIXTURE_NODE" "$FIXTURE_READER" "$@"; }\n');
  const reader = fileURLToPath(new URL('fixtures/legacy-repair-fence-transport.mjs', import.meta.url));
  const runId = 'mar-a-20261121T000000Z-000abc';
  const { repo, prNumber, baseHead, epochId, ownerKey, currentHead, conflictWorkerId, bootTraceOffset } = selector;
  const proof = { kind: 'legacy-repair-retirement-proof', version: 1, recordedAt: '2026-11-21T00:30:00Z',
    evidence: { repo, prNumber, baseHead, epochId, ownerKey, reservedAt,
      reservationSha256: '9'.repeat(64), operator: 'fixture-owner',
      submitter: { kind: 'native-merge-rescue-handoff', runId, file: 'handoff.json', sha256: '8'.repeat(64),
        provenanceRef: `merge-agent-rescue:${identity.repo}#${identity.prNumber}:${runId}` } },
    absenceProof: { kind: 'canonical-repair-owner-family-absence', scope: 'all-canonical-launches',
      selector: { idempotency_key: identity.ownerKey } },
    enqueueFence: { kind: 'canonical-repair-owner-family-fence', ownerKey: identity.ownerKey } };
  let variantArgs = ['--handoff-round', String(identity.handoffRound)];
  if (currentHead) {
    proof.kind = 'cwp-repair-retirement-proof';
    Object.assign(proof.evidence, { currentHead, branch: 'original-pr-branch',
      submitter: { kind: 'native-auto-merge-conflict-dispatch', workerId: conflictWorkerId,
        jobSha256: '1'.repeat(64), resultSha256: '2'.repeat(64), bootTraceSha256: '3'.repeat(64), bootTraceOffset } });
    proof.absenceProof.selector = { idempotency_key: ownerKey, repair_epoch_id: epochId };
    proof.enqueueFence = { ...proof.enqueueFence, ownerKey, epochId };
    variantArgs = ['--current-head', currentHead, '--conflict-worker-id', conflictWorkerId,
      '--boot-trace-offset', String(bootTraceOffset)];
    if (selector.ledgerAbsence) {
      proof.evidence.submitter = { kind: 'canonical-cwp-ledger-absence' };
      variantArgs = ['--current-head', currentHead, '--ledger-absence'];
    }
  }
  const readerInput = join(root, 'fixture-reader-input.json');
  const attempt = (receipt = proof, action = 'read', changeArgs = args => args) => {
    write(readerInput, { receipt, action, identity: selector });
    const diagnostic = join(root, 'bin/fixture-reader.stderr');
    rmSync(diagnostic, { force: true });
    const result = spawnSync(process.execPath, [cli, ...changeArgs(['--apply', '--repo', repo, '--pr', String(prNumber),
      '--base-head', baseHead, '--epoch', epochId, '--owner-key', ownerKey, ...variantArgs])], {
      cwd: workspace, env: { ...process.env, FIXTURE_NODE: process.execPath, FIXTURE_READER: reader,
        HQ_PYTHON3: '/fixture-override', HQ_PYTHON3_CANDIDATES_FOR_TEST: '/fixture-test-override' },
      encoding: 'utf8', timeout: 15_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const readerError = existsSync(diagnostic) ? readFileSync(diagnostic, 'utf8') : '';
      throw new Error(`${result.stderr.trim()}\n${readerError}`.trim());
    }
    return JSON.parse(result.stdout);
  };
  const read = () => readFileSync(path, 'utf8');
  return { root, ledger, path, proof, attempt, read, write };
}

test('a committed CWP fence retires only the old reservation on the same PR with a moved head', t => {
  const f = fixture(t, undefined, cwpIdentity);
  const result = f.attempt();
  const expected = structuredClone(f.ledger);
  Object.assign(expected.repairEpochs[1], { terminalAt: result.epoch.terminalAt,
    terminalReason: 'canonical-enqueue-fenced', enqueueFenceReceipt: f.proof });
  assert.deepEqual(JSON.parse(f.read()), expected);
  assert.equal(pendingRepairEpoch(f.root, cwpIdentity), null);
});

test('ledger absence retires the CWP reservation without boot evidence or review binding', t => {
  const f = fixture(t, undefined, absenceIdentity);
  const result = f.attempt();
  const expected = structuredClone(f.ledger);
  Object.assign(expected.repairEpochs[1], { terminalAt: result.epoch.terminalAt,
    terminalReason: 'canonical-enqueue-fenced', enqueueFenceReceipt: f.proof });
  assert.deepEqual(JSON.parse(f.read()), expected);
  assert.equal(pendingRepairEpoch(f.root, absenceIdentity), null);
  assert.equal(bindRepairHead({ ...absenceIdentity, rootDir: f.root, headSha: absenceIdentity.currentHead }), null);
});

test('ledger absence refuses a transport fault, recent reservation, live owner and competing lease', t => {
  const f = fixture(t, undefined, absenceIdentity);
  const before = f.read();
  assert.throws(() => f.attempt(f.proof, 'unavailable'), /current-evidence-unavailable/);
  const recentProof = structuredClone(f.proof);
  recentProof.recordedAt = recentProof.evidence.reservedAt;
  assert.throws(() => f.attempt(recentProof), /proof-mismatch/);
  const current = { ...absenceIdentity, headSha: absenceIdentity.currentHead };
  const lease = amaCloserLeaseFilePath(f.root, current);
  f.write(lease, { ...current, status: 'pending' });
  assert.throws(() => f.attempt(), /closer-owned-or-unknown/);
  rmSync(lease);
  const release = tryAcquireCloserIntentLock(f.root, absenceIdentity);
  try { assert.throws(() => f.attempt(), /closer-submission-owned/); }
  finally { release(); }
  assert.equal(f.read(), before);
  const epoch = f.ledger.repairEpochs[1];
  epoch.ownerState = 'live';
  f.write(f.path, f.ledger);
  assert.throws(() => f.attempt(), /reservation-mismatch/);
  epoch.ownerState = 'unknown';
  epoch.reservedAt = new Date().toISOString();
  f.write(f.path, f.ledger);
  assert.throws(() => f.attempt(), /repair-reservation-grace-active/);
  assert.deepEqual(JSON.parse(f.read()), f.ledger);
});

test('CWP retirement keeps both PR locks and rechecks custody after the read', t => {
  const f = fixture(t, undefined, cwpIdentity);
  const before = f.read();
  const release = tryAcquireCloserIntentLock(f.root, cwpIdentity);
  try {
    assert.throws(() => f.attempt(), /closer-submission-owned/);
  } finally { release(); }
  updateHammerRetryCapLedger(f.root, cwpIdentity, () => {
    assert.throws(() => f.attempt(), /hammer retry ledger busy/);
    return null;
  });
  assert.throws(() => f.attempt(f.proof, 'queue-follow-up'), /remediation-owned/);
  assert.equal(f.read(), before);
});

test('CWP retirement rejects mismatched proof kinds, heads, provenance and fence keys', t => {
  const f = fixture(t, undefined, cwpIdentity);
  const before = f.read();
  for (const mutate of [
    proof => { proof.kind = 'legacy-repair-retirement-proof'; },
    proof => { proof.kind = 'cwp-repair-fence-inspection'; },
    proof => { proof.evidence.currentHead = 'd'.repeat(40); },
    proof => { proof.evidence.branch = ''; },
    proof => { proof.evidence.submitter.workerId = 'codex-conflict-pr-17-rebase-1234abcd'; },
    proof => { proof.evidence.submitter.bootTraceOffset++; },
    proof => { delete proof.evidence.submitter.bootTraceSha256; },
    proof => { delete proof.absenceProof.selector.repair_epoch_id; },
    proof => { delete proof.enqueueFence.epochId; },
  ]) {
    const proof = structuredClone(f.proof);
    mutate(proof);
    assert.throws(() => f.attempt(proof), /committed-enqueue-fence-proof-mismatch/);
    assert.equal(f.read(), before);
  }
});

test('CWP reservation and selectors must identify the same native conflict submission', t => {
  const f = fixture(t, undefined, cwpIdentity);
  const before = f.read();
  for (const [flag, value] of [
    ['--owner-key', cwpIdentity.ownerKey + '-retry'],
    ['--current-head', cwpIdentity.baseHead],
    ['--conflict-worker-id', 'codex-conflict-pr-18-rebase-a1b2c3d4'],
    ['--boot-trace-offset', '9007199254740993'],
  ]) {
    assert.throws(() => f.attempt(f.proof, 'unavailable', args => {
      args[args.indexOf(flag) + 1] = value;
      return args;
    }), /required:/);
    assert.equal(f.read(), before);
  }
  assert.throws(() => f.attempt(f.proof, 'unavailable', args => [...args, '--handoff-round', '3']),
    /exact CWP selector/);
  f.ledger.repairEpochs[1].cause = 'closure-retry-exhausted';
  f.write(f.path, f.ledger);
  const changed = f.read();
  assert.throws(() => f.attempt(f.proof, 'unavailable'), /cwp-repair-reservation-mismatch/);
  assert.equal(f.read(), changed);
});

test('a closer at the CWP current head retains custody', t => {
  const f = fixture(t, undefined, cwpIdentity);
  const current = { ...cwpIdentity, headSha: cwpIdentity.currentHead };
  f.write(amaCloserLeaseFilePath(f.root, current), { ...current, status: 'pending' });
  const before = f.read();
  assert.throws(() => f.attempt(f.proof, 'unavailable'), /closer-owned-or-unknown/);
  assert.equal(f.read(), before);
});

test('a committed fence retires exactly one legacy reservation and retains the complete cap ledger', t => {
  const f = fixture(t);
  const result = f.attempt();
  const expected = structuredClone(f.ledger);
  const epoch = expected.repairEpochs[1];
  assert.ok(Date.parse(result.epoch.terminalAt));
  Object.assign(epoch, { terminalAt: result.epoch.terminalAt, terminalReason: 'canonical-enqueue-fenced',
    enqueueFenceReceipt: f.proof });
  assert.deepEqual(JSON.parse(f.read()), expected);
  assert.equal(pendingRepairEpoch(f.root, identity), null);
  const settled = f.read();
  assert.throws(() => f.attempt(f.proof, 'unavailable'), /reservation-mismatch/);
  assert.equal(f.read(), settled);
  const reserve = ownerKey => reserveRepairEpoch({ ...identity, rootDir: f.root, headSha: identity.baseHead,
    ownerKey, cause: 'closure-retry-exhausted' });
  assert.equal(reserve(identity.ownerKey).reason, 'repair-worker-terminal');
  assert.equal(reserve('different-owner').reason, 'repair-epoch-cap');
});

test('watcher observation changes do not change the reservation selected for retirement', t => {
  const f = fixture(t, epoch => Object.assign(epoch, {
    ownerObservedAt: '2026-11-21T00:31:00Z', ownerState: 'absent-unfenced', absentObservations: 42,
  }));
  assert.equal(f.attempt().ok, true);
  const epoch = JSON.parse(f.read()).repairEpochs[1];
  assert.equal(epoch.absentObservations, 42);
  assert.equal(epoch.ownerState, 'absent-unfenced');
});

test('reader refusals retain safe reason codes and redact unexpected stderr', t => {
  const f = fixture(t);
  assert.throws(() => f.attempt(f.proof, 'refused'),
    { message: 'repair-fence-refused:committed-enqueue-fence-required' });
  assert.throws(() => f.attempt(f.proof, 'refused-with-warning'),
    { message: 'repair-fence-refused:committed-enqueue-fence-required' });
  assert.throws(() => f.attempt(f.proof, 'private-error'),
    { message: 'canonical-committed-repair-fence-or-current-evidence-unavailable' });
  assert.deepEqual(JSON.parse(f.read()), f.ledger);
});

test('unreadable merge leases already fail closed before the canonical reader runs', t => {
  const f = fixture(t);
  const path = mergeLeaseFilePath(f.root, { repo: identity.repo, base: 'main' });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{"repo":');
  assert.throws(() => readMergeLeaseHolders({ rootDir: f.root, ...identity }), SyntaxError);
  assert.throws(() => f.attempt(f.proof, 'unavailable'), /JSON/);
  assert.deepEqual(JSON.parse(f.read()), f.ledger);
});

test('strict dispatch reads accept settled dispatches under renamed repository aliases', t => {
  const f = fixture(t);
  const oldRepo = 'fixture/old-widgets';
  f.write(join(f.root, 'data/repository-names.json'), [
    { repository_id: 1, name: oldRepo, current: identity.repo },
    { repository_id: 1, name: identity.repo, current: identity.repo },
  ]);
  const dispatch = amaCloserDispatchFilePath(f.root, { ...identity, repo: oldRepo.toUpperCase(), headSha: identity.baseHead });
  const record = { ...identity, repo: oldRepo.toUpperCase(), state: 'merged' };
  f.write(dispatch, record);
  // A settled historical dispatch does not refuse solely for its old name.
  assert.equal(f.attempt().ok, true);
});

test('a renamed live dispatch still blocks retirement and a foreign payload refuses', t => {
  const f = fixture(t);
  const oldRepo = 'fixture/old-widgets';
  f.write(join(f.root, 'data/repository-names.json'), [
    { repository_id: 1, name: oldRepo, current: identity.repo },
  ]);
  const dispatch = amaCloserDispatchFilePath(f.root, { ...identity, repo: oldRepo, headSha: identity.baseHead });
  f.write(dispatch, { ...identity, repo: oldRepo.toUpperCase(), state: 'dispatched' });
  assert.throws(() => f.attempt(f.proof, 'unavailable'), /closer-owned-or-unknown/);
  f.write(dispatch, { ...identity, repo: 'foreign/repo', state: 'merged' });
  assert.throws(() => f.attempt(f.proof, 'unavailable'), /identity mismatch/);
  assert.deepEqual(JSON.parse(f.read()), f.ledger);
});

for (const [name, change] of [
  ['missing proof', () => null],
  ['point-in-time absence', proof => ({ evidence: proof.evidence, canonicalAbsence: true, enqueueFenced: true })],
  ['wrong receipt version', proof => { proof.version = 2; }],
  ['wrong repository', proof => { proof.evidence.repo = 'foreign/widgets'; }],
  ['wrong PR', proof => { proof.evidence.prNumber++; }],
  ['wrong exact head', proof => { proof.evidence.baseHead = 'c'.repeat(40); }],
  ['wrong epoch', proof => { proof.evidence.epochId = 'foreign'; }],
  ['wrong owner', proof => { proof.evidence.ownerKey = 'foreign'; }],
  ['wrong reservation date', proof => { proof.evidence.reservedAt = proof.recordedAt; }],
  ['wrong submitter provenance', proof => { proof.evidence.submitter.provenanceRef = 'foreign'; }],
  ['missing submitter digest', proof => { delete proof.evidence.submitter.sha256; }],
  ['missing reservation digest', proof => { delete proof.evidence.reservationSha256; }],
  ['guessed project', proof => { proof.absenceProof.selector.project_ref = 'guessed-project'; }],
  ['filtered absence', proof => { proof.absenceProof.scope = 'single-project'; }],
  ['wrong fenced key', proof => { proof.enqueueFence.ownerKey = 'foreign'; }],
]) test(`refuses ${name} before recording any retirement`, t => {
  const f = fixture(t);
  const before = f.read();
  const changed = change(f.proof);
  assert.throws(() => f.attempt(changed === undefined ? f.proof : changed), /proof-mismatch/);
  assert.equal(f.read(), before);
});

for (const [name, change] of [
  ['live owner', epoch => { epoch.ownerState = 'live'; }],
  ['identified unknown owner', epoch => { epoch.ownerLaunch = 'unknown-lrq'; }],
  ['retry descendant', epoch => { epoch.retryLaunches = ['queued-lrq']; }],
  ['bound review', epoch => { epoch.reviewHead = 'c'.repeat(40); }],
  ['publication', epoch => { epoch.publicationHead = 'c'.repeat(40); }],
  ['unresolved publisher', epoch => { epoch.publisherObservation = { operatorRequired: true }; }],
  ['scoped reservation', epoch => { epoch.dispatchProjectRef = 'original-project'; }],
  ['competing reservation', (epoch, ledger) => ledger.repairEpochs.push({ ...epoch, id: 'replacement' })],
  ['duplicated epoch identity', (epoch, ledger) => { ledger.repairEpochs[0].id = epoch.id; }],
  ['ambiguous base', epoch => { epoch.baseHead = 'c'.repeat(40); }],
]) test(`refuses ${name} before reading the canonical store`, t => {
  const f = fixture(t, change);
  const before = f.read();
  assert.throws(() => f.attempt(f.proof, 'unavailable'), /reservation-mismatch/);
  assert.equal(f.read(), before);
});

test('retirement uses the shared PR intent and repair ledger locks', t => {
  const f = fixture(t);
  const release = tryAcquireCloserIntentLock(f.root, identity);
  try {
    assert.throws(() => f.attempt(f.proof, 'unavailable'), /closer-submission-owned/);
  } finally { release(); }
  updateHammerRetryCapLedger(f.root, identity, () => {
    assert.throws(() => f.attempt(f.proof, 'unavailable'), /hammer retry ledger busy/);
    return null;
  });
  assert.equal(f.attempt().ok, true);
  assert.equal(bindRepairHead({ ...identity, rootDir: f.root, headSha: 'e'.repeat(40) }), null);
});

test('a queued follow-up arriving during the read is retained and blocks retirement', t => {
  const f = fixture(t);
  const before = f.read();
  const waiting = join(getFollowUpJobDir(f.root, 'pending'), 'misfiled.json');
  const job = { repo: identity.repo, prNumber: identity.prNumber, jobId: 'live-follow-up' };
  assert.throws(() => f.attempt(f.proof, 'queue-follow-up'), /remediation-owned/);
  assert.deepEqual(JSON.parse(readFileSync(waiting, 'utf8')), job);
  assert.equal(f.read(), before);
});

test('an unreceipted closer intent or a paused older-head closer retains custody', t => {
  const f = fixture(t);
  const leaseIdentity = { ...identity, headSha: 'e'.repeat(40) };
  const dispatch = amaCloserDispatchFilePath(f.root, leaseIdentity);
  f.write(dispatch, { ...leaseIdentity, state: 'dispatch-interrupted' });
  assert.throws(() => f.attempt(f.proof, 'unavailable'), /closer-owned-or-unknown/);
  f.write(dispatch, { ...leaseIdentity, state: 'dispatched' });
  assert.throws(() => f.attempt(f.proof, 'unavailable'), /closer-owned-or-unknown/);
  rmSync(dispatch);
  f.write(amaCloserLeaseFilePath(f.root, leaseIdentity), { ...leaseIdentity, status: 'pending' });
  assert.throws(() => f.attempt(f.proof, 'unavailable'), /closer-owned-or-unknown/);
  assert.deepEqual(JSON.parse(f.read()), f.ledger);
});

test('the command has no unsigned proof input', () => {
  const cli = fileURLToPath(cliSource);
  const result = spawnSync(process.execPath, [cli, '--receipt', '/tmp/unsigned.json'],
    { encoding: 'utf8', input: '{"kind":"legacy-repair-retirement-proof"}', timeout: 5_000 });
  assert.equal(result.status, 75);
  assert.match(result.stderr, /Unknown option/);
});

test('canonical read-only bridge enforces operator, ledger, receipt and current evidence boundaries', () => {
  const fixturePath = fileURLToPath(new URL('fixtures/legacy-repair-fence-reader.py', import.meta.url));
  const result = spawnSync('python3', ['-B', fixturePath], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
});

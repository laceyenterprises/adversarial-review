import './helpers/dispatch-read-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCustodyRedriveTarget } from '../src/ama/custody-redrive.mjs';
import { __testables__ } from '../src/ama/dispatch-closer.mjs';
import { continueDeferredSourceCustody, deferredProcessInspectionUnavailable, deferredSourceNeedsDecision,
  deferredSourceStatus, readDeferredSourceHold, retainDeferredControllerCleanup,
  startDeferredSourceCustody, readDeferredSourceRedrive, reserveDeferredSourceRedrive,
  completeDeferredSourceRedrive, deferredSourceRedriveObservation,
  refundDeferredSourceRedrive } from '../src/ama/deferred-source-custody.mjs';
import { observeDeferredSourceDecision } from '../src/ama/closer-successor.mjs';
import { closerInconclusiveRetryFilePath, recordCloserInconclusiveRetry } from '../src/ama/closer-inconclusive-retry.mjs';

const dispatchHead = 'a'.repeat(40);
const liveHead = 'b'.repeat(40);
const sourceHead = 'c'.repeat(40);
const launchRequestId = 'lrq_custody';
const repo = 'synthetic/repo';
const prNumber = 42;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'deferred-custody-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { HAM_HQ_ROOT: root, HAM_REPO: repo, HAM_PR_NUMBER: String(prNumber),
    HAM_TARGET_REMEDIATION_SHA: dispatchHead, HAM_CLOSE_VALIDATION_REMOTE_HEAD: liveHead };
  const dir = startDeferredSourceCustody({ env, launchRequestId, sourceHead });
  const identity = { repo, prNumber, headSha: liveHead };
  const workspace = join(root, 'workers', 'hammer-ama-pr-42', 'checkout');
  mkdirSync(workspace, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
  git('init', '-q');
  const hold = readDeferredSourceHold(root, identity);
  writeFileSync(hold.path, JSON.stringify({ ...JSON.parse(readFileSync(hold.path)), workspace }));
  return { root, dir, identity, git, workspace, hold: readDeferredSourceHold(root, identity) };
}

function teardown(f, tearDown) {
  return __testables__.cleanupHammerCloserWorker({
    prNumber, hqRoot: f.root, hqPath: '/fixture/hq', reason: 'ended', logger: {},
    existingRecord: { repo, headSha: dispatchHead, targetRemediationSha: dispatchHead,
      launchRequestId, workerClass: 'hammer', workerId: 'hammer-ama-pr-42' },
    execFileImpl: async () => tearDown(), cleanupScratchImpl() {},
  });
}

test('mixed-case heads share a custody marker and drain retains diagnostics from a relative receipt', async t => {
  const root = mkdtempSync(join(tmpdir(), 'deferred-custody-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const controller = 'controller-fixture.json';
  const env = { HAM_HQ_ROOT: root, HAM_RUN_DIR: root, HAM_REPO: repo, HAM_PR_NUMBER: String(prNumber),
    HAM_CLOSE_VALIDATION_REMOTE_HEAD: liveHead.toUpperCase(), HAM_CONTROLLER_RECORD: join(root, controller) };
  const dir = startDeferredSourceCustody({ env, launchRequestId, sourceHead: liveHead.toUpperCase() });
  const identity = { repo, prNumber, headSha: liveHead.toUpperCase() };
  const hold = readDeferredSourceHold(root, identity);
  assert.equal(hold.sourceHead, liveHead);
  assert.equal(readDeferredSourceHold(root, { ...identity, headSha: liveHead }).path, hold.path);

  const name = 'checks.json';
  const log = join(root, `${name}.check-1.log`);
  writeFileSync(log, 'retained output');
  writeFileSync(join(root, name), JSON.stringify({ head: liveHead, checks: [{ diagnostics: [{ path: log }] }] }));
  writeFileSync(join(root, `validation-deferred-${liveHead}.json`), JSON.stringify({
    schemaVersion: 1, head: liveHead, localValidationReceipt: name,
  }));
  writeFileSync(join(root, `deferred-controller-${controller}`), JSON.stringify({ headSha: liveHead }));
  await retainDeferredControllerCleanup(env, env.HAM_CONTROLLER_RECORD, { launchRequestId, drained: true });
  assert.equal(readFileSync(join(dir, `${name}.check-1.log`), 'utf8'), 'retained output');
});

for (const status of ['local-ref-only', 'workspace-only', 'bundled', 'matches-target', 'unconfirmed']) {
  test(`teardown finds a launch's ${status} source under its published head`, async t => {
    const f = fixture(t);
    if (status !== 'unconfirmed') writeFileSync(join(f.dir, 'source.json'), JSON.stringify({ status, bundle: 'source.bundle' }));
    if (status === 'bundled') writeFileSync(join(f.dir, 'source.bundle'), 'fixture');
    let tornDown = false;
    const result = await teardown(f, () => { tornDown = true; });
    const safe = ['bundled', 'matches-target'].includes(status);
    assert.equal(tornDown, safe);
    assert.equal(result.ok, safe);
    if (!safe) assert.equal(result.error, 'deferred-source-retained-in-workspace');
  });
}

test('dirty repair bytes remain in custody despite finished cleanup and a matching target', async t => {
  const f = fixture(t);
  const repair = join(f.workspace, 'repair.bin');
  const bytes = Buffer.from([0, 255, 42]);
  writeFileSync(repair, bytes);
  writeFileSync(f.hold.path, JSON.stringify({ ...JSON.parse(readFileSync(f.hold.path)), sourceHead: liveHead, clean: false }));
  const receipts = {
    'source.json': { status: 'matches-target' },
    'deferred.json': { head: liveHead, validation: 'unknown', reason: 'process-inspection-unavailable', status: 75 },
    'bounded-cleanup.json': { launchRequestId, head: liveHead, cleanup: 'finished' },
  };
  for (const [name, evidence] of Object.entries(receipts)) writeFileSync(join(f.dir, name), JSON.stringify(evidence));
  const hold = await observeDeferredSourceDecision({ rootDir: f.root, hqRoot: f.root, ...f.identity,
    now: '2026-11-23T00:00:00Z', pageImpl: async () => {} });
  assert.equal(hold.needsOperator, true);
  let tornDown = false;
  assert.equal((await teardown(f, () => { tornDown = true; })).ok, false);
  assert.equal(tornDown, false);
  assert.deepEqual(readFileSync(repair), bytes);
  for (const [name, evidence] of Object.entries(receipts)) {
    assert.equal(readFileSync(join(f.dir, name), 'utf8'), JSON.stringify(evidence));
  }
});

for (const refused of [false, true]) {
  test(`clean matching-target custody ${refused ? 'holds for inspection refusal' : 'continues without a refusal'}`, async t => {
    const f = fixture(t);
    writeFileSync(f.hold.path, JSON.stringify({ ...f.hold, sourceHead: liveHead, clean: true }));
    writeFileSync(join(f.dir, 'source.json'), JSON.stringify({ status: 'matches-target' }));
    writeFileSync(join(f.dir, 'bounded-cleanup.json'), JSON.stringify({
      launchRequestId, head: liveHead, cleanup: 'finished',
    }));
    if (refused) writeFileSync(join(f.dir, 'deferred.json'), JSON.stringify({
      head: liveHead, validation: 'unknown', reason: 'process-inspection-unavailable', status: 75,
    }));
    const hold = readDeferredSourceHold(f.root, f.identity);
    assert.equal(deferredSourceNeedsDecision(hold), refused);
    const observed = await observeDeferredSourceDecision({ rootDir: f.root, hqRoot: f.root, ...f.identity,
      now: '2026-11-23T00:00:00Z', pageImpl: async () => {} });
    assert.equal(observed?.needsOperator === true, refused);
    assert.equal(Boolean(JSON.parse(readFileSync(hold.path)).continuedAt), !refused);
    let tornDown = false;
    assert.equal((await teardown(f, () => { tornDown = true; })).ok, true);
    assert.equal(tornDown, true, 'retained clean source permits teardown independently of the inspection hold');
  });
}

test('legacy inspection classification reuses unchanged receipts and invalidates on evidence or head changes', t => {
  const f = fixture(t);
  const path = join(f.dir, 'validation.json');
  const check = { name: 'Telegram responder guard', status: 'failed', result: 'inconclusive',
    diagnostics: [{ exitStatus: 75 }],
    localReason: 'telegram guard lane node: ps unusable in this sandbox: no verdict' };
  writeFileSync(join(f.dir, 'deferred.json'), JSON.stringify({
    head: sourceHead, validation: 'unknown', reason: 'canonical-mirror-environment-unavailable', status: 76,
  }));
  writeFileSync(path, JSON.stringify({ head: sourceHead, checks: [check] }));
  const originalRead = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === path) reads++;
    return originalRead(file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(deferredProcessInspectionUnavailable(f.hold), true);
  assert.equal(deferredProcessInspectionUnavailable(f.hold), true);
  assert.equal(reads, 1);

  const before = fs.statSync(path);
  writeFileSync(path, JSON.stringify({ head: liveHead, checks: [check] }));
  fs.utimesSync(path, before.atime, before.mtime);
  assert.equal(deferredProcessInspectionUnavailable(f.hold), false);
  assert.equal(deferredProcessInspectionUnavailable(f.hold), false);
  assert.equal(reads, 2, 'a same-size rewrite with restored mtime invalidates the cached result');
  writeFileSync(join(f.dir, 'deferred.json'), JSON.stringify({
    head: liveHead, validation: 'unknown', reason: 'canonical-mirror-environment-unavailable', status: 76,
  }));
  assert.equal(deferredProcessInspectionUnavailable({ ...f.hold, sourceHead: liveHead }), true);
  assert.equal(reads, 3, 'the source head is part of the cache identity');
  rmSync(path);
  assert.equal(deferredProcessInspectionUnavailable({ ...f.hold, sourceHead: liveHead }), false);
  writeFileSync(path, '{broken');
  assert.equal(deferredProcessInspectionUnavailable({ ...f.hold, sourceHead: liveHead }), false);
});

test('custody notices refresh on final evidence, retry delivery and deduplicate unchanged evidence', async t => {
  const f = fixture(t);
  const pages = [];
  let refuse = false;
  const options = { rootDir: f.root, hqRoot: f.root, ...f.identity, now: '2026-11-23T00:00:00Z',
    pageImpl: async (text, metadata) => {
      if (refuse) throw new Error('fixture delivery refused');
      pages.push({ text, metadata });
    }, logger: {} };
  await observeDeferredSourceDecision(options);
  assert.match(pages[0].text, /source unconfirmed, cleanup unconfirmed/);
  writeFileSync(join(f.dir, 'source.json'), JSON.stringify({ status: 'bundled', bundle: 'source.bundle' }));
  writeFileSync(join(f.dir, 'source.bundle'), 'fixture');
  writeFileSync(join(f.dir, 'bounded-cleanup.json'), JSON.stringify({
    head: sourceHead, launchRequestId, cleanup: 'finished',
  }));
  refuse = true;
  await observeDeferredSourceDecision(options);
  refuse = false;
  await observeDeferredSourceDecision(options);
  await observeDeferredSourceDecision(options);
  assert.equal(pages.length, 2);
  assert.match(pages[1].text, /source bundled, cleanup recorded finished/);
  assert.notEqual(pages[0].metadata.dedupKey, pages[1].metadata.dedupKey);
});

test('a corrupt legacy retry record does not hold heads without custody evidence', async t => {
  const f = fixture(t);
  rmSync(f.hold.path);
  const path = closerInconclusiveRetryFilePath(f.root, f.identity);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{broken');
  let paged = false;
  const result = await observeDeferredSourceDecision({ rootDir: f.root, hqRoot: f.root, ...f.identity,
    now: '2026-11-23T00:00:00Z', pageImpl: async () => { paged = true; } });
  assert.equal(result, null);
  assert.equal(paged, false);
});

test('continued custody retains evidence and ignores even a legacy deferred fallback', async t => {
  const f = fixture(t);
  recordCloserInconclusiveRetry(f.root, { ...f.identity, launchRequestId,
    reason: 'canonical-validation-deferred', now: '2026-11-23T00:00:00Z' });
  assert.equal(continueDeferredSourceCustody(f.hold), false, 'incomplete source must retain its active marker');
  writeFileSync(join(f.dir, 'source.json'), JSON.stringify({ status: 'bundled', bundle: 'source.bundle' }));
  writeFileSync(join(f.dir, 'source.bundle'), 'fixture');
  assert.equal(continueDeferredSourceCustody(f.hold), true);
  assert.equal(readDeferredSourceHold(f.root, f.identity), null);
  assert.ok(JSON.parse(readFileSync(f.hold.path, 'utf8')).continuedAt);
  assert.equal(await observeDeferredSourceDecision({ rootDir: f.root, hqRoot: f.root, ...f.identity,
    pageImpl: async () => assert.fail('continued custody must not page') }), null);
  const next = startDeferredSourceCustody({ env: { HAM_HQ_ROOT: f.root, HAM_REPO: repo,
    HAM_PR_NUMBER: String(prNumber), HAM_TARGET_REMEDIATION_SHA: liveHead },
  launchRequestId: 'lrq_next', sourceHead });
  assert.notEqual(next, f.dir);
  assert.equal(readDeferredSourceHold(f.root, f.identity).launchRequestId, 'lrq_next');
  assert.ok(JSON.parse(readFileSync(join(f.dir, 'continued-hold.json'), 'utf8')).continuedAt);
  assert.throws(() => continueDeferredSourceCustody(f.hold), /identity changed/);
  assert.equal(readDeferredSourceHold(f.root, f.identity).launchRequestId, 'lrq_next');
});

test('teardown retries retention and bundles source without unavailable prerequisite objects', async t => {
  const f = fixture(t);
  const { git, workspace } = f;
  git('init', '-q');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'source');
  const head = git('rev-parse', 'HEAD');
  writeFileSync(f.hold.path, JSON.stringify({ ...JSON.parse(readFileSync(f.hold.path)), workspace, sourceHead: head, clean: true }));
  writeFileSync(join(f.dir, 'source.json'), JSON.stringify({ status: 'local-ref-only' }));
  let tornDown = false;
  await teardown(f, () => { tornDown = true; });
  assert.equal(tornDown, true);
  const retained = JSON.parse(readFileSync(join(f.dir, 'source.json')));
  assert.equal(retained.status, 'bundled');
  assert.deepEqual(retained.prerequisites, []);
  assert.match(git('bundle', 'list-heads', join(f.dir, 'source.bundle')), new RegExp(`^${head} `));
  assert.equal(git('for-each-ref', 'refs/hammer/deferred/'), '');
});

test('teardown fences the recorded workspace and paces failed retention', async t => {
  const f = fixture(t);
  const record = JSON.parse(readFileSync(f.hold.path));
  writeFileSync(f.hold.path, JSON.stringify({ ...record, workspace: f.root }));
  const rejectTeardown = () => assert.fail('source is not safe to release');
  assert.equal((await teardown(f, rejectTeardown)).ok, false);
  assert.equal(JSON.parse(readFileSync(f.hold.path)).lastRetentionAttemptAt, undefined);
  writeFileSync(f.hold.path, JSON.stringify(record));
  assert.equal((await teardown(f, rejectTeardown)).ok, false);
  assert.ok(JSON.parse(readFileSync(f.hold.path)).lastRetentionAttemptAt);
  writeFileSync(join(f.dir, 'source.json'), JSON.stringify({ status: 'local-ref-only' }));
  assert.equal((await teardown(f, rejectTeardown)).ok, false);
  assert.equal(deferredSourceStatus(f.hold), 'local-ref-only', 'the next pass must not run retention again');
});

test('a continued exact published source allows teardown without a bundle', async t => {
  const f = fixture(t);
  assert.equal(continueDeferredSourceCustody(f.hold, { publishedHead: sourceHead }), true);
  let tornDown = false;
  assert.equal((await teardown(f, () => { tornDown = true; })).ok, true);
  assert.equal(tornDown, true);
});

test('missing source receipt infers only a clean matching target', t => {
  const f = fixture(t);
  assert.equal(deferredSourceStatus({ ...f.hold, sourceHead: liveHead }), 'matches-target');
  assert.equal(deferredSourceStatus({ ...f.hold, sourceHead: liveHead, clean: false }), 'workspace-only');
  writeFileSync(join(f.dir, 'source.json'), '{broken');
  assert.equal(deferredSourceStatus({ ...f.hold, sourceHead: liveHead }), 'unconfirmed');
});

test('the watcher defers under lock contention while explicit completion can wait', async t => {
  const f = fixture(t);
  writeFileSync(join(f.dir, 'source.json'), JSON.stringify({ status: 'matches-target' }));
  writeFileSync(join(f.dir, 'bounded-cleanup.json'), JSON.stringify({ head: sourceHead, launchRequestId, cleanup: 'finished' }));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fsExt from 'fs-ext';
    import { openSync, closeSync } from 'node:fs';
    const fd = openSync(process.argv[1], 'a');
    fsExt.flockSync(fd, 'ex');
    process.stdout.write('locked');
    process.stdin.once('data', () => setTimeout(() => closeSync(fd), 200));
  `, `${f.hold.path}.lock`], { cwd: new URL('..', import.meta.url), stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { child.kill(); });
  const closed = once(child, 'close');
  const ready = await Promise.race([once(child.stdout, 'data'), closed.then(() => [])]);
  assert.equal(String(ready[0]), 'locked', 'fs-ext child must lock before exiting');
  const watcher = await observeDeferredSourceDecision({ rootDir: f.root, hqRoot: f.root, ...f.identity });
  assert.equal(watcher?.recoveryWait, true);
  child.stdin.end('release');
  assert.equal(continueDeferredSourceCustody(f.hold, { publishedHead: sourceHead }), true);
  assert.equal((await closed)[0], 0);
  assert.ok(JSON.parse(readFileSync(f.hold.path)).continuedAt);
});


test('custody retry CLI preserves PR commits and settles publication', t => exerciseCustodyRetry(t));
test('custody retry CLI records a refusal when the PR head moves before prepare', t => exerciseCustodyRetry(t, 'moved'));
test('custody retry CLI parks a base conflict', t => exerciseCustodyRetry(t, 'base'));
test('custody retry CLI parks a failed canonical check', t => exerciseCustodyRetry(t, 'validation'));
test('custody fast-forward publishes after the base advances', t => exerciseCustodyRetry(t, 'fast-forward-base-move'));
test('custody rewrite refuses publication after the base advances', t => exerciseCustodyRetry(t, 'rewrite-base-move'));

test('disabled re-drive surfaces an exact-head bundle without waiting for admission', async t => {
  const f = fixture(t);
  writeFileSync(f.hold.path, JSON.stringify({ ...f.hold, clean: true }));
  writeFileSync(join(f.dir, 'source.bundle'), 'fixture');
  writeFileSync(join(f.dir, 'source.json'), JSON.stringify({ status: 'bundled', bundle: 'source.bundle',
    ref: `refs/hammer/deferred/${launchRequestId}/${sourceHead}` }));
  writeFileSync(join(f.dir, 'bounded-cleanup.json'), JSON.stringify({ launchRequestId, head: sourceHead, cleanup: 'finished' }));
  const notices = [];
  const options = { rootDir: f.root, hqRoot: f.root, ...f.identity,
    now: '2026-11-23T00:00:00Z', observeWaitImpl: async ({ reason }) => notices.push(reason) };
  assert.equal((await observeDeferredSourceDecision(options)).status, 'custody-redrive-pending');
  const decision = await observeDeferredSourceDecision({ ...options, enabled: false });
  assert.equal(decision.needsOperator, true);
  assert.equal(decision.custodyPath, f.hold.path);
  assert.equal(await observeDeferredSourceDecision({ ...options, headSha: dispatchHead }), null);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /recovery is disabled/);
});

test('custody refunds only its own unlaunched reservation and surfaces once at the retry ceiling', async t => {
  const f = fixture(t);
  writeFileSync(f.hold.path, JSON.stringify({ ...JSON.parse(readFileSync(f.hold.path)), clean: true }));
  writeFileSync(join(f.dir, 'source.bundle'), 'fixture');
  writeFileSync(join(f.dir, 'source.json'), JSON.stringify({ status: 'bundled', bundle: 'source.bundle',
    ref: `refs/hammer/deferred/${launchRequestId}/${sourceHead}` }));
  writeFileSync(join(f.dir, 'bounded-cleanup.json'), JSON.stringify({ launchRequestId, head: sourceHead, cleanup: 'finished' }));
  const retryPolicy = { surfaceAfterAttempts: 2, backoffBaseMs: 1_000, backoffMaxMs: 4_000 };
  const read = () => readDeferredSourceRedrive(f.root, f.identity);
  const reserve = (pending, now) => reserveDeferredSourceRedrive(pending, { now, policy: retryPolicy, headSha: liveHead });
  const original = read();
  const refusedLaunch = reserve(original, 1_000);
  assert.equal(refundDeferredSourceRedrive(original, refusedLaunch), true);
  assert.equal(read().source.redrive, undefined);
  const launched = reserve(original, 1_000);
  assert.equal(launched.count, 1);
  assert.equal(refundDeferredSourceRedrive(original, refusedLaunch), false);
  assert.equal(reserve(read(), 1_999), null);
  assert.equal(reserve(read(), 2_000).count, 2);
  const exhausted = read();
  assert.equal(reserve(exhausted, 10_000), null);
  assert.equal(deferredSourceRedriveObservation(exhausted, liveHead, retryPolicy), null);
  const pages = [];
  const options = { rootDir: f.root, hqRoot: f.root, ...f.identity, retryPolicy,
    now: '2026-11-23T00:00:00Z', pageImpl: async message => pages.push(message) };
  for (let pass = 0; pass < 3; pass++) {
    assert.equal((await observeDeferredSourceDecision(options)).status, 'canonical-validation-operator-decision');
  }
  assert.equal(pages.length, 1);
  assert.match(pages[0], /attempt limit was reached/);
});

async function exerciseCustodyRetry(t, failure) {
  const f = fixture(t);
  const git = f.git;
  git('config', 'user.name', 'Synthetic Builder');
  git('config', 'user.email', 'synthetic@example.test');
  function commit(file, contents = file) {
    writeFileSync(join(f.workspace, file), `${contents}\n`);
    git('add', file);
    git('commit', '-qm', file);
    return git('rev-parse', 'HEAD');
  }
  const fork = commit('initial.txt');
  const rewrite = failure === 'rewrite-base-move';
  const rewriteBase = rewrite ? commit('base-for-replay.txt') : null;
  if (rewrite) git('switch', '-qd', fork);
  const originalTarget = commit('builder.txt');
  if (rewrite) {
    git('switch', '-qd', rewriteBase);
    git('cherry-pick', originalTarget);
  }
  const retained = commit('retained.txt');
  const ref = `refs/hammer/deferred/${launchRequestId}/${retained}`;
  const identity = { repo, prNumber, headSha: originalTarget };
  const dir = startDeferredSourceCustody({ env: { HAM_HQ_ROOT: f.root, HAM_REPO: repo,
    HAM_PR_NUMBER: String(prNumber), HAM_TARGET_REMEDIATION_SHA: originalTarget },
  launchRequestId, sourceHead: retained, clean: true });
  git('update-ref', ref, retained);
  git('bundle', 'create', join(dir, 'source.bundle'), ref, `^${originalTarget}`);
  git('update-ref', '-d', ref);
  writeFileSync(join(dir, 'source.json'), JSON.stringify({ status: 'bundled', ref, bundle: 'source.bundle',
    prerequisites: [originalTarget] }));
  writeFileSync(join(dir, 'bounded-cleanup.json'), JSON.stringify({ launchRequestId, head: retained, cleanup: 'finished' }));

  git('switch', '-qd', originalTarget);
  const movedHead = commit('new-pr-edit.txt');
  git('switch', '-qd', fork);
  const base = rewriteBase ?? commit(failure === 'base' ? 'builder.txt' : 'new-base-edit.txt', 'base edit');
  const remote = join(f.root, 'synthetic-origin.git');
  git('init', '-q', '--bare', remote);
  git('push', '-q', remote, `${originalTarget}:refs/heads/synthetic-pr`, `${base}:refs/heads/main`);
  const checkout = join(f.root, 'retry-checkout');
  git('clone', '-q', '--branch', 'synthetic-pr', remote, checkout);
  const recoveryGit = (...args) => execFileSync('git', args, {
    cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  recoveryGit('config', 'user.name', 'Synthetic Closer');
  recoveryGit('config', 'user.email', 'closer@example.test');
  assert.throws(() => recoveryGit('cat-file', '-e', `${retained}^{commit}`), 'only the bundle carries the retained commit');
  const movedIdentity = { ...identity, headSha: movedHead };
  const policy = { surfaceAfterAttempts: 3, backoffBaseMs: 1_000, backoffMaxMs: 2_000 };
  assert.equal(readDeferredSourceRedrive(f.root, movedIdentity, { includePublished: true }), null);
  let pending = readDeferredSourceRedrive(f.root, identity);
  const reservation = reserveDeferredSourceRedrive(pending, { now: 1_000, policy, headSha: originalTarget });
  assert.equal(reservation.count, 1);
  assert.equal(reserveDeferredSourceRedrive(pending, { now: 1_000, policy, headSha: originalTarget }), null);
  pending = readDeferredSourceRedrive(f.root, identity);
  assert.equal(reserveDeferredSourceRedrive(pending, { now: 1_500, policy, headSha: originalTarget }), null);

  const fixtureBin = join(f.root, 'bin');
  const responses = join(f.root, 'pr-responses.json');
  mkdirSync(fixtureBin);
  writeFileSync(join(fixtureBin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const assert = require('node:assert/strict');
const file = ${JSON.stringify(responses)};
const expected = ['api', 'repos/${repo}/pulls/${prNumber}'];
const args = process.argv.slice(2);
const wantsHead = args.length === 4;
assert.deepEqual(args, wantsHead ? [...expected, '--jq', '.head.sha'] : expected);
const heads = JSON.parse(fs.readFileSync(file));
assert.ok(heads.length, 'unexpected PR read');
const sha = heads.shift();
fs.writeFileSync(file, JSON.stringify(heads));
if (sha === 'transient') {
  console.error('HTTP 503 (synthetic)');
  process.exit(1);
}
const pr = { state: 'open', merged: false, draft: false, labels: [],
  head: { ref: 'synthetic-pr', sha, repo: { full_name: '${repo}' } },
  base: { ref: 'main', sha: '${base}', repo: { full_name: '${repo}' } } };
console.log(wantsHead ? pr.head.sha : JSON.stringify(pr));
`, { mode: 0o700 });
  writeFileSync(join(fixtureBin, 'git'), `#!/bin/bash
if [[ "\${FIXTURE_GIT_TRANSIENT:-}" = yes && "$1" = push ]]; then
  echo 'RPC failed: early EOF (synthetic)' >&2
  exit 1
fi
export PATH="$FIXTURE_ORIGINAL_PATH"
exec git "$@"
`, { mode: 0o700 });
  writeFileSync(join(f.root, 'custody-redrive.json'), JSON.stringify({
    targetHead: pending.hold.targetHead, attempt: pending.hold.attempt, count: pending.source.redrive.count,
    reservationId: reservation.reservationId,
  }));
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:HAMMER_LACEY_GH_TOKEN|MERGE_AGENT_GH_TOKEN|HQ_ENTITLEMENT_GH_TOKEN|GH_TOKEN|GITHUB_TOKEN)(?:_|$)/.test(key)));
  const env = { ...cleanEnv, PATH: `${fixtureBin}:${process.env.PATH}`,
    FIXTURE_ORIGINAL_PATH: process.env.PATH,
    HAM_RUN_DIR: f.root, HAM_HQ_ROOT: f.root, HAM_REPO: repo, HAM_PR_NUMBER: String(prNumber),
    HAM_TARGET_REMEDIATION_SHA: originalTarget, HAMMER_LACEY_GH_TOKEN: 'fixture-token' };
  function runHelper(helper, expectedReads, ...args) {
    writeFileSync(responses, JSON.stringify(expectedReads));
    const script = fileURLToPath(new URL(`../bin/${helper}.mjs`, import.meta.url));
    const result = spawnSync(process.execPath, [script, ...args], { cwd: checkout, env, encoding: 'utf8', timeout: 10_000 });
    assert.deepEqual(JSON.parse(readFileSync(responses)), [], result.stderr);
    return result;
  }
  const bootstrap = runHelper('hammer-base-head', [originalTarget], `https://github.com/${repo}/pull/${prNumber}`);
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
  assert.equal(bootstrap.stdout.trim(), originalTarget);
  assert.notEqual(originalTarget, base);
  if (failure === 'moved') {
    const moved = runHelper('hammer-custody-redrive', [movedHead], 'prepare');
    assert.equal(moved.status, 75, moved.stderr);
    const source = JSON.parse(readFileSync(join(dir, 'source.json'), 'utf8'));
    assert.equal(source.redrive.refusal, 'retained-target-moved');
    assert.match(moved.stderr, /^hammer custody retry: retained-target-moved$/m);
    assert.equal(recoveryGit('rev-parse', 'HEAD'), originalTarget);
    return;
  }
  // The retained intent pins the PR head independently of the bootstrap value.
  env.HAM_BASE_HEAD = base;
  const prepare = runHelper('hammer-custody-redrive', [originalTarget], 'prepare');
  if (failure === 'base') {
    assert.equal(prepare.status, 75, prepare.stderr);
    assert.equal(recoveryGit('rev-parse', 'HEAD'), originalTarget);
    const refused = readDeferredSourceRedrive(f.root, identity);
    assert.equal(refused.source.redrive.refusal, 'retained-source-conflicts-with-base');
    assert.equal(deferredSourceRedriveObservation(refused, originalTarget, policy), null);
    assert.equal(reserveDeferredSourceRedrive(refused, { now: 20_000, policy, headSha: originalTarget }), null);
    const pages = [];
    const options = { rootDir: f.root, hqRoot: f.root, ...identity, retryPolicy: policy,
      now: '2026-11-23T00:00:00Z', pageImpl: async message => pages.push(message) };
    for (let pass = 0; pass < 3; pass++) {
      assert.equal((await observeDeferredSourceDecision(options)).status, 'canonical-validation-operator-decision');
    }
    assert.equal(pages.length, 1);
    assert.match(pages[0], /retained-source-conflicts-with-base/);
    return;
  }
  assert.equal(prepare.status, 0, prepare.stderr);
  const { head: candidate, ...prepared } = JSON.parse(prepare.stdout);
  assert.deepEqual(prepared, { branch: 'synthetic-pr', previousHead: originalTarget, baseHead: base });
  assert.equal(candidate, retained);
  assert.equal(recoveryGit('merge-base', candidate, base), rewrite ? base : fork);
  if (!rewrite) assert.equal(recoveryGit('rev-parse', `${candidate}^`), originalTarget);
  const receipt = join(f.root, 'validation.json');
  writeFileSync(receipt, JSON.stringify({ head: candidate, status: failure === 'validation' ? 42 : 0,
    checks: [{ result: failure === 'validation' ? 'fail' : 'pass' }] }));
  const validated = runHelper('hammer-custody-redrive', [originalTarget], 'validated', candidate, receipt);
  if (failure === 'validation') {
    assert.equal(validated.status, 75, validated.stderr);
    const stopped = readDeferredSourceRedrive(f.root, identity);
    assert.equal(stopped.source.redrive.refusal, 'retained-source-failed-validation');
    assert.equal(stopped.source.redrive.candidate, undefined);
    assert.equal(deferredSourceRedriveObservation(stopped, originalTarget, policy), null);
    return;
  }
  assert.equal(validated.status, 0, validated.stderr);
  assert.equal(completeDeferredSourceRedrive(pending, movedHead), false);
  assert.equal(readDeferredSourceRedrive(f.root, { ...identity, headSha: candidate }), null);
  assert.equal(readDeferredSourceRedrive(f.root, { ...identity, headSha: candidate },
    { includePublished: true }).source.redrive.candidate, candidate);
  Object.assign(env, { HAM_ROOT_DIR: f.root, HAM_CONTROLLER_RECORD: join(f.root, 'controller.fixture'),
    HAM_CONTROLLER_PID: String(process.pid), HAM_CONTROLLER_TOKEN: 'fixture-controller', HAM_CLOSE_REBASE_HEAD: candidate });
  writeFileSync(env.HAM_CONTROLLER_RECORD, JSON.stringify({ state: 'running', controllerPid: process.pid,
    token: env.HAM_CONTROLLER_TOKEN, startedAt: '2026-11-23T00:00:00Z' }));
  writeFileSync(join(f.root, 'conflict-repair-publish.env'),
    `source=${originalTarget}\nhead=${candidate}\nbranch=synthetic-pr\nbase=${base}\n`);
  const publish = reads => runHelper('hammer-owned-publication', reads, repo, String(prNumber),
    'head', candidate, 'synthetic-pr', originalTarget);
  if (!failure) {
    const ghError = publish(['transient', 'transient', 'transient']);
    assert.equal(JSON.parse(ghError.stdout).phaseOutcome, 'publish-head-read-failed');
    env.FIXTURE_GIT_TRANSIENT = 'yes';
    const gitError = publish([originalTarget, originalTarget]);
    delete env.FIXTURE_GIT_TRANSIENT;
    assert.equal(JSON.parse(gitError.stdout).phaseOutcome, 'publish-head-read-failed');
    const hook = join(remote, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    const rejected = publish([originalTarget, originalTarget]);
    rmSync(hook);
    assert.equal(JSON.parse(rejected.stdout).phaseOutcome, 'source-publication-refused');
  }
  if (failure?.endsWith('base-move')) {
    git('switch', '-qd', base);
    const advancedBase = commit('advanced-base.txt');
    git('push', '-q', remote, `${advancedBase}:refs/heads/main`);
  }
  const publication = publish(rewrite ? [originalTarget] : [originalTarget, originalTarget]);
  if (rewrite) {
    assert.equal(publication.status, 20, publication.stderr);
    assert.equal(JSON.parse(publication.stdout).phaseOutcome, 'head-changed');
    assert.equal(recoveryGit('ls-remote', 'origin', 'refs/heads/synthetic-pr').split('\t')[0], originalTarget);
    return;
  }
  assert.equal(publication.status, 0, publication.stdout + publication.stderr);
  assert.equal(JSON.parse(publication.stdout).route, 'published');
  const published = recoveryGit('ls-remote', 'origin', 'refs/heads/synthetic-pr').split('\t')[0];
  assert.equal(published, candidate);
  for (const reads of [[originalTarget, movedHead], [originalTarget, originalTarget, originalTarget]]) {
    const observed = reads.at(-1);
    const unconfirmed = runHelper('hammer-custody-redrive', reads, 'complete', candidate);
    assert.equal(unconfirmed.status, 75, unconfirmed.stderr);
    assert.ok(unconfirmed.stderr.includes(`live head ${observed} did not match candidate ${candidate}`));
    assert.match(unconfirmed.stderr, observed === originalTarget
      ? /PR API still reports the source head/ : /PR head diverged from the source and candidate/);
    assert.equal(deferredSourceStatus(pending.hold), 'bundled');
  }
  const completed = runHelper('hammer-custody-redrive', [originalTarget, originalTarget, candidate], 'complete', candidate);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(deferredSourceStatus(pending.hold), 'matches-target');
  assert.equal(readDeferredSourceHold(f.root, identity), null);
  assert.equal(readDeferredSourceHold(f.root, identity, { includeContinued: true }).publishedHead, candidate);
  assert.equal(readDeferredSourceRedrive(f.root, { ...identity, headSha: candidate }), null);
}

test('custody wrapper audits publication refusal and reports an unconfirmed post-push handoff', t => {
  const f = fixture(t);
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'base');
  const base = f.git('rev-parse', 'HEAD');
  writeFileSync(join(f.workspace, 'change.txt'), 'candidate\n');
  f.git('add', 'change.txt');
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'candidate');
  const head = f.git('rev-parse', 'HEAD');
  const serviceRoot = fileURLToPath(new URL('..', import.meta.url));
  writeFileSync(join(f.root, 'inputs.sh'), `export HAM_NODE_BIN="$HAM_RUN_DIR/fixture-node"
export HAM_ROOT_DIR=${JSON.stringify(serviceRoot)}
`);
  for (const phase of ['hammer-verify-head', 'hammer-publish', 'hammer-merge']) {
    writeFileSync(join(f.root, `${phase}.sh`), '');
  }
  writeFileSync(join(f.root, 'fixture-node'), `#!/bin/bash
case "\${1##*/}:$2" in
  hammer-controller.mjs:assert-owner|hammer-controller.mjs:resolve-environment|hammer-custody-redrive.mjs:validated|hammer-progress.mjs:remediation-pushed) exit 0 ;;
  hammer-controller.mjs:run) exec bash "$3" "$4" ;;
  hammer-custody-redrive.mjs:prepare) echo '${JSON.stringify({ head, baseHead: base, branch: 'fixture', previousHead: liveHead })}' ;;
  hammer-validate.mjs:--canonical) echo '{"status":0}' > "$HAM_CLOSE_VALIDATION_RECEIPT" ;;
  hammer-helper-step.mjs:mutation)
    case "$FIXTURE_PUBLISH" in
      rejected) echo '{"route":"refused","phaseOutcome":"source-publication-refused"}' ;;
      failed) exit 75 ;;
      yes) echo '${JSON.stringify({ route: 'published', head })}' ;;
    esac ;;
  hammer-custody-redrive.mjs:complete) exit 75 ;;
  hammer-terminal-audit.mjs:*) echo "$2" >> "$HAM_RUN_DIR/audits" ;;
  *) exit 99 ;;
esac
`, { mode: 0o700 });
  const wrapper = join(serviceRoot, 'bin', 'hammer-close.sh');
  const run = publish => spawnSync('bash', [wrapper, join(f.root, 'custody-redrive.json')], {
    cwd: f.workspace,
    env: {
      PATH: process.env.PATH, HOME: f.root, TMPDIR: f.root,
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      HAM_RUN_DIR: f.root, FIXTURE_PUBLISH: publish,
    },
    encoding: 'utf8', timeout: 10_000,
  });
  const failed = run('failed');
  assert.equal(failed.status, 75, failed.stderr);
  const refused = run('rejected');
  assert.equal(refused.status, 75, refused.stderr);
  assert.equal(readFileSync(join(f.root, 'audits'), 'utf8'), 'publish-head-read-failed\nsource-publication-refused\n');
  const result = run('yes');
  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stdout, /HAM close result:/);
  assert.equal(readFileSync(join(f.root, 'audits'), 'utf8'), 'publish-head-read-failed\nsource-publication-refused\n');
  const receipt = JSON.parse(readFileSync(join(f.root, 'close-result.json'), 'utf8'));
  assert.equal(receipt.outcome, 'review-handoff-unconfirmed');
  assert.equal(receipt.stage, 'custody-review-handoff');
  assert.equal(receipt.postRemediationSha, head);
  assert.deepEqual(receipt.localValidation, [{ status: 0 }]);
});

test('custody publication refuses authoritative terminal, held and fork targets', () => {
  const live = { state: 'open', merged: false, draft: false, labels: [],
    head: { repo: { full_name: repo } }, base: { repo: { full_name: repo } } };
  assert.doesNotThrow(() => assertCustodyRedriveTarget(live, repo));
  for (const update of [{ state: 'closed' }, { merged: true }, { draft: true },
    { labels: [{ name: 'do-not-merge' }] }, { head: { repo: { full_name: 'synthetic/fork' } } }]) {
    assert.throws(() => assertCustodyRedriveTarget({ ...live, ...update }, repo));
  }
});

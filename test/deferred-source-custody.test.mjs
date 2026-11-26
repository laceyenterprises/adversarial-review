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
  recordDeferredSourceCandidate, completeDeferredSourceRedrive } from '../src/ama/deferred-source-custody.mjs';
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


test('custody retry CLI prepares a PR whose head differs from its base and settles the exact published head', t => {
  const f = fixture(t);
  const git = f.git;
  git('config', 'user.name', 'Synthetic Builder');
  git('config', 'user.email', 'synthetic@example.test');
  function commit(file) {
    writeFileSync(join(f.workspace, file), `${file}\n`);
    git('add', file);
    git('commit', '-qm', file);
    return git('rev-parse', 'HEAD');
  }
  const fork = commit('initial.txt');
  const originalTarget = commit('builder.txt');
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
  const base = commit('new-base-edit.txt');
  const remote = join(f.root, 'synthetic-origin.git');
  git('init', '-q', '--bare', remote);
  git('push', '-q', remote, `${movedHead}:refs/heads/synthetic-pr`, `${base}:refs/heads/main`);
  const checkout = join(f.root, 'retry-checkout');
  git('clone', '-q', '--branch', 'synthetic-pr', remote, checkout);
  const recoveryGit = (...args) => execFileSync('git', args, {
    cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  recoveryGit('config', 'user.name', 'Synthetic Closer');
  recoveryGit('config', 'user.email', 'closer@example.test');
  assert.throws(() => recoveryGit('cat-file', '-e', `${retained}^{commit}`), 'only the bundle carries the retained commit');
  const live = { ...identity, headSha: movedHead };
  const policy = { backoffBaseMs: 1_000, backoffMaxMs: 2_000 };
  let pending = readDeferredSourceRedrive(f.root, live);
  assert.equal(pending.hold.targetHead, originalTarget);
  assert.equal(reserveDeferredSourceRedrive(pending, { now: 1_000, policy, headSha: movedHead }), true);
  assert.equal(reserveDeferredSourceRedrive(pending, { now: 1_000, policy, headSha: movedHead }), false);
  pending = readDeferredSourceRedrive(f.root, live);
  assert.equal(reserveDeferredSourceRedrive(pending, { now: 1_500, policy, headSha: movedHead }), false);

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
const pr = { state: 'open', merged: false, draft: false, labels: [],
  head: { ref: 'synthetic-pr', sha, repo: { full_name: '${repo}' } },
  base: { ref: 'main', sha: '${base}', repo: { full_name: '${repo}' } } };
console.log(wantsHead ? pr.head.sha : JSON.stringify(pr));
`, { mode: 0o700 });
  writeFileSync(join(f.root, 'custody-redrive.json'), JSON.stringify({
    targetHead: pending.hold.targetHead, attempt: pending.hold.attempt, count: pending.source.redrive.count,
  }));
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:HAMMER_LACEY_GH_TOKEN|MERGE_AGENT_GH_TOKEN|HQ_ENTITLEMENT_GH_TOKEN|GH_TOKEN|GITHUB_TOKEN)(?:_|$)/.test(key)));
  const env = { ...cleanEnv, PATH: `${fixtureBin}:${process.env.PATH}`,
    HAM_RUN_DIR: f.root, HAM_HQ_ROOT: f.root, HAM_REPO: repo, HAM_PR_NUMBER: String(prNumber),
    HAM_TARGET_REMEDIATION_SHA: movedHead, HAMMER_LACEY_GH_TOKEN: 'fixture-token' };
  function runHelper(helper, expectedReads, ...args) {
    writeFileSync(responses, JSON.stringify(expectedReads));
    const script = fileURLToPath(new URL(`../bin/${helper}.mjs`, import.meta.url));
    const result = spawnSync(process.execPath, [script, ...args], { cwd: checkout, env, encoding: 'utf8', timeout: 10_000 });
    assert.deepEqual(JSON.parse(readFileSync(responses)), [], result.stderr);
    return result;
  }
  const bootstrap = runHelper('hammer-base-head', [movedHead], `https://github.com/${repo}/pull/${prNumber}`);
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
  env.HAM_BASE_HEAD = bootstrap.stdout.trim();
  assert.equal(env.HAM_BASE_HEAD, movedHead);
  assert.notEqual(env.HAM_BASE_HEAD, base);
  const moved = runHelper('hammer-custody-redrive', [originalTarget], 'prepare');
  assert.equal(moved.status, 75, moved.stderr);
  assert.match(moved.stderr, /PR head moved/);
  assert.equal(recoveryGit('rev-parse', 'HEAD'), movedHead);
  // The retained intent pins the PR head independently of the bootstrap value.
  env.HAM_BASE_HEAD = base;
  const prepare = runHelper('hammer-custody-redrive', [movedHead], 'prepare');
  assert.equal(prepare.status, 0, prepare.stderr);
  const { head: candidate, ...prepared } = JSON.parse(prepare.stdout);
  assert.deepEqual(prepared, { branch: 'synthetic-pr', previousHead: movedHead, baseHead: base });
  assert.equal(recoveryGit('merge-base', candidate, base), base);
  assert.deepEqual(recoveryGit('ls-tree', '--name-only', candidate).split('\n'),
    ['builder.txt', 'initial.txt', 'new-base-edit.txt', 'new-pr-edit.txt', 'retained.txt']);
  assert.equal(recordDeferredSourceCandidate(pending, candidate), true);
  assert.equal(completeDeferredSourceRedrive(pending, movedHead), false);
  recoveryGit('push', '-q', `--force-with-lease=refs/heads/synthetic-pr:${movedHead}`, 'origin', `${candidate}:refs/heads/synthetic-pr`);
  const published = recoveryGit('ls-remote', 'origin', 'refs/heads/synthetic-pr').split('\t')[0];
  assert.equal(published, candidate);
  for (const reads of [[movedHead, originalTarget], [movedHead, movedHead, movedHead]]) {
    const unconfirmed = runHelper('hammer-custody-redrive', reads, 'complete', candidate);
    assert.equal(unconfirmed.status, 75, unconfirmed.stderr);
    assert.equal(deferredSourceStatus(pending.hold), 'bundled');
  }
  const completed = runHelper('hammer-custody-redrive', [movedHead, movedHead, candidate], 'complete', candidate);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(deferredSourceStatus(pending.hold), 'matches-target');
  assert.equal(readDeferredSourceHold(f.root, identity), null);
  assert.equal(readDeferredSourceHold(f.root, identity, { includeContinued: true }).publishedHead, candidate);
  assert.equal(readDeferredSourceRedrive(f.root, { ...identity, headSha: candidate }), null);
});

test('custody controller reports an unconfirmed post-push head as a review handoff stop', t => {
  const f = fixture(t);
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'base');
  const base = f.git('rev-parse', 'HEAD');
  writeFileSync(join(f.workspace, 'change.txt'), 'candidate\n');
  f.git('add', 'change.txt');
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'candidate');
  const head = f.git('rev-parse', 'HEAD');
  writeFileSync(join(f.root, 'inputs.sh'), 'export HAM_NODE_BIN="$HAM_RUN_DIR/fixture-node"\n');
  for (const phase of ['hammer-verify-head', 'hammer-publish', 'hammer-merge']) {
    writeFileSync(join(f.root, `${phase}.sh`), '');
  }
  writeFileSync(join(f.root, 'fixture-node'), `#!/bin/bash
case "\${1##*/}:$2" in
  hammer-controller.mjs:assert-owner|hammer-custody-redrive.mjs:validated|hammer-progress.mjs:remediation-pushed) exit 0 ;;
  hammer-custody-redrive.mjs:prepare) echo '${JSON.stringify({ head, baseHead: base, branch: 'fixture', previousHead: liveHead })}' ;;
  hammer-validate.mjs:--canonical) echo '{"status":0}' > "$HAM_CLOSE_VALIDATION_RECEIPT" ;;
  hammer-helper-step.mjs:mutation) echo '${JSON.stringify({ route: 'published', head })}' ;;
  hammer-custody-redrive.mjs:complete) exit 75 ;;
  *) exit 99 ;;
esac
`, { mode: 0o700 });
  const controller = fileURLToPath(new URL('../bin/hammer-close-controller.sh', import.meta.url));
  const result = spawnSync('bash', [controller, join(f.root, 'custody-redrive.json')], {
    cwd: f.workspace, env: { ...process.env, HAM_RUN_DIR: f.root }, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 75, result.stderr);
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

import './helpers/dispatch-read-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { __testables__ } from '../src/ama/dispatch-closer.mjs';
import { continueDeferredSourceCustody, deferredSourceStatus, readDeferredSourceHold, startDeferredSourceCustody } from '../src/ama/deferred-source-custody.mjs';
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
  return { root, dir, identity, hold: readDeferredSourceHold(root, identity) };
}

for (const status of ['local-ref-only', 'workspace-only', 'bundled', 'matches-target', 'unconfirmed']) {
  test(`teardown finds a launch's ${status} source under its published head`, async t => {
    const f = fixture(t);
    if (status !== 'unconfirmed') writeFileSync(join(f.dir, 'source.json'), JSON.stringify({ status, bundle: 'source.bundle' }));
    if (status === 'bundled') writeFileSync(join(f.dir, 'source.bundle'), 'fixture');
    let tornDown = false;
    const result = await __testables__.cleanupHammerCloserWorker({
      prNumber, hqRoot: f.root, hqPath: '/fixture/hq', reason: 'ended', logger: {},
      existingRecord: { repo, headSha: dispatchHead, targetRemediationSha: dispatchHead,
        launchRequestId, workerClass: 'hammer', workerId: 'hammer-ama-pr-42' },
      execFileImpl: async () => { tornDown = true; },
      cleanupScratchImpl() {},
    });
    const safe = ['bundled', 'matches-target'].includes(status);
    assert.equal(tornDown, safe);
    assert.equal(result.ok, safe);
    if (!safe) assert.equal(result.error, 'deferred-source-retained-in-workspace');
  });
}

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
  const workspace = join(f.root, 'checkout');
  mkdirSync(workspace);
  const git = (...args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'source');
  const head = git('rev-parse', 'HEAD');
  writeFileSync(f.hold.path, JSON.stringify({ ...JSON.parse(readFileSync(f.hold.path)), workspace, sourceHead: head, clean: true }));
  writeFileSync(join(f.dir, 'source.json'), JSON.stringify({ status: 'local-ref-only' }));
  let tornDown = false;
  await __testables__.cleanupHammerCloserWorker({
    prNumber, hqRoot: f.root, hqPath: '/fixture/hq', reason: 'ended', logger: {},
    existingRecord: { repo, headSha: dispatchHead, launchRequestId, workerClass: 'hammer', workerId: 'hammer-ama-pr-42' },
    execFileImpl: async () => { tornDown = true; }, cleanupScratchImpl() {},
  });
  assert.equal(tornDown, true);
  const retained = JSON.parse(readFileSync(join(f.dir, 'source.json')));
  assert.equal(retained.status, 'bundled');
  assert.deepEqual(retained.prerequisites, []);
  assert.match(git('bundle', 'list-heads', join(f.dir, 'source.bundle')), new RegExp(`^${head} `));
});

test('missing source receipt infers only a clean matching target', t => {
  const f = fixture(t);
  assert.equal(deferredSourceStatus({ ...f.hold, sourceHead: liveHead }), 'matches-target');
  assert.equal(deferredSourceStatus({ ...f.hold, sourceHead: liveHead, clean: false }), 'workspace-only');
  writeFileSync(join(f.dir, 'source.json'), '{broken');
  assert.equal(deferredSourceStatus({ ...f.hold, sourceHead: liveHead }), 'unconfirmed');
});

test('custody completion waits for short lock contention', async t => {
  const f = fixture(t);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fsExt from 'fs-ext';
    import { openSync, closeSync } from 'node:fs';
    const fd = openSync(process.argv[1], 'a');
    fsExt.flockSync(fd, 'ex');
    process.stdout.write('locked');
    setTimeout(() => closeSync(fd), 200);
  `, `${f.hold.path}.lock`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  await once(child.stdout, 'data');
  assert.equal(continueDeferredSourceCustody(f.hold, { publishedHead: sourceHead }), true);
  assert.equal((await closed)[0], 0);
  assert.ok(JSON.parse(readFileSync(f.hold.path)).continuedAt);
});

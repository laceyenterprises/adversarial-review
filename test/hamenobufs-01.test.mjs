import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHistoryReader } from '../src/ama/history-reader.mjs';
import { fetchPrimaryChange, checkPrimaryChange } from '../src/ama/primary-change.mjs';
import { evaluateHammerStopHold } from '../src/ama/hammer-stop-hold.mjs';
import { hammerRetryCapFilePath, readHammerRetryCapLedger } from '../src/ama/hammer-retry-cap.mjs';
const base = 'a'.repeat(40), author = 'b'.repeat(40), head = 'c'.repeat(40);
const repo = 'fixture/repo';

test('large compare: all 401 files and 301 commits yield complete protected evidence without compare patches', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hamenobufs-history-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const files = Array.from({ length: 401 }, (_, i) => ({ path: `file-${i}.mjs`, type: 'blob', mode: '100644', sha: String(i).padStart(40, '0') }));
  const commits = Array.from({ length: 300 }, (_, i) => ({ sha: i === 299 ? author : (i + 1000).toString(16).padStart(40, '0'), commit: { message: 'builder' } }));
  commits.push({ sha: head, parents: [{ sha: author }], commit: { message: 'repair\n\nWorker-Class: hammer' } });
  // The former whole-compare response exceeded spawnSync's 1 MiB limit.
  assert.ok(Buffer.byteLength(JSON.stringify({ commits, files: files.map(file => ({ ...file, patch: 'x'.repeat(4096) })) })) > 1024 * 1024);
  const pages = [];
  const reader = createHistoryReader({ execGhWithRetryImpl: async ({ args }) => {
    const [, path, , projection] = args;
    let value;
    if (path.includes('/reviews?')) value = [];
    else if (path.includes('/pulls/')) value = { head: { sha: head }, base: { sha: base } };
    else if (path.includes('/compare/')) {
      assert.ok(!projection.includes('patch'));
      const page = Number(new URL(`https://fixture/${path}`).searchParams.get('page'));
      pages.push(page);
      const count = path.includes(`...${head}`) ? 301 : 300;
      value = { status: 'ahead', total_commits: count, merge_base_commit: { sha: base }, commits: commits.slice((page - 1) * 100, Math.min(page * 100, count)) };
    } else if (path.includes('/git/trees/')) value = { tree: path.endsWith(base) ? [] : files, truncated: false };
    else if (path.includes('/git/blobs/')) value = { encoding: 'base64', content: Buffer.from('protected\n').toString('base64'), size: 10 };
    else throw new Error(`unexpected ${path}`);
    return { stdout: JSON.stringify(value) };
  } });
  const evidence = await fetchPrimaryChange({ repo, prNumber: 1, headSha: head, rootDir, get: reader }, { fetchCiCostImpl: async () => ({ headSha: head, ok: true }) });
  assert.equal(evidence.primaryHead, author);
  assert.equal(evidence.mergeBase, base);
  assert.equal(evidence.primaryFiles.length, 401);
  assert.equal(evidence.finalFiles.length, 401);
  assert.equal(evidence.completeFileLists, true);
  assert.equal(checkPrimaryChange(JSON.parse(JSON.stringify(evidence)), head).ok, true);
  assert.deepEqual(pages, [0, 1, 2, 3, 4, 1, 2, 3]);
});

test('spawn ENOBUFS reports explicit failed read with error and output limit, never unknown', async () => {
  const reader = createHistoryReader({ execGhWithRetryImpl: async () => { throw Object.assign(new Error('spawnSync gh ENOBUFS'), { code: 'ENOBUFS' }); } });
  const evidence = await fetchPrimaryChange({ repo, prNumber: 1, headSha: head, get: reader });
  assert.equal(evidence.historyReadFailed, true);
  assert.equal(evidence.readFailed, true);
  const answer = checkPrimaryChange(evidence, head);
  assert.equal(answer.reason, 'history-read-failed');
  assert.match(answer.detail, /ENOBUFS/);
  assert.match(answer.detail, /output limit 26214400 bytes exceeded/);
  assert.equal(answer.detail, `history read failed: repos/${repo}/pulls/1 (output limit 26214400 bytes exceeded): spawnSync gh ENOBUFS`);
});

test('tree evidence diffs file/submodule transitions and preserves standalone gitlinks', async () => {
  const gitlink = { path: 'entry', type: 'commit', mode: '160000', sha: author };
  const file = { path: 'entry', type: 'blob', mode: '100644', sha: head };
  const content = 'first line\nsecond line\n';
  for (const [before, after, additions, deletions] of [
    [gitlink, file, 2, 0], [file, gitlink, 0, 2],
    [gitlink, { ...gitlink, sha: head }, 0, 0],
    [null, gitlink, 0, 0], [gitlink, null, 0, 0],
  ]) {
    const blobReads = [];
    const reader = createHistoryReader({ execGhWithRetryImpl: async ({ args }) => {
      const path = args[1];
      let value;
      if (path.includes('/compare/')) value = { status: 'ahead', total_commits: 0, commits: [], merge_base_commit: { sha: base } };
      else if (path.includes('/git/trees/')) {
        const entry = path.endsWith(base) ? before : after;
        value = { tree: entry ? [entry] : [], truncated: false };
      } else if (path === `repos/${repo}/git/blobs/${file.sha}`) {
        blobReads.push(path);
        value = { encoding: 'base64', content: Buffer.from(content).toString('base64'), size: Buffer.byteLength(content) };
      } else throw new Error(`unexpected ${path}`);
      return { stdout: JSON.stringify(value) };
    } });
    const evidence = await reader(`repos/${repo}/compare/${base}...${head}`);
    assert.equal(evidence.filesComplete, true);
    assert.equal(evidence.files.length, 1);
    const change = evidence.files[0];
    assert.equal(change.filename, 'entry');
    assert.equal(change.status, !before ? 'added' : !after ? 'removed' : 'modified');
    assert.equal(change.sha, after?.sha || before.sha);
    assert.equal(change.additions, additions);
    assert.equal(change.deletions, deletions);
    if (additions || deletions) {
      assert.match(change.patch, /^@@/);
      const sign = additions ? '+' : '-';
      assert.ok(change.patch.includes(`${sign}first line\n${sign}second line\n`));
      assert.deepEqual(blobReads, [`repos/${repo}/git/blobs/${file.sha}`]);
    } else {
      assert.equal(change.patch, undefined);
      assert.deepEqual(blobReads, []);
    }
  }
});

test('FINALCLOSE-01 preflight read failures stay charged and release for capped retry', async t => {
  const root = mkdtempSync(join(tmpdir(), 'hamenobufs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const identity = { repo, prNumber: 1 };
  const path = hammerRetryCapFilePath(root, identity);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...identity, jobKey: head, lastDispatchedHeadSha: head, targetRemediationSha: head,
    attemptCount: 2, lifetimeAttemptCount: 2, targetAttemptCount: 2, updatedAt: '2026-10-10T00:00:00Z' }));
  const attempts = [1, 2].map(i => ({ outcome: 'failed-without-merge', reason: 'history-read-failed', historyReadError: 'spawnSync gh ENOBUFS', noExecution: true,
    launchRequestId: `launch-${i}`, startedAt: `2026-10-10T00:0${i}:00Z`, head, path: 'hammer' }));
  let pages = 0, probes = 0;
  const args = { rootDir: root, hqRoot: root, ...identity, headSha: head, prMetadata: { headSha: head, mergeable: 'CONFLICTING' },
    readAuditImpl: () => ({ attempts }), now: '2026-10-10T00:03:00Z',
    fetchPrimaryChangeImpl: async () => { probes++; return { headSha: head, hasHammerCommits: null, historyReadFailed: true, reason: 'ENOBUFS' }; },
    deliverAlertImpl: async (text, { payload }) => { pages++; assert.match(text, /ENOBUFS/); assert.equal(payload.historyReadError, 'spawnSync gh ENOBUFS'); }, logger: { warn() {}, error() {} } };
  assert.equal((await evaluateHammerStopHold(args)).action, 'release');
  const ledger = readHammerRetryCapLedger(root, identity);
  assert.equal(ledger.attemptCount, 2);
  assert.equal(ledger.lifetimeAttemptCount, 2);
  assert.equal(ledger.targetAttemptCount, 2);
  assert.equal((await evaluateHammerStopHold({ ...args, prMetadata: { headSha: head, mergeable: 'CONFLICTING', baseSha: author } })).action, 'release');
  assert.equal(readHammerRetryCapLedger(root, identity).attemptCount, 2);
  assert.equal(probes, 0);
  assert.equal(pages, 0);
  await evaluateHammerStopHold({ ...args, now: '2026-10-10T00:13:00Z' });
  assert.equal(pages, 0);
  assert.equal((await evaluateHammerStopHold({ ...args, fetchPrimaryChangeImpl: async () => ({ headSha: head, hasHammerCommits: false }) })).action, 'release');
});

test('commit files are projected and paginated independently of compare history', async () => {
  const pages = [];
  const files = Array.from({ length: 251 }, (_, i) => ({ filename: `file-${i}`, status: 'added', sha: base, additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+protected' }));
  const get = createHistoryReader({ execGhWithRetryImpl: async ({ args }) => {
    const page = Number(new URL(`https://fixture/${args[1]}`).searchParams.get('page'));
    pages.push(page);
    assert.ok(args[3].includes('patch'));
    return { stdout: JSON.stringify({ sha: head, parents: [{ sha: author }], commit: { message: 'repair' }, files: files.slice((page - 1) * 100, page * 100) }) };
  } });
  const commit = await get(`repos/${repo}/commits/${head}`);
  assert.equal(commit.filesComplete, true);
  assert.deepEqual(commit.files, files);
  assert.deepEqual(pages, [1, 2, 3]);
});

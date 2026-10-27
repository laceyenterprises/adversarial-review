import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chownSync, rmSync, readFileSync, statSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordPublishedRewrite, recordWorkspaceRewrite, rewriteRepositoryKey } from '../src/branch-rewrite-receipt.mjs';
import { publishRemediation } from '../src/remediation-publication.mjs';
import { resolveQueueGitAdapter } from '../src/finalization/queue-git.mjs';
import { retryGithubAuthPushOnce } from '../src/github-auth-recovery.mjs';

const oldHead = 'a'.repeat(40), newHead = 'b'.repeat(40), base = 'c'.repeat(40);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'holderproof-'));
  // macOS /tmp inherits wheel, outside the worker's groups; shared HQ uses its group.
  chownSync(root, process.getuid(), process.getgid());
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, env: { ...process.env, HQ_ROOT: root, HQ_LAUNCH_REQUEST_ID: 'lrq_fixture' } };
}
function receipt(root) {
  const dir = join(root, 'dispatch', 'branch-rewrites', 'github.com%2Fexample%2Frepo', 'topic%2Fsample');
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  const path = join(dir, files[0]);
  assert.equal(statSync(path).mode & 0o777, 0o660);
  assert.equal(statSync(dir).mode & 0o777, 0o770);
  // Darwin inherits directory groups but clears the requested setgid bit.
  if (process.platform !== 'darwin') assert.equal(statSync(dir).mode & 0o2000, 0o2000);
  return JSON.parse(readFileSync(path));
}

test('receipt matches the shared Python schema, encoded paths, modes and actual leased tips', t => {
  const f = fixture(t);
  const result = recordPublishedRewrite({ repository: 'github.com/example/repo', branch: 'topic/sample',
    oldHead, newHead, actor: 'fixture', env: f.env });
  const row = receipt(f.root);
  assert.equal(row.event, 'worker.branch_rewritten');
  assert.equal(row.repo, 'github.com/example/repo');
  assert.equal(row.branch, 'topic/sample');
  assert.equal(row.oldHead, oldHead); assert.equal(row.newHead, newHead);
  assert.equal(row.launchRequestId, 'lrq_fixture');
  assert.equal(row.actor, 'fixture'); assert.ok(Date.parse(row.recordedAt));
  assert.ok(result.rewriteReceipt);
  for (const url of ['git@github.com:Example/Repo.git', 'https://github.com/Example/Repo.git',
    'workerpush::https://github.com/Example/Repo.git', 'ssh://git@github.com/Example/Repo.git']) {
    assert.equal(rewriteRepositoryKey(url), 'github.com/example/repo');
  }
  assert.throws(() => rewriteRepositoryKey('https://example.invalid/Example/Repo.git'));
});

for (const outcome of ['rewrite', 'forward', 'rejected', 'storage-failed']) {
  test(`remediation publisher receipts only successful rewrites: ${outcome}`, async t => {
    const f = fixture(t);
    if (outcome === 'storage-failed') writeFileSync(join(f.root, 'dispatch'), 'blocked');
    const calls = [];
    const execute = async (command, args) => {
      calls.push(args);
      if (args.includes('merge-base') && args.includes('--is-ancestor')) {
        assert.deepEqual(args.slice(-2), [oldHead, newHead]);
        if (outcome !== 'forward') throw Object.assign(new Error('not ancestor'), { code: 1 });
      }
      if (args.includes('push') && outcome === 'rejected') throw new Error('lease refused');
      if (args.includes('remote')) return { stdout: 'git@github.com:example/repo.git\n' };
      if (args.includes('rev-parse')) return { stdout: args.some(x => x.includes('origin/main')) ? base : newHead };
      if (args.includes('merge-base')) return { stdout: base };
      if (args.includes('diff')) return { stdout: 'feature.txt\0' };
      return { stdout: '' };
    };
    const options = { workspaceDir: f.root, baseBranch: 'main', branch: 'topic/sample', previousHead: oldHead,
      expectedRemoteSha: oldHead, env: f.env, execFileImpl: execute, pushCommand: 'fixture-push' };
    if (outcome === 'rejected') {
      await assert.rejects(publishRemediation(options), /lease refused/);
      assert.equal(readdirSync(f.root).length, 0);
      return;
    }
    const result = await publishRemediation(options);
    assert.equal(result.published, true);
    assert.equal(calls.filter(args => args.includes('push')).length, 1);
    if (outcome === 'rewrite') assert.equal(receipt(f.root).newHead, newHead);
    if (outcome === 'forward') assert.equal(readdirSync(f.root).length, 0);
    if (outcome === 'storage-failed') {
      assert.equal(result.rewriteReceiptError.oldHead, oldHead);
      assert.equal(result.rewriteReceiptError.newHead, newHead);
    }
  });
}

test('finalization direct push records its successful leased rewrite', async t => {
  const f = fixture(t), entry = { lane: { repository: 'example/repo', base: 'main' }, prNumber: 7, head: oldHead,
    rebase: { headRepository: 'example/repo', headRef: 'topic/sample' } };
  // Adapter validates the content-derived workspace prefix independently of Git.
  const { createHash } = await import('node:crypto');
  const key = createHash('sha256').update(JSON.stringify(['example/repo', 7, oldHead])).digest('hex');
  const workspace = `${key}-sample`;
  mkdirSync(join(f.root, 'data', 'finalization-git', workspace), { recursive: true });
  entry.rebase.workspace = workspace;
  const publisher = resolveQueueGitAdapter({ rootDir: f.root, env: f.env, run: async () => '', resolveRemote: () => f.root });
  const result = await publisher.push({ entry, intent: { expectedOldHead: oldHead, candidate: newHead,
    deadline: new Date(Date.now() + 60000).toISOString(), timeoutMs: 30000 } });
  assert.equal(result.outcome, 'succeeded');
  assert.equal(receipt(f.root).actor, 'review-service:finalization-queue');
});

test('workspace recorder skips fast forwards and reports unknown ancestry without evidence', async t => {
  const f = fixture(t);
  const options = { oldHead, newHead, branch: 'topic/sample', actor: 'fixture', env: f.env };
  assert.deepEqual(await recordWorkspaceRewrite({ ...options, git: async () => '' }), {});
  const failure = await recordWorkspaceRewrite({ ...options, git: async () => { throw Object.assign(new Error(), { code: 128 }); } });
  assert.equal(failure.rewriteReceiptError.code, 128);
  assert.equal(readdirSync(f.root).length, 0);
});

test('auth recovery records the exact successful rewrite without relying on git-safe workspace metadata', async t => {
  const f = fixture(t);
  for (const path of ['modules/worker-pool/lib/hq-gh.sh', 'modules/worker-pool/lib/shims/gh', 'modules/worker-pool/bin/git-safe']) {
    const { dirname } = await import('node:path');
    mkdirSync(dirname(join(f.root, path)), { recursive: true }); writeFileSync(join(f.root, path), 'synthetic');
  }
  let pushes = 0;
  const result = await retryGithubAuthPushOnce({ workspaceDir: f.root, branch: 'topic/sample',
    repo: 'example/repo', prNumber: 7, commitSha: newHead, expectedRemoteSha: oldHead,
    env: { ...f.env, HQ_REPO_ROOT: f.root }, retryDelaysMs: [],
    execFileImpl: async (command, args) => {
      if (command === 'bash') { pushes++; return { stdout: '' }; }
      if (args.includes('merge-base')) throw Object.assign(new Error(), { code: 1 });
      if (args.includes('remote')) return { stdout: 'git@github.com:example/repo.git' };
      throw new Error('unexpected operation');
    } });
  assert.equal(result.pushed, true); assert.equal(pushes, 1);
  assert.equal(receipt(f.root).actor, 'review-service:auth-recovery');
});

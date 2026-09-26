import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  auditReviewerSubprocess,
  configureReviewerWorkspaceAudit,
  prepareReviewerSnapshot,
  resolveCheckoutHead,
} from '../src/reviewer-workspace.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo(root, name) {
  const repo = join(root, name);
  mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'reviewer-test@example.invalid');
  git(repo, 'config', 'user.name', 'Reviewer Test');
  writeFileSync(join(repo, 'tracked.txt'), 'base\n');
  git(repo, 'add', 'tracked.txt');
  git(repo, 'commit', '-qm', 'base');
  return repo;
}

function removeFixture(root) {
  try { execFileSync('chmod', ['-R', 'u+w', root]); } catch {}
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

test('Agent OS and adversarial-review snapshots are outside and read-only relative to their source checkout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-two-repos-'));
  try {
    const stateDir = join(root, 'state');
    for (const name of ['agent-os', 'adversarial-review']) {
      const checkoutDir = makeRepo(root, name);
      const snapshot = await prepareReviewerSnapshot({ repo: `laceyenterprises/${name}`, checkoutDir, stateDir });
      assert.notEqual(snapshot.snapshotDir, checkoutDir);
      assert.equal(readFileSync(join(snapshot.snapshotDir, 'tracked.txt'), 'utf8'), 'base\n');
      assert.equal(statSync(snapshot.snapshotDir).mode & 0o222, 0);
      assert.throws(() => writeFileSync(join(snapshot.snapshotDir, 'write.txt'), 'nope'), /EACCES|EPERM/);
      assert.equal(git(checkoutDir, '--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all'), '');
    }
  } finally {
    removeFixture(root);
  }
});

test('snapshot build failure is fail-closed and does not produce a cache entry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-failure-'));
  try {
    const checkoutDir = makeRepo(root, 'repo');
    const stateDir = join(root, 'state');
    await assert.rejects(
      prepareReviewerSnapshot({
        repo: 'laceyenterprises/agent-os',
        checkoutDir,
        stateDir,
        extractArchiveImpl: async () => { throw new Error('synthetic archive failure'); },
      }),
      /reviewer snapshot unavailable.*synthetic archive failure/,
    );
    const cacheRoot = join(stateDir, 'reviewer-snapshots');
    const cachedTrees = existsSync(cacheRoot)
      ? execFileSync('find', [cacheRoot, '-mindepth', '2', '-maxdepth', '2', '-type', 'd', '!', '-name', '.build-*'], { encoding: 'utf8' }).trim()
      : '';
    assert.equal(cachedTrees, '');
  } finally {
    removeFixture(root);
  }
});

test('snapshot build cleanup does not chmod or traverse symlink targets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-symlink-cleanup-'));
  try {
    const checkoutDir = makeRepo(root, 'repo');
    const stateDir = join(root, 'state');
    const outsideDir = join(root, 'outside-target');
    const outsideFile = join(outsideDir, 'secret.txt');
    mkdirSync(outsideDir);
    writeFileSync(outsideFile, 'secret\n');
    chmodSync(outsideDir, 0o755);
    chmodSync(outsideFile, 0o644);

    await assert.rejects(
      prepareReviewerSnapshot({
        repo: 'laceyenterprises/agent-os',
        checkoutDir,
        stateDir,
        extractArchiveImpl: async (source, destination) => {
          assert.equal(source, checkoutDir);
          symlinkSync(outsideDir, join(destination, 'escape'));
        },
      }),
      /snapshot contains link escaping its root/,
    );

    assert.equal(statSync(outsideDir).mode & 0o777, 0o755);
    assert.equal(statSync(outsideFile).mode & 0o777, 0o644);
  } finally {
    removeFixture(root);
  }
});

test('resolveCheckoutHead retries transient git failures', async () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  let attempts = 0;
  const result = await resolveCheckoutHead('/tmp/transient-checkout', async (cmd, args, options) => {
    attempts += 1;
    assert.equal(cmd, 'git');
    assert.deepEqual(args, ['--no-optional-locks', 'rev-parse', '--verify', 'HEAD']);
    assert.equal(options.cwd, '/tmp/transient-checkout');
    if (attempts === 1) {
      const err = new Error('fatal: unable to access repository: Input/output error');
      err.code = 'EIO';
      err.stderr = 'fatal: unable to access repository: Input/output error';
      throw err;
    }
    return { stdout: `${sha}\n` };
  });

  assert.equal(result, sha);
  assert.equal(attempts, 2);
});

test('snapshot archive extraction retries transient git failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-archive-retry-'));
  try {
    const checkoutDir = makeRepo(root, 'repo');
    const stateDir = join(root, 'state');
    let attempts = 0;
    const snapshot = await prepareReviewerSnapshot({
      repo: 'laceyenterprises/agent-os',
      checkoutDir,
      stateDir,
      extractArchiveImpl: async (source, destination) => {
        attempts += 1;
        if (attempts === 1) {
          const err = new Error('git archive snapshot failed: EIO');
          err.code = 'EIO';
          throw err;
        }
        execFileSync('sh', ['-c', 'git --no-optional-locks archive --format=tar HEAD | tar -x -C "$1"', '_', destination], { cwd: source });
      },
    });

    assert.equal(attempts, 2);
    assert.equal(readFileSync(join(snapshot.snapshotDir, 'tracked.txt'), 'utf8'), 'base\n');
  } finally {
    removeFixture(root);
  }
});

test('snapshot cache reuses a HEAD, builds a new HEAD, and garbage-collects stale snapshots', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-cache-'));
  try {
    const checkoutDir = makeRepo(root, 'repo');
    const stateDir = join(root, 'state');
    let builds = 0;
    const first = await prepareReviewerSnapshot({
      repo: 'laceyenterprises/agent-os', checkoutDir, stateDir,
      extractArchiveImpl: async (source, destination) => { builds += 1; execFileSync('sh', ['-c', 'git --no-optional-locks archive --format=tar HEAD | tar -x -C "$1"', '_', destination], { cwd: source }); },
    });
    const second = await prepareReviewerSnapshot({ repo: 'laceyenterprises/agent-os', checkoutDir, stateDir });
    assert.equal(second.snapshotDir, first.snapshotDir);
    assert.equal(second.reused, true);
    assert.equal(builds, 1);

    writeFileSync(join(checkoutDir, 'tracked.txt'), 'next\n');
    git(checkoutDir, 'add', 'tracked.txt');
    git(checkoutDir, 'commit', '-qm', 'next');
    chmodSync(first.snapshotDir, 0o755);
    utimesSync(first.snapshotDir, new Date(0), new Date(0));
    const third = await prepareReviewerSnapshot({ repo: 'laceyenterprises/agent-os', checkoutDir, stateDir, maxAgeMs: 1 });
    assert.notEqual(third.snapshotDir, first.snapshotDir);
    assert.equal(existsSync(first.snapshotDir), false);
  } finally {
    removeFixture(root);
  }
});

test('workspace escape audit preserves EPERM live pid records', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-eperm-audit-'));
  const originalKill = process.kill;
  const otherPid = 987654;
  try {
    const checkoutDir = makeRepo(root, 'repo');
    const stateDir = join(root, 'state');
    const auditDir = join(stateDir, 'reviewer-workspace-audit');
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(join(auditDir, `live-${otherPid}`), '{}\n');
    process.kill = (pid, signal) => {
      if (pid === otherPid && signal === 0) {
        const err = new Error('operation not permitted');
        err.code = 'EPERM';
        throw err;
      }
      return originalKill(pid, signal);
    };
    configureReviewerWorkspaceAudit({
      repo: 'laceyenterprises/agent-os', prNumber: 7027, reviewerModel: 'gemini',
      headSha: 'abc124', checkoutDir, stateDir,
    });
    await auditReviewerSubprocess(async ({ onSpawn }) => {
      onSpawn({ pid: process.pid });
      writeFileSync(join(checkoutDir, 'escaped.txt'), 'escape\n');
      return { stdout: 'done' };
    });
    const log = readFileSync(join(auditDir, 'reviewer-workspace-escapes.jsonl'), 'utf8');
    const event = JSON.parse(log.trim());
    assert.deepEqual(event.otherLiveReviewerPids, [otherPid]);
    assert.equal(existsSync(join(auditDir, `live-${otherPid}`)), true);
  } finally {
    process.kill = originalKill;
    configureReviewerWorkspaceAudit(null);
    removeFixture(root);
  }
});

test('checkout writes during a model subprocess produce a durable reviewer_workspace_escape event', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-escape-'));
  try {
    const checkoutDir = makeRepo(root, 'repo');
    const stateDir = join(root, 'state');
    configureReviewerWorkspaceAudit({
      repo: 'laceyenterprises/agent-os', prNumber: 7026, reviewerModel: 'gemini',
      headSha: 'abc123', checkoutDir, stateDir,
    });
    await auditReviewerSubprocess(async ({ onSpawn }) => {
      onSpawn({ pid: process.pid });
      writeFileSync(join(checkoutDir, 'escaped.txt'), 'escape\n');
      return { stdout: 'done' };
    });
    const log = readFileSync(join(stateDir, 'reviewer-workspace-audit', 'reviewer-workspace-escapes.jsonl'), 'utf8');
    const event = JSON.parse(log.trim());
    assert.equal(event.event, 'reviewer_workspace_escape');
    assert.equal(event.subprocessPid, process.pid);
    assert.deepEqual(event.paths, ['escaped.txt']);
    assert.ok(event.window.startedAt);
    assert.ok(event.window.endedAt);
  } finally {
    configureReviewerWorkspaceAudit(null);
    removeFixture(root);
  }
});

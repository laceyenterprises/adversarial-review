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
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ReviewerSnapshotBaseError,
  auditReviewerSubprocess,
  changedStatusPaths,
  configureReviewerWorkspaceAudit,
  extractArchiveOnce,
  garbageCollectSnapshots,
  isReviewerSnapshotBaseError,
  prepareReviewerSnapshot,
  resolveCheckoutHead,
  resolveReviewerWorkspaceStateDir,
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

test('repo-local review ledger keeps reviewer snapshots and audit outside both live checkouts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-live-default-'));
  try {
    const agentOs = makeRepo(root, 'agent-os');
    const toolsDir = join(agentOs, 'tools');
    mkdirSync(toolsDir);
    const reviewRepo = makeRepo(toolsDir, 'adversarial-review');
    const external = join(root, 'hq', 'adversarial-review', 'reviewer-workspace');
    for (const [repo, checkoutDir] of [
      ['laceyenterprises/agent-os', agentOs],
      ['laceyenterprises/adversarial-review', reviewRepo],
    ]) {
      const stateDir = join(reviewRepo, 'data');
      const workspaceStateDir = resolveReviewerWorkspaceStateDir({
        stateDir, checkoutDir, env: { HQ_ROOT: join(root, 'hq') },
      });
      assert.equal(workspaceStateDir, external);
      assert.equal(resolveReviewerWorkspaceStateDir({
        stateDir: external, checkoutDir, env: {}, homeDir: join(root, 'home'),
      }), external);
      assert.equal(resolveReviewerWorkspaceStateDir({
        stateDir, checkoutDir, env: {}, homeDir: join(root, 'home'),
      }), join(root, 'home', '.agent-os', 'adversarial-review', 'reviewer-workspace'));
      const snapshot = await prepareReviewerSnapshot({ repo, checkoutDir, stateDir: workspaceStateDir });
      assert.ok(snapshot.snapshotDir.startsWith(external));
      assert.ok(!snapshot.snapshotDir.startsWith(agentOs));
    }
  } finally {
    removeFixture(root);
  }
});

test('reviewer workspace state override inside the checkout fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-invalid-root-'));
  try {
    const checkoutDir = join(root, 'checkout');
    mkdirSync(checkoutDir);
    assert.throws(() => resolveReviewerWorkspaceStateDir({
      stateDir: join(checkoutDir, 'data'), checkoutDir,
      env: { ADVERSARIAL_REVIEW_WORKSPACE_STATE_DIR: join(checkoutDir, 'cache') },
    }), /outside the source checkout/);
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
      (err) => {
        assert.equal(err instanceof ReviewerSnapshotBaseError, true);
        assert.equal(isReviewerSnapshotBaseError(err), true);
        assert.equal(err.linkPath, 'escape');
        assert.equal(err.linkTarget, outsideDir);
        assert.match(err.message, /snapshot contains link escaping its root/);
        return true;
      },
    );

    assert.equal(statSync(outsideDir).mode & 0o777, 0o755);
    assert.equal(statSync(outsideFile).mode & 0o777, 0o644);
  } finally {
    removeFixture(root);
  }
});

test('escaping symlink in the base checkout is an infrastructure error, not a PR verdict', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-base-link-'));
  try {
    const checkoutDir = makeRepo(root, 'repo');
    symlinkSync('../outside', join(checkoutDir, 'escape'));
    git(checkoutDir, 'add', 'escape');
    git(checkoutDir, 'commit', '-qm', 'base symlink');
    const baseHead = git(checkoutDir, 'rev-parse', 'HEAD');
    await assert.rejects(
      prepareReviewerSnapshot({ repo: 'laceyenterprises/agent-os', checkoutDir, stateDir: join(root, 'state') }),
      (err) => {
        assert.equal(err instanceof ReviewerSnapshotBaseError, true);
        assert.equal(err.failureClass, 'reviewer-snapshot-base-invalid');
        assert.equal(err.headSha, baseHead);
        assert.equal(err.linkPath, 'escape');
        assert.equal(err.prNumber, undefined);
        return true;
      },
    );
  } finally {
    removeFixture(root);
  }
});

test('archive extraction rejects instead of hanging when a child exits via signal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-archive-signal-'));
  try {
    const checkoutDir = makeRepo(root, 'repo');
    const largePath = join(checkoutDir, 'large.bin');
    writeFileSync(largePath, Buffer.alloc(8 * 1024 * 1024, 1));
    git(checkoutDir, 'add', 'large.bin');
    git(checkoutDir, 'commit', '-qm', 'large payload');
    const badDestination = join(root, 'not-a-directory');
    writeFileSync(badDestination, 'nope\n');

    const result = await Promise.race([
      extractArchiveOnce(checkoutDir, badDestination)
        .then(() => ({ status: 'resolved' }), (err) => ({ status: 'rejected', err })),
      new Promise((resolve) => { setTimeout(() => resolve({ status: 'timeout' }), 2000); }),
    ]);

    assert.equal(result.status, 'rejected');
    assert.match(result.err.message, /git archive snapshot failed/);
    assert.doesNotMatch(result.err.message, /git=null|tar=null/);
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
    const reuseNowMs = Date.UTC(2026, 0, 2, 3, 4, 5);
    utimesSync(first.snapshotDir, new Date(0), new Date(0));
    utimesSync(join(first.snapshotDir, '.reviewer-snapshot.json'), new Date(0), new Date(0));
    const second = await prepareReviewerSnapshot({ repo: 'laceyenterprises/agent-os', checkoutDir, stateDir });
    assert.equal(second.snapshotDir, first.snapshotDir);
    assert.equal(second.reused, true);
    assert.equal(builds, 1);
    const touched = await prepareReviewerSnapshot({
      repo: 'laceyenterprises/agent-os',
      checkoutDir,
      stateDir,
      nowMs: reuseNowMs,
    });
    assert.equal(touched.snapshotDir, first.snapshotDir);
    assert.equal(touched.reused, true);
    assert.ok(Math.abs(statSync(first.snapshotDir).mtimeMs - reuseNowMs) < 1500);
    assert.ok(Math.abs(statSync(join(first.snapshotDir, '.reviewer-snapshot.json')).mtimeMs - reuseNowMs) < 1500);

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

test('snapshot garbage collection ignores entries concurrently removed before stat', () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-gc-race-'));
  try {
    const repoCacheDir = join(root, 'repo-cache');
    const staleDir = join(repoCacheDir, 'stale-head');
    const currentDir = join(repoCacheDir, 'current-head');
    mkdirSync(staleDir, { recursive: true });
    mkdirSync(currentDir, { recursive: true });
    const removed = garbageCollectSnapshots(repoCacheDir, 'current-head', {
      nowMs: Date.UTC(2026, 0, 2),
      maxAgeMs: 1,
      statSyncImpl(entryPath) {
        if (entryPath === staleDir) {
          const err = new Error('concurrently removed');
          err.code = 'ENOENT';
          throw err;
        }
        return statSync(entryPath);
      },
    });

    assert.deepEqual(removed, []);
  } finally {
    removeFixture(root);
  }
});

test('snapshot garbage collection logs an inaccessible stale entry and preserves review availability', () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-gc-permission-'));
  try {
    const staleDir = join(root, 'stale-head');
    mkdirSync(staleDir);
    const warnings = [];
    const removed = garbageCollectSnapshots(root, 'current-head', {
      statSyncImpl() {
        const err = new Error('permission denied');
        err.code = 'EPERM';
        throw err;
      },
      log: { warn: (message) => warnings.push(message) },
    });
    assert.deepEqual(removed, []);
    assert.equal(existsSync(staleDir), true);
    assert.match(warnings[0], /snapshot cache cleanup failed.*permission denied/);
  } finally {
    removeFixture(root);
  }
});

test('snapshot build recovers from an invalid existing cache directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-invalid-cache-'));
  try {
    const checkoutDir = makeRepo(root, 'repo');
    const stateDir = join(root, 'state');
    let builds = 0;
    const extractArchiveImpl = async (source, destination) => {
      builds += 1;
      execFileSync('sh', ['-c', 'git --no-optional-locks archive --format=tar HEAD | tar -x -C "$1"', '_', destination], { cwd: source });
    };
    const first = await prepareReviewerSnapshot({
      repo: 'laceyenterprises/agent-os',
      checkoutDir,
      stateDir,
      extractArchiveImpl,
    });
    execFileSync('chmod', ['-R', 'u+w', first.snapshotDir]);
    writeFileSync(join(first.snapshotDir, '.reviewer-snapshot.json'), `${JSON.stringify({ schemaVersion: 1, headSha: 'legacy' })}\n`);
    execFileSync('chmod', ['-R', 'a-w', first.snapshotDir]);

    const recovered = await prepareReviewerSnapshot({
      repo: 'laceyenterprises/agent-os',
      checkoutDir,
      stateDir,
      extractArchiveImpl,
    });
    const marker = JSON.parse(readFileSync(join(recovered.snapshotDir, '.reviewer-snapshot.json'), 'utf8'));
    assert.equal(recovered.snapshotDir, first.snapshotDir);
    assert.equal(recovered.reused, false);
    assert.equal(builds, 2);
    assert.equal(marker.headSha, recovered.headSha);
    assert.equal(readFileSync(join(recovered.snapshotDir, 'tracked.txt'), 'utf8'), 'base\n');
  } finally {
    removeFixture(root);
  }
});

test('workspace escape audit records post-probe errors without false escape paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-post-probe-failure-'));
  const originalConsoleError = console.error;
  const errors = [];
  try {
    const checkoutDir = makeRepo(root, 'repo');
    const stateDir = join(root, 'state');
    const auditDir = join(stateDir, 'reviewer-workspace-audit');
    console.error = (...args) => { errors.push(args.map(String).join(' ')); };
    configureReviewerWorkspaceAudit({
      repo: 'laceyenterprises/agent-os', prNumber: 7029, reviewerModel: 'gemini',
      headSha: 'abc126', checkoutDir, stateDir,
    });

    await auditReviewerSubprocess(async ({ onSpawn }) => {
      onSpawn({ pid: process.pid });
      rmSync(checkoutDir, { recursive: true, force: true });
      return { conversationId: 'agy-post-probe-failure' };
    });

    assert.equal(existsSync(join(auditDir, 'reviewer-workspace-escapes.jsonl')), false);
    const auditErrors = readFileSync(join(auditDir, 'reviewer-workspace-audit-errors.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(auditErrors.length, 1);
    assert.equal(auditErrors[0].event, 'reviewer_workspace_escape_audit_error');
    assert.equal(auditErrors[0].phase, 'post');
    assert.equal(auditErrors[0].agyConversationId, 'agy-post-probe-failure');
    assert.ok(errors.some((line) => line.includes('workspace escape state probe failed')));
  } finally {
    console.error = originalConsoleError;
    configureReviewerWorkspaceAudit(null);
    removeFixture(root);
  }
});

test('checkout HEAD movement makes a workspace escape audit event ambiguous', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-head-move-'));
  try {
    const checkoutDir = makeRepo(root, 'repo');
    const stateDir = join(root, 'state');
    const beforeHead = git(checkoutDir, 'rev-parse', 'HEAD');
    configureReviewerWorkspaceAudit({
      repo: 'laceyenterprises/agent-os', prNumber: 1129, reviewerModel: 'claude',
      headSha: 'pr-head', checkoutDir, stateDir,
    });
    await auditReviewerSubprocess(async ({ onSpawn }) => {
      onSpawn({ pid: process.pid });
      writeFileSync(join(checkoutDir, 'tracked.txt'), 'main-catchup update\n');
      git(checkoutDir, 'add', 'tracked.txt');
      git(checkoutDir, 'commit', '-qm', 'main-catchup update');
    });
    const event = JSON.parse(readFileSync(join(stateDir, 'reviewer-workspace-audit', 'reviewer-workspace-escapes.jsonl'), 'utf8').trim());
    assert.equal(event.checkoutHeadBefore, beforeHead);
    assert.equal(event.checkoutHeadAfter, git(checkoutDir, 'rev-parse', 'HEAD'));
    assert.equal(event.ambiguous, true);
    assert.equal(event.attribution, 'checkout-head-moved');
    assert.deepEqual(event.paths, ['tracked.txt']);
  } finally {
    configureReviewerWorkspaceAudit(null);
    removeFixture(root);
  }
});

test('workspace audit bounds reads of large untracked files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-large-file-'));
  try {
    const checkoutDir = makeRepo(root, 'repo');
    const stateDir = join(root, 'state');
    const largePath = join(checkoutDir, 'large.bin');
    writeFileSync(largePath, 'x');
    truncateSync(largePath, 9 * 1024 * 1024);
    chmodSync(largePath, 0o000);
    configureReviewerWorkspaceAudit({
      repo: 'laceyenterprises/agent-os', prNumber: 1129, reviewerModel: 'claude',
      headSha: 'pr-head', checkoutDir, stateDir,
    });
    await auditReviewerSubprocess(async ({ onSpawn }) => {
      onSpawn({ pid: process.pid });
      chmodSync(largePath, 0o600);
    });
    const auditDir = join(stateDir, 'reviewer-workspace-audit');
    const event = JSON.parse(readFileSync(join(auditDir, 'reviewer-workspace-escapes.jsonl'), 'utf8').trim());
    assert.deepEqual(event.paths, ['large.bin']);
    assert.equal(existsSync(join(auditDir, 'reviewer-workspace-audit-errors.jsonl')), false);
  } finally {
    configureReviewerWorkspaceAudit(null);
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

test('workspace escape audit detects writes to an already-dirty tracked file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-dirty-escape-'));
  try {
    const checkoutDir = makeRepo(root, 'repo');
    const stateDir = join(root, 'state');
    writeFileSync(join(checkoutDir, 'tracked.txt'), 'dirty before\n');
    assert.match(git(checkoutDir, '--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all'), /tracked\.txt/);
    configureReviewerWorkspaceAudit({
      repo: 'laceyenterprises/agent-os', prNumber: 7028, reviewerModel: 'gemini',
      headSha: 'abc125', checkoutDir, stateDir,
    });
    await auditReviewerSubprocess(async ({ onSpawn }) => {
      onSpawn({ pid: process.pid });
      writeFileSync(join(checkoutDir, 'tracked.txt'), 'dirty after\n');
      return { stdout: 'done' };
    });
    const log = readFileSync(join(stateDir, 'reviewer-workspace-audit', 'reviewer-workspace-escapes.jsonl'), 'utf8');
    const event = JSON.parse(log.trim());
    assert.deepEqual(event.paths, ['tracked.txt']);
  } finally {
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

test('changedStatusPaths only splits arrow notation for rename or copy status lines', () => {
  assert.deepEqual(changedStatusPaths([], ['?? added -> file.txt']), ['added -> file.txt']);
  assert.deepEqual(changedStatusPaths([], ['R  old.txt -> new.txt']), ['new.txt', 'old.txt']);
});

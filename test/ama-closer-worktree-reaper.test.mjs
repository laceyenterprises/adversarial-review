import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseGitHubRepoFromRemote,
  parseGitWorktreePorcelain,
  reapCloserHammerWorktrees,
} from '../src/ama/closer-worktree-reaper.mjs';

test('closer worktree reaper removes merged hammer worktrees and skips open registered worktrees', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-reap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const repoPath = join(hqRoot, 'repos', 'agent-os');
  const mergedPath = join(hqRoot, 'workers', 'hammer-ama-pr-2819-deadbeef', 'agent-os');
  const openPath = join(hqRoot, 'workers', 'hammer-ama-pr-3064-live', 'agent-os');
  mkdirSync(mergedPath, { recursive: true });
  mkdirSync(openPath, { recursive: true });

  const calls = [];
  const execFileImpl = async (cmd, args) => {
    calls.push({ cmd, args });
    const joined = args.join(' ');
    if (cmd === 'git' && joined.includes('remote get-url origin')) {
      return { stdout: 'git@github.com:laceyenterprises/agent-os.git\n', stderr: '' };
    }
    if (cmd === 'git' && joined.includes('worktree list --porcelain')) {
      return {
        stdout: [
          `worktree ${repoPath}`,
          'branch refs/heads/main',
          '',
          `worktree ${mergedPath}`,
          'branch refs/heads/codex/merged',
          '',
          `worktree ${openPath}`,
          'branch refs/heads/codex/open',
          '',
        ].join('\n'),
        stderr: '',
      };
    }
    return { stdout: '{}', stderr: '' };
  };
  const ghCalls = [];
  const execGhWithRetryImpl = async ({ args }) => {
    ghCalls.push(args);
    const pr = args[2];
    return {
      stdout: JSON.stringify(pr === '2819'
        ? { state: 'MERGED', mergedAt: '2026-07-04T12:00:00Z', closedAt: '2026-07-04T12:00:00Z' }
        : { state: 'OPEN', mergedAt: null, closedAt: null }),
    };
  };

  const result = await reapCloserHammerWorktrees({
    hqRoot,
    cursorPath: join(root, 'cursor.json'),
    hqPath: '/bin/hq',
    repoPaths: [repoPath],
    execFileImpl,
    execGhWithRetryImpl,
    limit: 10,
    logger: { info() {}, warn() {} },
  });

  assert.equal(result.scanned, 2);
  assert.equal(result.reaped, 1);
  assert.equal(result.open, 1);
  assert.equal(result.terminal, 1);
  assert.deepEqual(ghCalls.map((args) => args.slice(0, 4)), [
    ['pr', 'view', '2819', '--repo'],
    ['pr', 'view', '3064', '--repo'],
  ]);
  assert.equal(
    calls.some((call) => call.cmd === 'git' && call.args.includes('remove') && call.args.includes(mergedPath)),
    true,
  );
  assert.equal(
    calls.some((call) => call.cmd === '/bin/hq' && call.args[2] === 'hammer-ama-pr-2819-deadbeef'),
    true,
  );
  assert.equal(
    calls.some((call) => call.cmd === '/bin/hq' && call.args[2] === 'hammer-ama-pr-3064-live'),
    false,
  );
});

test('closer worktree reaper removes half-registered disk leftovers without querying PR state', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-reap-half-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const repoPath = join(hqRoot, 'repos', 'agent-os');
  const workerDir = join(hqRoot, 'workers', 'hammer-ama-pr-3064-half');
  mkdirSync(join(workerDir, 'agent-os'), { recursive: true });

  let ghCalled = false;
  const calls = [];
  const result = await reapCloserHammerWorktrees({
    hqRoot,
    cursorPath: join(root, 'cursor.json'),
    hqPath: '/bin/hq',
    repoPaths: [repoPath],
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'git' && args.includes('list')) return { stdout: '', stderr: '' };
      if (cmd === 'git' && args.includes('get-url')) return { stdout: 'https://github.com/x/y.git\n', stderr: '' };
      return { stdout: '{}', stderr: '' };
    },
    execGhWithRetryImpl: async () => {
      ghCalled = true;
      return { stdout: '{"state":"OPEN"}' };
    },
    limit: 10,
    logger: { info() {}, warn() {} },
  });

  assert.equal(result.reaped, 1);
  assert.equal(result.halfRegistered, 1);
  assert.equal(ghCalled, false);
  assert.equal(
    calls.some((call) => call.cmd === '/bin/hq' && call.args[2] === 'hammer-ama-pr-3064-half'),
    true,
  );
});

test('closer worktree reaper removes prunable worktrees regardless of PR state', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-reap-prunable-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const repoPath = join(hqRoot, 'repos', 'agent-os');
  const worktreePath = join(hqRoot, 'workers', 'hammer-ama-pr-3001-prunable', 'agent-os');
  mkdirSync(worktreePath, { recursive: true });

  const result = await reapCloserHammerWorktrees({
    hqRoot,
    cursorPath: join(root, 'cursor.json'),
    hqPath: '/bin/hq',
    repoPaths: [repoPath],
    execFileImpl: async (cmd, args) => {
      const joined = args.join(' ');
      if (cmd === 'git' && joined.includes('remote get-url origin')) {
        return { stdout: 'https://github.com/laceyenterprises/agent-os.git\n', stderr: '' };
      }
      if (cmd === 'git' && joined.includes('worktree list --porcelain')) {
        return {
          stdout: [
            `worktree ${worktreePath}`,
            'branch refs/heads/codex/prunable',
            'prunable gitdir file points to non-existent location',
            '',
          ].join('\n'),
          stderr: '',
        };
      }
      return { stdout: '{}', stderr: '' };
    },
    execGhWithRetryImpl: async () => {
      throw new Error('PR state should not be queried for prunable worktrees');
    },
    limit: 10,
    logger: { info() {}, warn() {} },
  });

  assert.equal(result.reaped, 1);
  assert.equal(result.prunable, 1);
});

test('closer worktree reaper prunes registered worktrees whose on-disk dir is already gone instead of erroring forever', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-reap-gone-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const repoPath = join(hqRoot, 'repos', 'agent-os');
  // Registered in git metadata but the on-disk worktree dir is never created:
  // this is the hammer-ama-pr-* worktree whose directory is already gone.
  const gonePath = join(hqRoot, 'workers', 'hammer-ama-pr-4242-gone', 'agent-os');

  const calls = [];
  const warnings = [];
  const result = await reapCloserHammerWorktrees({
    hqRoot,
    cursorPath: join(root, 'cursor.json'),
    hqPath: '/bin/hq',
    repoPaths: [repoPath],
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      const joined = args.join(' ');
      if (cmd === 'git' && joined.includes('remote get-url origin')) {
        return { stdout: 'git@github.com:laceyenterprises/agent-os.git\n', stderr: '' };
      }
      if (cmd === 'git' && joined.includes('worktree list --porcelain')) {
        return {
          stdout: [
            `worktree ${repoPath}`,
            'branch refs/heads/main',
            '',
            `worktree ${gonePath}`,
            'branch refs/heads/codex/gone',
            '',
          ].join('\n'),
          stderr: '',
        };
      }
      if (cmd === 'git' && args.includes('remove')) {
        const err = new Error('git worktree remove failed');
        err.stderr = `fatal: validation failed, cannot remove working tree: '${gonePath}/.git' does not exist`;
        throw err;
      }
      if (cmd === 'git' && args.includes('prune')) {
        return { stdout: '', stderr: '' };
      }
      return { stdout: '{}', stderr: '' };
    },
    execGhWithRetryImpl: async () => ({
      stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-07-18T00:00:00Z', closedAt: '2026-07-18T00:00:00Z' }),
    }),
    limit: 10,
    logger: { info() {}, warn(message) { warnings.push(message); } },
  });

  assert.equal(result.reaped, 1);
  assert.equal(result.errors, 0);
  assert.equal(result.pruned, 1);
  assert.equal(result.terminal, 1);
  // The absent-dir path reconciles via `git worktree prune` in the owning repo,
  assert.equal(
    calls.some((call) => call.cmd === 'git' && call.args.includes('prune') && call.args.includes(repoPath)),
    true,
  );
  // never attempts the doomed `git worktree remove`,
  assert.equal(
    calls.some((call) => call.cmd === 'git' && call.args.includes('remove')),
    false,
  );
  // and emits no remove-incomplete error log.
  assert.equal(warnings.some((message) => message.includes('remove-incomplete')), false);
});

test('closer worktree reaper prunes when git worktree remove reports the tree is already gone', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-reap-notree-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const repoPath = join(hqRoot, 'repos', 'agent-os');
  const worktreePath = join(hqRoot, 'workers', 'hammer-ama-pr-4243-notree', 'agent-os');
  mkdirSync(worktreePath, { recursive: true });

  const calls = [];
  const warnings = [];
  const result = await reapCloserHammerWorktrees({
    hqRoot,
    cursorPath: join(root, 'cursor.json'),
    hqPath: '/bin/hq',
    repoPaths: [repoPath],
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      const joined = args.join(' ');
      if (cmd === 'git' && joined.includes('remote get-url origin')) {
        return { stdout: 'git@github.com:laceyenterprises/agent-os.git\n', stderr: '' };
      }
      if (cmd === 'git' && joined.includes('worktree list --porcelain')) {
        return {
          stdout: [
            `worktree ${worktreePath}`,
            'branch refs/heads/codex/notree',
            '',
          ].join('\n'),
          stderr: '',
        };
      }
      if (cmd === 'git' && args.includes('remove')) {
        const err = new Error('git worktree remove failed');
        err.stderr = `fatal: '${worktreePath}' is not a working tree`;
        throw err;
      }
      if (cmd === 'git' && args.includes('prune')) {
        return { stdout: '', stderr: '' };
      }
      return { stdout: '{}', stderr: '' };
    },
    execGhWithRetryImpl: async () => ({
      stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-07-18T00:00:00Z', closedAt: '2026-07-18T00:00:00Z' }),
    }),
    limit: 10,
    logger: { info() {}, warn(message) { warnings.push(message); } },
  });

  assert.equal(result.reaped, 1);
  assert.equal(result.errors, 0);
  assert.equal(result.pruned, 1);
  assert.equal(
    calls.some((call) => call.cmd === 'git' && call.args.includes('remove')),
    true,
  );
  assert.equal(
    calls.some((call) => call.cmd === 'git' && call.args.includes('prune') && call.args.includes(repoPath)),
    true,
  );
  assert.equal(existsSync(worktreePath), false);
  assert.equal(warnings.some((message) => message.includes('remove-incomplete')), false);
});

test('closer worktree reaper keeps git metadata when invalid physical dir removal fails', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-reap-rmfail-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const repoPath = join(hqRoot, 'repos', 'agent-os');
  const worktreePath = join(hqRoot, 'workers', 'hammer-ama-pr-4245-rmfail', 'agent-os');
  mkdirSync(worktreePath, { recursive: true });

  const calls = [];
  const warnings = [];
  const result = await reapCloserHammerWorktrees({
    hqRoot,
    cursorPath: join(root, 'cursor.json'),
    hqPath: '/bin/hq',
    repoPaths: [repoPath],
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      const joined = args.join(' ');
      if (cmd === 'git' && joined.includes('remote get-url origin')) {
        return { stdout: 'git@github.com:laceyenterprises/agent-os.git\n', stderr: '' };
      }
      if (cmd === 'git' && joined.includes('worktree list --porcelain')) {
        return {
          stdout: [
            `worktree ${worktreePath}`,
            'branch refs/heads/codex/rmfail',
            '',
          ].join('\n'),
          stderr: '',
        };
      }
      if (cmd === 'git' && args.includes('remove')) {
        const err = new Error('git worktree remove failed');
        err.stderr = `fatal: '${worktreePath}' is not a working tree`;
        throw err;
      }
      if (cmd === 'git' && args.includes('prune')) {
        throw new Error('git worktree prune should not run after physical removal fails');
      }
      return { stdout: '{}', stderr: '' };
    },
    execGhWithRetryImpl: async () => ({
      stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-07-18T00:00:00Z', closedAt: '2026-07-18T00:00:00Z' }),
    }),
    rmSyncImpl: () => {
      throw new Error('permission denied');
    },
    limit: 10,
    logger: { info() {}, warn(message) { warnings.push(message); } },
  });

  assert.equal(result.reaped, 0);
  assert.equal(result.errors, 1);
  assert.equal(result.pruned, 0);
  assert.equal(
    calls.some((call) => call.cmd === 'git' && call.args.includes('remove')),
    true,
  );
  assert.equal(
    calls.some((call) => call.cmd === 'git' && call.args.includes('prune')),
    false,
  );
  assert.equal(existsSync(worktreePath), true);
  assert.equal(warnings.some((message) => message.includes('worktree-rm:permission denied')), true);
});

test('closer worktree reaper does not match injected gone text inside path', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-reap-injected-path-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const repoPath = join(hqRoot, 'repos', 'agent-os');
  const worktreePath = join(hqRoot, 'workers', 'hammer-ama-pr-4243-does-not-exist', 'agent-os');
  mkdirSync(worktreePath, { recursive: true });

  const calls = [];
  const warnings = [];
  const result = await reapCloserHammerWorktrees({
    hqRoot,
    cursorPath: join(root, 'cursor.json'),
    hqPath: '/bin/hq',
    repoPaths: [repoPath],
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      const joined = args.join(' ');
      if (cmd === 'git' && joined.includes('remote get-url origin')) {
        return { stdout: 'git@github.com:laceyenterprises/agent-os.git\n', stderr: '' };
      }
      if (cmd === 'git' && joined.includes('worktree list --porcelain')) {
        return {
          stdout: [
            `worktree ${worktreePath}`,
            'branch refs/heads/codex/busy',
            '',
          ].join('\n'),
          stderr: '',
        };
      }
      if (cmd === 'git' && args.includes('remove')) {
        const err = new Error('git worktree remove failed');
        err.stderr = `error: failed to delete '${worktreePath}': Directory not empty`;
        throw err;
      }
      return { stdout: '{}', stderr: '' };
    },
    execGhWithRetryImpl: async () => ({
      stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-07-18T00:00:00Z', closedAt: '2026-07-18T00:00:00Z' }),
    }),
    limit: 10,
    logger: { info() {}, warn(message) { warnings.push(message); } },
  });

  assert.equal(result.reaped, 0);
  assert.equal(result.errors, 1);
  assert.equal(result.pruned, 0);
  assert.equal(existsSync(worktreePath), true);
  assert.equal(
    calls.some((call) => call.cmd === 'git' && call.args.includes('prune')),
    false,
  );
  assert.equal(warnings.some((message) => message.includes('remove-incomplete')), true);
});

test('closer worktree reaper still errors when a present worktree dir cannot be removed', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-reap-nonempty-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const repoPath = join(hqRoot, 'repos', 'agent-os');
  const worktreePath = join(hqRoot, 'workers', 'hammer-ama-pr-4244-busy', 'agent-os');
  mkdirSync(worktreePath, { recursive: true });

  const calls = [];
  const warnings = [];
  const result = await reapCloserHammerWorktrees({
    hqRoot,
    cursorPath: join(root, 'cursor.json'),
    hqPath: '/bin/hq',
    repoPaths: [repoPath],
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      const joined = args.join(' ');
      if (cmd === 'git' && joined.includes('remote get-url origin')) {
        return { stdout: 'git@github.com:laceyenterprises/agent-os.git\n', stderr: '' };
      }
      if (cmd === 'git' && joined.includes('worktree list --porcelain')) {
        return {
          stdout: [
            `worktree ${worktreePath}`,
            'branch refs/heads/codex/busy',
            '',
          ].join('\n'),
          stderr: '',
        };
      }
      if (cmd === 'git' && args.includes('remove')) {
        const err = new Error('git worktree remove failed');
        err.stderr = `error: failed to delete '${worktreePath}': Directory not empty`;
        throw err;
      }
      return { stdout: '{}', stderr: '' };
    },
    execGhWithRetryImpl: async () => ({
      stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-07-18T00:00:00Z', closedAt: '2026-07-18T00:00:00Z' }),
    }),
    limit: 10,
    logger: { info() {}, warn(message) { warnings.push(message); } },
  });

  // A physically-present dir that git could not delete stays a real error and
  // is not silently pruned away.
  assert.equal(result.reaped, 0);
  assert.equal(result.errors, 1);
  assert.equal(result.pruned, 0);
  assert.equal(
    calls.some((call) => call.cmd === 'git' && call.args.includes('prune')),
    false,
  );
  assert.equal(warnings.some((message) => message.includes('remove-incomplete')), true);
});

test('closer worktree reaper does not let active matching workers shield later stale workers', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-reap-large-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const workersRoot = join(hqRoot, 'workers');
  const repoPath = join(hqRoot, 'repos', 'agent-os');
  mkdirSync(repoPath, { recursive: true });
  for (let index = 0; index < 100; index += 1) {
    mkdirSync(
      join(workersRoot, `hammer-ama-pr-${String(1_000 + index)}-active`, 'agent-os'),
      { recursive: true },
    );
  }
  mkdirSync(join(workersRoot, 'hammer-ama-pr-9999-stale', 'agent-os'), { recursive: true });

  const cursorPath = join(root, 'cursor.json');
  const scanCounts = [];
  let reaped = 0;
  let halfRegistered = 0;
  for (let pass = 0; pass < 3; pass += 1) {
    const result = await reapCloserHammerWorktrees({
      hqRoot,
      hqPath: '/bin/hq',
      cursorPath,
      repoPaths: [repoPath],
      scanLimit: 50,
      execFileImpl: async (cmd, args) => {
        if (cmd === 'git' && args.includes('list')) {
          return {
            stdout: Array.from({ length: 100 }, (_, index) => [
              `worktree ${join(workersRoot, `hammer-ama-pr-${String(1_000 + index)}-active`, 'agent-os')}`,
              `branch refs/heads/active-${index}`,
              '',
            ].join('\n')).join('\n'),
            stderr: '',
          };
        }
        if (cmd === 'git' && args.includes('get-url')) return { stdout: 'https://github.com/x/y.git\n', stderr: '' };
        return { stdout: '{}', stderr: '' };
      },
      execGhWithRetryImpl: async () => ({
        stdout: JSON.stringify({ state: 'OPEN', mergedAt: null, closedAt: null }),
      }),
      limit: 10,
      logger: { info() {}, warn() {} },
    });
    scanCounts.push(result.scanned);
    reaped += result.reaped;
    halfRegistered += result.halfRegistered;
  }

  assert.deepEqual(scanCounts, [50, 50, 1]);
  assert.equal(reaped, 1);
  assert.equal(halfRegistered, 1);
});

test('closer worktree discovery skips unreadable or non-directory roots', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-reap-unreadable-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const warnings = [];
  const result = await reapCloserHammerWorktrees({
    hqRoot: join(root, 'hq'),
    cursorPath: join(root, 'cursor.json'),
    readdirImpl: async (path) => {
      const err = new Error('unreadable');
      err.code = path.endsWith('/repos') ? 'EACCES' : 'ENOTDIR';
      throw err;
    },
    logger: { info() {}, warn(message) { warnings.push(message); } },
  });

  assert.equal(result.scanned, 0);
  assert.equal(result.cursorPersisted, true);
  assert.equal(warnings.some((message) => message.includes('code=EACCES')), true);
  assert.equal(warnings.some((message) => message.includes('code=ENOTDIR')), true);
});

test('closer worktree parser handles porcelain and GitHub remote URLs', () => {
  assert.deepEqual(parseGitWorktreePorcelain('worktree /tmp/wt\nbranch refs/heads/x\nprunable stale\n\n'), [
    { path: '/tmp/wt', prunable: true, branch: 'refs/heads/x', prunableReason: 'stale' },
  ]);
  assert.equal(parseGitHubRepoFromRemote('git@github.com:owner/repo.git\n'), 'owner/repo');
  assert.equal(parseGitHubRepoFromRemote('https://github.com/owner/repo.git'), 'owner/repo');
});

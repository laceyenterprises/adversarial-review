import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

test('closer worktree parser handles porcelain and GitHub remote URLs', () => {
  assert.deepEqual(parseGitWorktreePorcelain('worktree /tmp/wt\nbranch refs/heads/x\nprunable stale\n\n'), [
    { path: '/tmp/wt', prunable: true, branch: 'refs/heads/x', prunableReason: 'stale' },
  ]);
  assert.equal(parseGitHubRepoFromRemote('git@github.com:owner/repo.git\n'), 'owner/repo');
  assert.equal(parseGitHubRepoFromRemote('https://github.com/owner/repo.git'), 'owner/repo');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('closer worktree reaper removes unresolvable hammer directories instead of hiding them', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-reap-unresolvable-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const repoPath = join(hqRoot, 'repos', 'agent-os');
  const workerDir = join(hqRoot, 'workers', 'hammer-ama-pr-3065-corrupt');
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, 'workspace.json'), '{not-json');

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

  assert.equal(result.scanned, 1);
  assert.equal(result.reaped, 1);
  assert.equal(result.halfRegistered, 1);
  assert.equal(ghCalled, false);
  assert.equal(existsSync(workerDir), false);
  assert.equal(
    calls.some((call) => call.cmd === '/bin/hq' && call.args[2] === 'hammer-ama-pr-3065-corrupt'),
    true,
  );
});

test('closer worktree reaper discovers dedicated-base non-agent-os hammer worktrees from the manifest', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-reap-cross-repo-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const deployRepoPath = join(hqRoot, 'repos', 'adversarial-review');
  const workerBasePath = join(hqRoot, 'worker-base', 'adversarial-review');
  const workerDir = join(hqRoot, 'workers', 'hammer-ama-pr-760-cross-repo');
  const worktreePath = join(workerDir, 'adversarial-review');
  mkdirSync(deployRepoPath, { recursive: true });
  mkdirSync(workerBasePath, { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(join(workerDir, 'workspace.json'), JSON.stringify({
    workerId: 'hammer-ama-pr-760-cross-repo',
    repo: 'adversarial-review',
    repos: ['adversarial-review', 'agent-os'],
    workspacePath: worktreePath,
    worktreePath,
  }));

  const calls = [];
  const result = await reapCloserHammerWorktrees({
    hqRoot,
    cursorPath: join(root, 'cursor.json'),
    hqPath: '/bin/hq',
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      const repoPath = args[1];
      const joined = args.join(' ');
      if (cmd === 'git' && joined.includes('remote get-url origin')) {
        return { stdout: 'git@github.com:laceyenterprises/adversarial-review.git\n', stderr: '' };
      }
      if (cmd === 'git' && joined.includes('worktree list --porcelain')) {
        return {
          stdout: repoPath === workerBasePath
            ? [`worktree ${workerBasePath}`, 'branch refs/heads/main', '', `worktree ${worktreePath}`, 'branch refs/heads/SDR-04', ''].join('\n')
            : [`worktree ${deployRepoPath}`, 'branch refs/heads/main', ''].join('\n'),
          stderr: '',
        };
      }
      return { stdout: '{}', stderr: '' };
    },
    execGhWithRetryImpl: async () => ({
      stdout: JSON.stringify({ state: 'OPEN', mergedAt: null, closedAt: null }),
    }),
    limit: 10,
    logger: { info() {}, warn() {} },
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.reaped, 0);
  assert.equal(result.open, 1);
  assert.equal(result.halfRegistered, 0);
  assert.equal(
    calls.some((call) => call.cmd === '/bin/hq' && call.args[2] === 'hammer-ama-pr-760-cross-repo'),
    false,
  );
});

test('closer worktree reaper evaluates a multi-repo hammer worker once', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-reap-multi-repo-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const adversarialBase = join(hqRoot, 'worker-base', 'adversarial-review');
  const agentOsBase = join(hqRoot, 'worker-base', 'agent-os');
  const workerDir = join(hqRoot, 'workers', 'hammer-ama-pr-760-multi-repo');
  const adversarialWorktree = join(workerDir, 'adversarial-review');
  const agentOsWorktree = join(workerDir, 'agent-os');
  mkdirSync(adversarialWorktree, { recursive: true });
  mkdirSync(agentOsWorktree, { recursive: true });
  writeFileSync(join(workerDir, 'workspace.json'), JSON.stringify({
    workerId: 'hammer-ama-pr-760-multi-repo',
    repo: 'adversarial-review',
    repos: ['adversarial-review', 'agent-os'],
    workspacePath: adversarialWorktree,
    worktreePath: adversarialWorktree,
  }));

  let ghCalls = 0;
  const result = await reapCloserHammerWorktrees({
    hqRoot,
    cursorPath: join(root, 'cursor.json'),
    hqPath: '/bin/hq',
    repoPaths: [adversarialBase, agentOsBase],
    execFileImpl: async (cmd, args) => {
      const repoPath = args[1];
      const joined = args.join(' ');
      if (cmd === 'git' && joined.includes('remote get-url origin')) {
        const repo = repoPath === adversarialBase ? 'adversarial-review' : 'agent-os';
        return { stdout: `git@github.com:laceyenterprises/${repo}.git\n`, stderr: '' };
      }
      if (cmd === 'git' && joined.includes('worktree list --porcelain')) {
        const worktreePath = repoPath === adversarialBase ? adversarialWorktree : agentOsWorktree;
        return {
          stdout: [`worktree ${repoPath}`, 'branch refs/heads/main', '', `worktree ${worktreePath}`, 'branch refs/heads/SDR-04', ''].join('\n'),
          stderr: '',
        };
      }
      return { stdout: '{}', stderr: '' };
    },
    execGhWithRetryImpl: async () => {
      ghCalls += 1;
      return { stdout: JSON.stringify({ state: 'OPEN', mergedAt: null, closedAt: null }) };
    },
    limit: 10,
    logger: { info() {}, warn() {} },
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.reaped, 0);
  assert.equal(result.open, 1);
  assert.equal(result.halfRegistered, 0);
  assert.equal(ghCalls, 1);
});

test('closer worktree reaper removes every registered worktree for one terminal multi-repo worker', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-reap-multi-terminal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const adversarialBase = join(hqRoot, 'worker-base', 'adversarial-review');
  const agentOsBase = join(hqRoot, 'worker-base', 'agent-os');
  const workerDir = join(hqRoot, 'workers', 'hammer-ama-pr-760-terminal');
  const adversarialWorktree = join(workerDir, 'adversarial-review');
  const agentOsWorktree = join(workerDir, 'agent-os');
  mkdirSync(adversarialWorktree, { recursive: true });
  mkdirSync(agentOsWorktree, { recursive: true });
  writeFileSync(join(workerDir, 'workspace.json'), JSON.stringify({
    workerId: 'hammer-ama-pr-760-terminal',
    repo: 'adversarial-review',
    repos: ['adversarial-review', 'agent-os'],
    workspacePath: adversarialWorktree,
  }));

  const calls = [];
  let ghCalls = 0;
  const result = await reapCloserHammerWorktrees({
    hqRoot,
    cursorPath: join(root, 'cursor.json'),
    hqPath: '/bin/hq',
    repoPaths: [adversarialBase, agentOsBase],
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      const repoPath = args[1];
      const joined = args.join(' ');
      if (cmd === 'git' && joined.includes('remote get-url origin')) {
        const repo = repoPath === adversarialBase ? 'adversarial-review' : 'agent-os';
        return { stdout: `git@github.com:laceyenterprises/${repo}.git\n`, stderr: '' };
      }
      if (cmd === 'git' && joined.includes('worktree list --porcelain')) {
        const worktreePath = repoPath === adversarialBase ? adversarialWorktree : agentOsWorktree;
        return {
          stdout: [`worktree ${repoPath}`, 'branch refs/heads/main', '', `worktree ${worktreePath}`, 'branch refs/heads/SDR-04', ''].join('\n'),
          stderr: '',
        };
      }
      return { stdout: '{}', stderr: '' };
    },
    execGhWithRetryImpl: async () => {
      ghCalls += 1;
      return {
        stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-08-03T00:00:00Z', closedAt: '2026-08-03T00:00:00Z' }),
      };
    },
    limit: 10,
    logger: { info() {}, warn() {} },
  });

  const removeTargets = calls
    .filter((call) => call.cmd === 'git' && call.args.includes('remove'))
    .map((call) => call.args.at(-1))
    .sort();
  assert.deepEqual(removeTargets, [adversarialWorktree, agentOsWorktree].sort());
  assert.equal(
    calls.filter((call) => call.cmd === '/bin/hq' && call.args[1] === 'tear-down').length,
    1,
  );
  assert.equal(result.scanned, 1);
  assert.equal(result.reaped, 1);
  assert.equal(ghCalls, 1);
});

test('closer worktree reaper groups stale registrations even when the worker directory is gone', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-reap-registered-only-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const adversarialBase = join(hqRoot, 'worker-base', 'adversarial-review');
  const agentOsBase = join(hqRoot, 'worker-base', 'agent-os');
  const workerDir = join(hqRoot, 'workers', 'hammer-ama-pr-760-registered-only');
  const adversarialWorktree = join(workerDir, 'adversarial-review');
  const agentOsWorktree = join(workerDir, 'agent-os');
  mkdirSync(join(hqRoot, 'workers'), { recursive: true });

  const calls = [];
  let ghCalls = 0;
  const result = await reapCloserHammerWorktrees({
    hqRoot,
    cursorPath: join(root, 'cursor.json'),
    hqPath: '/bin/hq',
    repoPaths: [adversarialBase, agentOsBase],
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      const repoPath = args[1];
      const joined = args.join(' ');
      if (cmd === 'git' && joined.includes('remote get-url origin')) {
        const repo = repoPath === adversarialBase ? 'adversarial-review' : 'agent-os';
        return { stdout: `git@github.com:laceyenterprises/${repo}.git\n`, stderr: '' };
      }
      if (cmd === 'git' && joined.includes('worktree list --porcelain')) {
        const worktreePath = repoPath === adversarialBase ? adversarialWorktree : agentOsWorktree;
        return {
          stdout: [`worktree ${repoPath}`, 'branch refs/heads/main', '', `worktree ${worktreePath}`, 'branch refs/heads/SDR-04', ''].join('\n'),
          stderr: '',
        };
      }
      return { stdout: '{}', stderr: '' };
    },
    execGhWithRetryImpl: async () => {
      ghCalls += 1;
      return {
        stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-08-03T00:00:00Z', closedAt: '2026-08-03T00:00:00Z' }),
      };
    },
    limit: 10,
    logger: { info() {}, warn() {} },
  });

  assert.equal(
    calls.filter((call) => call.cmd === 'git' && call.args.includes('prune')).length,
    2,
  );
  assert.equal(result.scanned, 1);
  assert.equal(result.reaped, 1);
  assert.equal(ghCalls, 1);
});

test('closer worktree reaper cleans a single-child legacy manifest without path fields', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-reap-legacy-manifest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const repoPath = join(hqRoot, 'repos', 'agent-os');
  const workerDir = join(hqRoot, 'workers', 'hammer-ama-pr-760-legacy');
  mkdirSync(join(workerDir, 'agent-os'), { recursive: true });
  writeFileSync(join(workerDir, 'workspace.json'), JSON.stringify({
    schemaVersion: 1,
    workerId: 'hammer-ama-pr-760-legacy',
    repo: 'agent-os',
  }));

  const result = await reapCloserHammerWorktrees({
    hqRoot,
    cursorPath: join(root, 'cursor.json'),
    hqPath: '/bin/hq',
    repoPaths: [repoPath],
    execFileImpl: async (cmd, args) => {
      if (cmd === 'git' && args.includes('list')) return { stdout: '', stderr: '' };
      if (cmd === 'git' && args.includes('get-url')) return { stdout: 'https://github.com/x/y.git\n', stderr: '' };
      return { stdout: '{}', stderr: '' };
    },
    limit: 10,
    logger: { info() {}, warn() {} },
  });

  assert.equal(result.reaped, 1);
  assert.equal(result.halfRegistered, 1);
  assert.equal(existsSync(workerDir), false);
});

test('closer worktree reaper retains both paths and cleans a single registration mismatch', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-reap-mismatch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const repoPath = join(hqRoot, 'worker-base', 'adversarial-review');
  const workerDir = join(hqRoot, 'workers', 'hammer-ama-pr-760-mismatch');
  const manifestWorktree = join(workerDir, 'adversarial-review');
  const registeredWorktree = join(workerDir, 'legacy-adversarial-review');
  mkdirSync(manifestWorktree, { recursive: true });
  mkdirSync(registeredWorktree, { recursive: true });
  writeFileSync(join(workerDir, 'workspace.json'), JSON.stringify({
    workerId: 'hammer-ama-pr-760-mismatch',
    repo: 'adversarial-review',
    workspacePath: manifestWorktree,
  }));

  const calls = [];
  const result = await reapCloserHammerWorktrees({
    hqRoot,
    cursorPath: join(root, 'cursor.json'),
    hqPath: '/bin/hq',
    repoPaths: [repoPath],
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      const joined = args.join(' ');
      if (cmd === 'git' && joined.includes('remote get-url origin')) {
        return { stdout: 'git@github.com:laceyenterprises/adversarial-review.git\n', stderr: '' };
      }
      if (cmd === 'git' && joined.includes('worktree list --porcelain')) {
        return {
          stdout: [`worktree ${repoPath}`, 'branch refs/heads/main', '', `worktree ${registeredWorktree}`, 'branch refs/heads/SDR-04', ''].join('\n'),
          stderr: '',
        };
      }
      return { stdout: '{}', stderr: '' };
    },
    execGhWithRetryImpl: async () => ({
      stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-08-03T00:00:00Z', closedAt: '2026-08-03T00:00:00Z' }),
    }),
    limit: 10,
    logger: { info() {}, warn() {} },
  });

  assert.equal(
    calls.some((call) => call.cmd === 'git' && call.args.includes('remove') && call.args.at(-1) === registeredWorktree),
    true,
  );
  assert.equal(result.reaped, 1);
  assert.equal(existsSync(workerDir), false);
});

test('closer worktree reaper preserves mismatched disk state when registered cleanup fails', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-reap-mismatch-error-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const repoPath = join(hqRoot, 'worker-base', 'adversarial-review');
  const workerDir = join(hqRoot, 'workers', 'hammer-ama-pr-760-mismatch-error');
  const manifestWorktree = join(workerDir, 'adversarial-review');
  const registeredWorktree = join(workerDir, 'legacy-adversarial-review');
  mkdirSync(manifestWorktree, { recursive: true });
  mkdirSync(registeredWorktree, { recursive: true });
  writeFileSync(join(workerDir, 'workspace.json'), JSON.stringify({
    workspacePath: manifestWorktree,
  }));

  const result = await reapCloserHammerWorktrees({
    hqRoot,
    cursorPath: join(root, 'cursor.json'),
    hqPath: '/bin/hq',
    repoPaths: [repoPath],
    execFileImpl: async (cmd, args) => {
      const joined = args.join(' ');
      if (cmd === 'git' && joined.includes('remote get-url origin')) {
        return { stdout: 'git@github.com:laceyenterprises/adversarial-review.git\n', stderr: '' };
      }
      if (cmd === 'git' && joined.includes('worktree list --porcelain')) {
        return {
          stdout: [`worktree ${repoPath}`, 'branch refs/heads/main', '', `worktree ${registeredWorktree}`, 'branch refs/heads/SDR-04', ''].join('\n'),
          stderr: '',
        };
      }
      if (cmd === 'git' && args.includes('remove')) {
        const err = new Error('registration cleanup failed');
        err.stderr = 'fatal: worktree contains modified or untracked files';
        throw err;
      }
      return { stdout: '{}', stderr: '' };
    },
    execGhWithRetryImpl: async () => ({
      stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-08-03T00:00:00Z', closedAt: '2026-08-03T00:00:00Z' }),
    }),
    limit: 10,
    logger: { info() {}, warn() {} },
  });

  assert.equal(result.reaped, 0);
  assert.equal(result.errors, 1);
  assert.equal(existsSync(workerDir), true);
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
  const workerDir = join(hqRoot, 'workers', 'hammer-ama-pr-4243-notree');
  const worktreePath = join(workerDir, 'agent-os');
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
  assert.equal(existsSync(workerDir), false);
  assert.equal(warnings.some((message) => message.includes('remove-incomplete')), false);
});

test('closer worktree reaper prunes when the invalid worker sandbox disappears during cleanup', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-reap-raced-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const repoPath = join(hqRoot, 'repos', 'agent-os');
  const workerDir = join(hqRoot, 'workers', 'hammer-ama-pr-4248-raced');
  const worktreePath = join(workerDir, 'agent-os');
  mkdirSync(worktreePath, { recursive: true });

  const calls = [];
  const warnings = [];
  let removedTarget = null;
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
            'branch refs/heads/codex/raced',
            '',
          ].join('\n'),
          stderr: '',
        };
      }
      if (cmd === 'git' && args.includes('remove')) {
        rmSync(workerDir, { recursive: true, force: true });
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
    rmSyncImpl: (target, options) => {
      removedTarget = target;
      rmSync(target, options);
    },
    limit: 10,
    logger: { info() {}, warn(message) { warnings.push(message); } },
  });

  assert.equal(result.reaped, 1);
  assert.equal(result.errors, 0);
  assert.equal(result.pruned, 1);
  assert.equal(removedTarget, workerDir);
  assert.equal(existsSync(workerDir), false);
  assert.equal(
    calls.some((call) => call.cmd === 'git' && call.args.includes('prune') && call.args.includes(repoPath)),
    true,
  );
  assert.equal(warnings.some((message) => message.includes('remove-incomplete')), false);
});

test('closer worktree reaper refuses invalid physical removal outside hq worker dir', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-reap-outside-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const repoPath = join(hqRoot, 'repos', 'agent-os');
  const outsideWorktreePath = join(root, 'outside', 'hammer-ama-pr-4246-outside', 'agent-os');
  mkdirSync(outsideWorktreePath, { recursive: true });

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
            `worktree ${outsideWorktreePath}`,
            'branch refs/heads/codex/outside',
            '',
          ].join('\n'),
          stderr: '',
        };
      }
      if (cmd === 'git' && args.includes('remove')) {
        const err = new Error('git worktree remove failed');
        err.stderr = `fatal: '${outsideWorktreePath}' is not a working tree`;
        throw err;
      }
      if (cmd === 'git' && args.includes('prune')) {
        throw new Error('git worktree prune should not run after physical removal is refused');
      }
      return { stdout: '{}', stderr: '' };
    },
    execGhWithRetryImpl: async () => ({
      stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-07-18T00:00:00Z', closedAt: '2026-07-18T00:00:00Z' }),
    }),
    rmSyncImpl: () => {
      throw new Error('rmSyncImpl should not be called for an out-of-bound worktree path');
    },
    limit: 10,
    logger: { info() {}, warn(message) { warnings.push(message); } },
  });

  assert.equal(result.reaped, 0);
  assert.equal(result.errors, 1);
  assert.equal(result.pruned, 0);
  assert.equal(existsSync(outsideWorktreePath), true);
  assert.equal(
    calls.some((call) => call.cmd === 'git' && call.args.includes('remove')),
    true,
  );
  assert.equal(
    calls.some((call) => call.cmd === 'git' && call.args.includes('prune')),
    false,
  );
  assert.equal(warnings.some((message) => message.includes('worktree-rm-refused:outside-worker-dir')), true);
});

test('closer worktree reaper validates invalid physical removal per registered worktree', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-reap-per-registration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const primaryBase = join(hqRoot, 'worker-base', 'adversarial-review');
  const secondaryBase = join(root, 'outside-base', 'agent-os');
  const workerId = 'hammer-ama-pr-4249-per-registration';
  const workerDir = join(hqRoot, 'workers', workerId);
  const primaryWorktree = join(workerDir, 'adversarial-review');
  const outsideWorkerDir = join(root, 'outside', workerId);
  const outsideWorktree = join(outsideWorkerDir, 'agent-os');
  mkdirSync(primaryWorktree, { recursive: true });
  mkdirSync(outsideWorktree, { recursive: true });
  writeFileSync(join(workerDir, 'workspace.json'), JSON.stringify({
    workerId,
    repo: 'adversarial-review',
    workspacePath: primaryWorktree,
  }));

  const calls = [];
  const rmTargets = [];
  const warnings = [];
  const result = await reapCloserHammerWorktrees({
    hqRoot,
    cursorPath: join(root, 'cursor.json'),
    hqPath: '/bin/hq',
    repoPaths: [primaryBase, secondaryBase],
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      const repoPath = args[1];
      const joined = args.join(' ');
      if (cmd === 'git' && joined.includes('remote get-url origin')) {
        const repo = repoPath === primaryBase ? 'adversarial-review' : 'agent-os';
        return { stdout: `git@github.com:laceyenterprises/${repo}.git\n`, stderr: '' };
      }
      if (cmd === 'git' && joined.includes('worktree list --porcelain')) {
        const worktreePath = repoPath === primaryBase ? primaryWorktree : outsideWorktree;
        return {
          stdout: [`worktree ${repoPath}`, 'branch refs/heads/main', '', `worktree ${worktreePath}`, 'branch refs/heads/SDR-04', ''].join('\n'),
          stderr: '',
        };
      }
      if (cmd === 'git' && args.includes('remove')) {
        const worktreePath = args.at(-1);
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
    rmSyncImpl: (target) => {
      rmTargets.push(target);
    },
    limit: 10,
    logger: { info() {}, warn(message) { warnings.push(message); } },
  });

  assert.equal(result.reaped, 0);
  assert.equal(result.errors, 1);
  assert.deepEqual(rmTargets, [workerDir]);
  assert.equal(
    calls.some((call) => call.cmd === 'git' && call.args.includes('remove') && call.args.at(-1) === primaryWorktree),
    true,
  );
  assert.equal(
    calls.some((call) => call.cmd === 'git' && call.args.includes('remove') && call.args.at(-1) === outsideWorktree),
    true,
  );
  assert.equal(warnings.some((message) => message.includes(`worktree-rm-refused:outside-worker-dir:${outsideWorktree}`)), true);
});

test('closer worktree reaper removes the worker sandbox without following a symlinked worktree child', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-reap-symlink-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const repoPath = join(hqRoot, 'repos', 'agent-os');
  const workerDir = join(hqRoot, 'workers', 'hammer-ama-pr-4247-symlink');
  const outsideTarget = join(root, 'outside-target');
  const worktreePath = join(workerDir, 'agent-os');
  mkdirSync(workerDir, { recursive: true });
  mkdirSync(outsideTarget, { recursive: true });
  symlinkSync(outsideTarget, worktreePath, 'dir');

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
            'branch refs/heads/codex/symlink',
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
    rmSyncImpl: (target, options) => {
      assert.equal(target, workerDir);
      rmSync(target, options);
    },
    limit: 10,
    logger: { info() {}, warn(message) { warnings.push(message); } },
  });

  assert.equal(result.reaped, 1);
  assert.equal(result.errors, 0);
  assert.equal(result.pruned, 1);
  assert.equal(existsSync(outsideTarget), true);
  assert.equal(existsSync(workerDir), false);
  assert.equal(
    calls.some((call) => call.cmd === 'git' && call.args.includes('remove')),
    true,
  );
  assert.equal(
    calls.some((call) => call.cmd === 'git' && call.args.includes('prune')),
    true,
  );
  assert.equal(warnings.some((message) => message.includes('remove-incomplete')), false);
});

test('closer worktree reaper keeps git metadata when invalid physical dir removal fails', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-reap-rmfail-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const repoPath = join(hqRoot, 'repos', 'agent-os');
  const workerDir = join(hqRoot, 'workers', 'hammer-ama-pr-4245-rmfail');
  const worktreePath = join(workerDir, 'agent-os');
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
    rmSyncImpl: (target) => {
      assert.equal(target, workerDir);
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

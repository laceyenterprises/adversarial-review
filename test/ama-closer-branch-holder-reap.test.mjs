import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { __testables__, samePrHammerHolderWorktreePaths } from '../src/ama/dispatch-closer.mjs';

// Verbatim provision error captured from the live deadlock (agent-os PR #3219,
// TCT-04): the hammer could not provision because the ORIGINAL coding worker's
// worktree still held the PR head branch. The historical name-only matcher
// (hammer-ama-pr-<PR> only) returned [] here, so the reap never fired and the
// PR could never close.
const HQ_ROOT = '/Users/airlock/agent-os-hq';

const TCT04_PROVISION_ERROR = {
  stderr: [
    '[hq] fetching latest origin/main in deploy checkout',
    '[hq] fetching PR head ref origin/claude-code-tct-04/TCT-04',
    "[hq] creating worktree at /Users/airlock/agent-os-hq/workers/hammer-ama-pr-3219/agent-os (tracking origin/claude-code-tct-04/TCT-04)",
    "[hq] refusing grace-waived git worktree holder drop for branch 'claude-code-tct-04/TCT-04': holder has unrecovered local state or could not be safely inspected: /Users/airlock/agent-os-hq/workers/claude-code-tct-04/agent-os",
    "fatal: 'claude-code-tct-04/TCT-04' is already used by worktree at '/Users/airlock/agent-os-hq/workers/claude-code-tct-04/agent-os'",
    "[hq] provision failed; cleaning up partial worktree state for 'hammer-ama-pr-3219'",
  ].join('\n'),
};

test('reaps the original coding worker worktree that holds the PR head branch', () => {
  const paths = samePrHammerHolderWorktreePaths(TCT04_PROVISION_ERROR, 3219, HQ_ROOT);
  assert.ok(
    paths.includes('/Users/airlock/agent-os-hq/workers/claude-code-tct-04/agent-os'),
    `expected the coding-worker holder to be reaped, got ${JSON.stringify(paths)}`,
  );
});

test('reaps BOTH a prior hammer-ama worktree and the original coding holder', () => {
  const err = {
    stderr: [
      '[hq] creating worktree at /Users/airlock/agent-os-hq/workers/hammer-ama-pr-3217/agent-os (tracking origin/codex-mcmo-01/MCMO-01)',
      "fatal: 'codex-mcmo-01/MCMO-01' is already used by worktree at '/Users/airlock/agent-os-hq/workers/codex-mcmo-01/agent-os'",
      '[hq] force-reclaimed stale own merge worktree for hammer-ama-pr-3217 at /Users/airlock/agent-os-hq/workers/hammer-ama-pr-3217/agent-os',
    ].join('\n'),
  };
  const paths = samePrHammerHolderWorktreePaths(err, 3217, HQ_ROOT);
  assert.ok(paths.includes('/Users/airlock/agent-os-hq/workers/codex-mcmo-01/agent-os'), JSON.stringify(paths));
  assert.ok(paths.includes('/Users/airlock/agent-os-hq/workers/hammer-ama-pr-3217/agent-os'), JSON.stringify(paths));
});

test('does not reap paths outside <hqRoot>/workers (scope guard)', () => {
  const err = {
    stderr: [
      "fatal: 'x/y' is already used by worktree at '/some/other/place/workers/evil/agent-os'",
      "note: unrelated /etc/passwd/agent-os mentioned in passing",
    ].join('\n'),
  };
  const paths = samePrHammerHolderWorktreePaths(err, 999, HQ_ROOT);
  assert.deepEqual(paths, [], `no path outside hqRoot/workers should be reaped, got ${JSON.stringify(paths)}`);
});

test('does not reap nested worker paths under hqRoot', () => {
  const err = {
    stderr: [
      "fatal: 'x/y' is already used by worktree at '/Users/airlock/agent-os-hq/workers/foo/bar/agent-os'",
      'branch-holder-blocked at /Users/airlock/agent-os-hq/workers/hammer-ama-pr-999/nested/agent-os',
    ].join('\n'),
  };
  const paths = samePrHammerHolderWorktreePaths(err, 999, HQ_ROOT);
  assert.deepEqual(paths, [], `nested worker paths should be rejected, got ${JSON.stringify(paths)}`);
});

test('reaps grace-waived holder paths whose worker id contains spaces', () => {
  const err = {
    stderr: [
      "[hq] refusing grace-waived git worktree holder drop for branch 'feature/x': holder has unrecovered local state: /Users/airlock/agent-os-hq/workers/codex branch holder/agent-os",
    ].join('\n'),
  };
  const paths = samePrHammerHolderWorktreePaths(err, 999, HQ_ROOT);
  assert.deepEqual(paths, ['/Users/airlock/agent-os-hq/workers/codex branch holder/agent-os']);
});

test('does not reap legacy hammer-ama paths outside hqRoot when hqRoot is known', () => {
  const err = {
    stderr: 'branch-holder-blocked at /tmp/workers/hammer-ama-pr-3064-live/agent-os',
  };
  const paths = samePrHammerHolderWorktreePaths(err, 3064, HQ_ROOT);
  assert.deepEqual(paths, [], `legacy hammer paths outside hqRoot should be ignored, got ${JSON.stringify(paths)}`);
});

test('without hqRoot, still accepts canonical /workers/<id>/agent-os shape but rejects arbitrary paths', () => {
  const err = {
    stderr: [
      "fatal: 'b' is already used by worktree at '/anywhere/workers/codex-foo/agent-os'",
      "note: /tmp/random/agent-os should be ignored",
    ].join('\n'),
  };
  const paths = samePrHammerHolderWorktreePaths(err, 42, undefined);
  assert.ok(paths.includes('/anywhere/workers/codex-foo/agent-os'), JSON.stringify(paths));
  assert.ok(!paths.includes('/tmp/random/agent-os'), JSON.stringify(paths));
});

test('preserves prior hammer-ama-pr-<PR> matching when no git holder clause is present', () => {
  const err = {
    stderr: 'branch-holder-blocked at /Users/airlock/agent-os-hq/workers/hammer-ama-pr-3064-live/agent-os',
  };
  const paths = samePrHammerHolderWorktreePaths(err, 3064, HQ_ROOT);
  assert.deepEqual(paths, ['/Users/airlock/agent-os-hq/workers/hammer-ama-pr-3064-live/agent-os']);
});

test('returns [] for empty / non-collision error', () => {
  assert.deepEqual(samePrHammerHolderWorktreePaths('', 3219, HQ_ROOT), []);
  assert.deepEqual(samePrHammerHolderWorktreePaths({ stderr: 'unrelated failure' }, 3219, HQ_ROOT), []);
});

test('teardown passes hqRoot through to parser and cleanup commands', async () => {
  const hqRoot = join(tmpdir(), `agent-os-hq-pass-through-${Date.now()}`);
  const codingWorkerId = 'claude-code-tct-04';
  writeBranchHolderWorker({ hqRoot, workerId: codingWorkerId, launchRequestId: 'lrq_pass_through' });
  const err = {
    stderr: [
      `[hq] creating worktree at ${hqRoot}/workers/hammer-ama-pr-3219/agent-os (tracking origin/claude-code-tct-04/TCT-04)`,
      `fatal: 'claude-code-tct-04/TCT-04' is already used by worktree at '${hqRoot}/workers/${codingWorkerId}/agent-os'`,
    ].join('\n'),
  };
  const calls = [];
  const result = await __testables__.teardownSamePrHammerHolder({
    err,
    prNumber: 3219,
    hqPath: '/opt/hq/bin/hq',
    hqRoot,
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    readLatestWorkerRunStatusImpl: async ({ launchRequestId }) => ({
      ok: true,
      row: {
        launch_request_id: launchRequestId,
        run_id: 'run-terminal',
        status: 'succeeded',
      },
    }),
    logger: { warn() {} },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.worktreePaths, [
    `${hqRoot}/workers/hammer-ama-pr-3219/agent-os`,
    `${hqRoot}/workers/${codingWorkerId}/agent-os`,
  ]);
  assert.deepEqual(calls.map(call => call.cmd), ['/opt/hq/bin/hq', 'git', '/opt/hq/bin/hq', 'git']);
  assert.deepEqual(calls[0].args, [
    'worker',
    'tear-down',
    'hammer-ama-pr-3219',
    '--force',
    '--root',
    hqRoot,
  ]);
  assert.equal(calls[1].args[1], `${hqRoot}/repos/agent-os`);
  assert.deepEqual(calls[2].args, [
    'worker',
    'tear-down',
    codingWorkerId,
    '--force',
    '--root',
    hqRoot,
  ]);
  assert.equal(calls[3].args[1], `${hqRoot}/repos/agent-os`);
});

function writeBranchHolderWorker({ hqRoot, workerId, launchRequestId }) {
  const workerDir = join(hqRoot, 'workers', workerId);
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, 'workspace.json'), JSON.stringify({
    workerId,
    launchRequestId,
  }));
  writeFileSync(join(workerDir, 'run.json'), JSON.stringify({
    runId: `run-${workerId}`,
  }));
}

test('terminal coding branch-holder is torn down and emits release telemetry', async () => {
  const hqRoot = join(tmpdir(), `agent-os-hq-terminal-${Date.now()}`);
  const workerId = 'codex-lsh-03-terminal';
  const launchRequestId = 'lrq_terminal_holder';
  writeBranchHolderWorker({ hqRoot, workerId, launchRequestId });
  const err = {
    stderr: `fatal: 'codex-lsh-03-terminal/LSH-03' is already used by worktree at '${hqRoot}/workers/${workerId}/agent-os'`,
  };
  const calls = [];
  const logs = [];

  const result = await __testables__.teardownSamePrHammerHolder({
    err,
    prNumber: 777,
    repo: 'agent-os',
    headSha: 'abc123',
    hqPath: '/opt/hq/bin/hq',
    hqRoot,
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    readLatestWorkerRunStatusImpl: async ({ launchRequestId: actual }) => {
      assert.equal(actual, launchRequestId);
      return {
        ok: true,
        row: {
          launch_request_id: launchRequestId,
          run_id: `run-${workerId}`,
          status: 'failed',
        },
      };
    },
    logger: { warn(line) { logs.push(JSON.parse(line)); } },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(call => call.cmd), ['/opt/hq/bin/hq', 'git']);
  assert.deepEqual(calls[0].args, ['worker', 'tear-down', workerId, '--force', '--root', hqRoot]);
  assert.equal(logs.some(log => (
    log.event === 'branch_holder_deadlock_released'
    && log.workerId === workerId
    && log.workerStatus === 'failed'
    && log.launchRequestId === launchRequestId
  )), true);
});

test('live coding branch-holder is not torn down and falls back to branch-holder backoff', async () => {
  const hqRoot = join(tmpdir(), `agent-os-hq-live-${Date.now()}`);
  const workerId = 'codex-lsh-03-live';
  writeBranchHolderWorker({ hqRoot, workerId, launchRequestId: 'lrq_live_holder' });
  const err = {
    stderr: `fatal: 'codex-lsh-03-live/LSH-03' is already used by worktree at '${hqRoot}/workers/${workerId}/agent-os'`,
  };
  const calls = [];

  const result = await __testables__.teardownSamePrHammerHolder({
    err,
    prNumber: 778,
    hqPath: '/opt/hq/bin/hq',
    hqRoot,
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      throw new Error('execFileImpl must not run for a non-terminal holder');
    },
    readLatestWorkerRunStatusImpl: async () => ({
      ok: true,
      row: {
        launch_request_id: 'lrq_live_holder',
        run_id: `run-${workerId}`,
        status: 'running',
      },
    }),
    logger: { warn() {} },
  });

  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
  assert.equal(result.attempts[0].action, 'terminal-branch-holder-preflight');
  assert.equal(result.attempts[0].skipped, true);
  assert.equal(result.attempts[0].reason, 'worker-run-status-running');
});

test('terminal coding branch-holder teardown failure returns fallback result without crashing', async () => {
  const hqRoot = join(tmpdir(), `agent-os-hq-teardown-fails-${Date.now()}`);
  const workerId = 'codex-lsh-03-teardown-fails';
  writeBranchHolderWorker({ hqRoot, workerId, launchRequestId: 'lrq_teardown_fails' });
  const err = {
    stderr: `fatal: 'codex-lsh-03-teardown-fails/LSH-03' is already used by worktree at '${hqRoot}/workers/${workerId}/agent-os'`,
  };

  const result = await __testables__.teardownSamePrHammerHolder({
    err,
    prNumber: 779,
    hqPath: '/opt/hq/bin/hq',
    hqRoot,
    execFileImpl: async (cmd) => {
      if (cmd === 'git') return { stdout: '', stderr: '' };
      const failure = new Error('teardown failed');
      failure.stderr = 'boom';
      throw failure;
    },
    readLatestWorkerRunStatusImpl: async () => ({
      ok: true,
      row: {
        launch_request_id: 'lrq_teardown_fails',
        run_id: `run-${workerId}`,
        status: 'cancelled',
      },
    }),
    logger: { warn() {} },
  });

  assert.equal(result.ok, false);
  assert.equal(result.attempts.some(attempt => (
    attempt.action === 'hq-worker-tear-down'
    && attempt.workerId === workerId
    && attempt.ok === false
    && attempt.error === 'boom'
  )), true);
  assert.equal(result.attempts.some(attempt => attempt.action === 'git-worktree-remove'), false);
});

test('missing branch-holder metadata files are treated as unresolved state', async () => {
  const hqRoot = join(tmpdir(), `agent-os-hq-missing-metadata-${Date.now()}`);
  const workerId = 'codex-lsh-03-missing-metadata';
  mkdirSync(join(hqRoot, 'workers', workerId), { recursive: true });

  const result = await __testables__.resolveTerminalCodingBranchHolder({
    workerId,
    hqRoot,
    readLatestWorkerRunStatusImpl: async () => {
      throw new Error('ledger lookup should not run without a launchRequestId');
    },
  });

  assert.deepEqual(result, {
    terminal: false,
    reason: 'missing-launch-request-id',
    runId: null,
  });
});

test('pre-provision reclaim tears down stale self-owned hammer worktree and emits audit', async () => {
  const calls = [];
  const logs = [];
  const now = 1_800_000;
  const result = await __testables__.reclaimSelfOwnedHammerCloserWorktreeBeforeProvision({
    repo: 'owner/agent-os',
    prNumber: 3312,
    workerClass: 'hammer',
    hqPath: '/opt/hq/bin/hq',
    hqRoot: HQ_ROOT,
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    existsSyncImpl: (path) => path === '/Users/airlock/agent-os-hq/workers/hammer-ama-pr-3312/agent-os',
    statSyncImpl: () => ({ mtimeMs: now - 41_000 }),
    nowMs: () => now,
    logger: { info(line) { logs.push(JSON.parse(line)); }, warn() {} },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{
    cmd: '/opt/hq/bin/hq',
    args: ['worker', 'tear-down', 'hammer-ama-pr-3312', '--force', '--root', HQ_ROOT],
  }]);
  assert.deepEqual(logs, [{
    event: 'closer_provision_collision_reclaimed',
    repo: 'owner/agent-os',
    prNumber: 3312,
    workerId: 'hammer-ama-pr-3312',
    worktreePath: '/Users/airlock/agent-os-hq/workers/hammer-ama-pr-3312/agent-os',
    action: 'hq-worker-tear-down',
    force: true,
    status: 'reclaimed',
    worktreeAgeMs: 41000,
  }]);
});

test('pre-provision reclaim retries transient teardown failures before provisioning', async () => {
  const calls = [];
  const sleeps = [];
  const result = await __testables__.reclaimSelfOwnedHammerCloserWorktreeBeforeProvision({
    repo: 'owner/agent-os',
    prNumber: 3312,
    workerClass: 'hammer',
    hqPath: '/opt/hq/bin/hq',
    hqRoot: `${HQ_ROOT}  `,
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      if (calls.length < 3) {
        const err = new Error('resource temporarily unavailable');
        err.code = 'EAGAIN';
        throw err;
      }
      return { stdout: '', stderr: '' };
    },
    existsSyncImpl: (path) => path === '/Users/airlock/agent-os-hq/workers/hammer-ama-pr-3312/agent-os',
    statSyncImpl: () => ({ mtimeMs: 0 }),
    sleepImpl: async (ms) => { sleeps.push(ms); },
    logger: { info() {}, warn() {} },
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [250, 1000]);
  assert.deepEqual(calls.map(call => call.args), [
    ['worker', 'tear-down', 'hammer-ama-pr-3312', '--force', '--root', HQ_ROOT],
    ['worker', 'tear-down', 'hammer-ama-pr-3312', '--force', '--root', HQ_ROOT],
    ['worker', 'tear-down', 'hammer-ama-pr-3312', '--force', '--root', HQ_ROOT],
  ]);
});

test('pre-provision reclaim does not retry non-transient teardown failures and logs structured warning', async () => {
  const calls = [];
  const sleeps = [];
  const warnings = [];
  const result = await __testables__.reclaimSelfOwnedHammerCloserWorktreeBeforeProvision({
    repo: 'owner/agent-os',
    prNumber: 3312,
    workerClass: 'hammer',
    hqPath: '/opt/hq/bin/hq',
    hqRoot: HQ_ROOT,
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      const err = new Error('fatal: unrecoverable teardown error');
      err.stderr = 'fatal: unrecoverable teardown error';
      throw err;
    },
    existsSyncImpl: (path) => path === '/Users/airlock/agent-os-hq/workers/hammer-ama-pr-3312/agent-os',
    sleepImpl: async (ms) => { sleeps.push(ms); },
    logger: { info() {}, warn(line) { warnings.push(JSON.parse(line)); } },
  });

  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
  assert.deepEqual(warnings, [{
    event: 'closer_provision_collision_reclaim_failed',
    repo: 'owner/agent-os',
    prNumber: 3312,
    workerId: 'hammer-ama-pr-3312',
    worktreePath: '/Users/airlock/agent-os-hq/workers/hammer-ama-pr-3312/agent-os',
    action: 'hq-worker-tear-down',
    force: true,
    status: 'failed',
    error: 'fatal: unrecoverable teardown error',
    transient: false,
    attempts: 1,
  }]);
});

test('pre-provision reclaim logs exhausted transient retries before provisioning', async () => {
  const calls = [];
  const sleeps = [];
  const warnings = [];
  const result = await __testables__.reclaimSelfOwnedHammerCloserWorktreeBeforeProvision({
    repo: 'owner/agent-os',
    prNumber: 3312,
    workerClass: 'hammer',
    hqPath: '/opt/hq/bin/hq',
    hqRoot: HQ_ROOT,
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      const err = new Error('spawn ETIMEDOUT');
      err.code = 'ETIMEDOUT';
      throw err;
    },
    existsSyncImpl: (path) => path === '/Users/airlock/agent-os-hq/workers/hammer-ama-pr-3312/agent-os',
    sleepImpl: async (ms) => { sleeps.push(ms); },
    logger: { info() {}, warn(line) { warnings.push(JSON.parse(line)); } },
  });

  assert.equal(result.ok, false);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [250, 1000]);
  assert.deepEqual(warnings, [{
    event: 'closer_provision_collision_reclaim_failed',
    repo: 'owner/agent-os',
    prNumber: 3312,
    workerId: 'hammer-ama-pr-3312',
    worktreePath: '/Users/airlock/agent-os-hq/workers/hammer-ama-pr-3312/agent-os',
    action: 'hq-worker-tear-down',
    force: true,
    status: 'failed',
    error: 'spawn ETIMEDOUT',
    transient: true,
    attempts: 3,
  }]);
});

test('pre-provision reclaim reports missing hqRoot separately from invalid worker id', async () => {
  const result = await __testables__.reclaimSelfOwnedHammerCloserWorktreeBeforeProvision({
    repo: 'owner/agent-os',
    prNumber: 3312,
    workerClass: 'hammer',
    hqPath: '/opt/hq/bin/hq',
    hqRoot: '   ',
    execFileImpl: async () => assert.fail('must not tear down without hqRoot'),
    existsSyncImpl: () => true,
    logger: { info() {}, warn() {} },
  });

  assert.equal(result.attempted, false);
  assert.equal(result.reason, 'invalid-hq-root');
  assert.equal(result.workerId, 'hammer-ama-pr-3312');
});

test('pre-provision reclaim is unchanged when no self-owned stale worktree exists', async () => {
  const calls = [];
  const result = await __testables__.reclaimSelfOwnedHammerCloserWorktreeBeforeProvision({
    repo: 'owner/agent-os',
    prNumber: 3312,
    workerClass: 'hammer',
    hqPath: '/opt/hq/bin/hq',
    hqRoot: HQ_ROOT,
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    existsSyncImpl: () => false,
    logger: { info() {}, warn() {} },
  });

  assert.equal(result.attempted, false);
  assert.equal(result.reason, 'worktree-absent');
  assert.deepEqual(calls, []);
});

test('pre-provision reclaim never tears down a non-closer worker class', async () => {
  const calls = [];
  const result = await __testables__.reclaimSelfOwnedHammerCloserWorktreeBeforeProvision({
    repo: 'owner/agent-os',
    prNumber: 3312,
    workerClass: 'codex',
    hqPath: '/opt/hq/bin/hq',
    hqRoot: HQ_ROOT,
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    existsSyncImpl: () => true,
    logger: { info() {}, warn() {} },
  });

  assert.equal(result.attempted, false);
  assert.equal(result.reason, 'not-hammer-worker-class');
  assert.deepEqual(calls, []);
});

test('pre-provision reclaim never tears down a different hammer worker id', async () => {
  const calls = [];
  const existingPaths = new Set([
    '/Users/airlock/agent-os-hq/workers/hammer-ama-pr-9999/agent-os',
  ]);
  const result = await __testables__.reclaimSelfOwnedHammerCloserWorktreeBeforeProvision({
    repo: 'owner/agent-os',
    prNumber: 3312,
    workerClass: 'hammer',
    hqPath: '/opt/hq/bin/hq',
    hqRoot: HQ_ROOT,
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    existsSyncImpl: (path) => existingPaths.has(path),
    logger: { info() {}, warn() {} },
  });

  assert.equal(result.attempted, false);
  assert.equal(result.reason, 'worktree-absent');
  assert.equal(result.workerId, 'hammer-ama-pr-3312');
  assert.deepEqual(calls, []);
});

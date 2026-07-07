import test from 'node:test';
import assert from 'node:assert/strict';

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
  const calls = [];
  const result = await __testables__.teardownSamePrHammerHolder({
    err: TCT04_PROVISION_ERROR,
    prNumber: 3219,
    hqPath: '/opt/hq/bin/hq',
    hqRoot: HQ_ROOT,
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    logger: { warn() {} },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.worktreePaths, [
    '/Users/airlock/agent-os-hq/workers/hammer-ama-pr-3219/agent-os',
    '/Users/airlock/agent-os-hq/workers/claude-code-tct-04/agent-os',
  ]);
  assert.deepEqual(calls.map(call => call.cmd), ['git', '/opt/hq/bin/hq', 'git', '/opt/hq/bin/hq']);
  assert.equal(calls[0].args[1], '/Users/airlock/agent-os-hq/repos/agent-os');
  assert.deepEqual(calls[1].args, [
    'worker',
    'tear-down',
    'hammer-ama-pr-3219',
    '--force',
    '--root',
    HQ_ROOT,
  ]);
  assert.equal(calls[2].args[1], '/Users/airlock/agent-os-hq/repos/agent-os');
  assert.deepEqual(calls[3].args, [
    'worker',
    'tear-down',
    'claude-code-tct-04',
    '--force',
    '--root',
    HQ_ROOT,
  ]);
});

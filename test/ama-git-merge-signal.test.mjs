import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { __testables__ } from '../src/ama/dispatch-closer.mjs';

test('AMA closer emits worker.git.merge_signal with merge commit metadata best-effort', async () => {
  const calls = [];
  await __testables__.emitWorkerGitMergeSignalBestEffort({
    execFileImpl: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { stdout: '{"status":"recorded"}', stderr: '' };
    },
    hqRoot: '/tmp/hq',
    repo: 'laceyenterprises/agent-os',
    prNumber: 3311,
    launchRequestId: 'lrq_hammer_1',
    ticketRef: 'WGS-02',
    mergeCommitSha: 'a'.repeat(40),
    mergedBy: 'hammer',
    mode: 'squash',
    logger: { warn() {} },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'python3');
  assert.deepEqual(calls[0].args.slice(0, 4), ['-m', 'cwp_dispatch.git_signal', 'emit', '--root']);
  assert.equal(calls[0].args[calls[0].args.indexOf('--event-type') + 1], 'worker.git.merge_signal');
  assert.equal(calls[0].args[calls[0].args.indexOf('--launch-request-id') + 1], 'lrq_hammer_1');
  assert.equal(calls[0].args[calls[0].args.indexOf('--ticket-ref') + 1], 'WGS-02');
  assert.equal(calls[0].args[calls[0].args.indexOf('--pr-number') + 1], '3311');
  assert.equal(calls[0].args[calls[0].args.indexOf('--merge-commit-sha') + 1], 'a'.repeat(40));
  assert.equal(calls[0].args[calls[0].args.indexOf('--merged-by') + 1], 'hammer');
  assert.equal(calls[0].args[calls[0].args.indexOf('--mode') + 1], 'squash');
  assert.match(calls[0].options.env.PYTHONPATH, /modules\/worker-pool\/lib\/python/);
});

test('AMA closer merge signal emission is fail-open', async () => {
  const warnings = [];
  await __testables__.emitWorkerGitMergeSignalBestEffort({
    execFileImpl: async () => {
      throw new Error('ledger unavailable');
    },
    hqRoot: '/tmp/hq',
    repo: 'laceyenterprises/agent-os',
    prNumber: 3311,
    mergeCommitSha: 'b'.repeat(40),
    logger: { warn: (msg) => warnings.push(msg) },
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /git_merge_signal_emit_nonfatal/);
});

test('hammer prompt emits merge signal after confirmed merge and lease release', () => {
  const prompt = readFileSync(new URL('../templates/hammer-prompt.md', import.meta.url), 'utf8');
  assert.match(prompt, /ham_emit_git_merge_signal\(\)/);
  assert.match(prompt, /EVENT_MERGE_SIGNAL/);
  assert.ok(
    prompt.indexOf('ham_release_merge_lease\n  ham_emit_git_merge_signal') > prompt.indexOf('HAM_MERGE_COMMIT='),
    'merge signal should run after merge commit capture and lease release',
  );
});

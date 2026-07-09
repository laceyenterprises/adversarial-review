import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { __testables__ } from '../src/ama/dispatch-closer.mjs';

test('AMA closer emits worker.git.merge_signal with merge commit metadata', async () => {
  const calls = [];
  const emitted = await __testables__.emitWorkerGitMergeSignalBestEffort({
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

  assert.equal(emitted, true);
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

test('AMA closer merge signal emission reports failure', async () => {
  const warnings = [];
  const emitted = await __testables__.emitWorkerGitMergeSignalBestEffort({
    execFileImpl: async () => {
      throw new Error('ledger unavailable');
    },
    hqRoot: '/tmp/hq',
    repo: 'laceyenterprises/agent-os',
    prNumber: 3311,
    mergeCommitSha: 'b'.repeat(40),
    logger: { warn: (msg) => warnings.push(msg) },
  });

  assert.equal(emitted, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /git_merge_signal_emit_nonfatal/);
});

test('AMA closer merge commit lookup retries transient gh failures', async () => {
  const calls = [];
  const warnings = [];
  const sha = 'c'.repeat(40);
  const result = await __testables__.fetchMergeCommitShaBestEffort({
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      if (calls.length === 1) {
        const err = new Error('TLS handshake timeout');
        err.stderr = 'TLS handshake timeout';
        throw err;
      }
      return { stdout: JSON.stringify({ mergeCommit: { oid: sha } }), stderr: '' };
    },
    repo: 'laceyenterprises/agent-os',
    prNumber: 3311,
    logger: { warn: (msg) => warnings.push(msg) },
  });

  assert.equal(result, sha);
  assert.equal(calls.length, 2);
  assert.match(warnings.join('\n'), /merge_commit_lookup_transient_retry/);
});

test('AMA closer merge commit lookup does not retry permanent gh failures', async () => {
  const calls = [];
  const warnings = [];
  const result = await __testables__.fetchMergeCommitShaBestEffort({
    execFileImpl: async () => {
      calls.push(true);
      const err = new Error('HTTP 403 forbidden');
      err.stderr = 'HTTP 403 forbidden';
      throw err;
    },
    repo: 'laceyenterprises/agent-os',
    prNumber: 3311,
    logger: { warn: (msg) => warnings.push(msg) },
  });

  assert.equal(result, null);
  assert.equal(calls.length, 1);
  assert.match(warnings.join('\n'), /merge_commit_lookup_nonfatal/);
});

test('hammer prompt emits merge signal before releasing successful merge lease', () => {
  const prompt = readFileSync(new URL('../templates/hammer-prompt.md', import.meta.url), 'utf8');
  assert.match(prompt, /ham_emit_git_merge_signal\(\)/);
  assert.match(prompt, /EVENT_MERGE_SIGNAL/);
  assert.match(prompt, /ham_mark_ama_closer_lease_succeeded\(\)/);
  assert.match(prompt, /terminalOutcome: 'succeeded'/);
  assert.ok(
    prompt.indexOf('if ! ham_mark_ama_closer_lease_succeeded; then') > prompt.indexOf('ham_append_terminal_audit succeeded merged'),
    'AMA closer lease should be terminalized after the merged audit append succeeds',
  );
  assert.ok(
    prompt.indexOf('if ! ham_mark_ama_closer_lease_succeeded; then') < prompt.indexOf('if ! ham_emit_git_merge_signal; then'),
    'AMA closer lease should be terminalized before merge signal emission',
  );
  assert.ok(
    prompt.indexOf('if ! ham_emit_git_merge_signal; then') > prompt.indexOf('HAM_MERGE_COMMIT='),
    'merge signal should run after merge commit capture',
  );
  assert.ok(
    prompt.indexOf('if ! ham_emit_git_merge_signal; then') < prompt.indexOf('  ham_release_merge_lease\nelse'),
    'successful merge lease release should wait for merge signal emission',
  );
  assert.doesNotMatch(
    prompt,
    /if ! ham_emit_git_merge_signal; then[\s\S]*?\n  fi\n  trap ham_release_merge_lease EXIT\n  ham_release_merge_lease/,
  );
});

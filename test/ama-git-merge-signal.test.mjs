import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { __testables__ } from '../src/ama/dispatch-closer.mjs';

test('AMA closer emits worker.git.merge_signal with merge commit metadata', async () => {
  const calls = [];
  const emitted = await __testables__.emitWorkerGitMergeSignalBestEffort({
    execFileImpl: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { stdout: '{"status":"recorded","event_id":"synthetic-event"}', stderr: '' };
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
    env: { HQ_PYTHON3: '/opt/homebrew/bin/python3', PYTHONPATH: '/existing/pythonpath' },
  });

  assert.equal(emitted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'hq');
  assert.deepEqual(calls[0].args.slice(0, 3), ['build-completions', 'record-merge', '--hq-root']);
  assert.equal(calls[0].args[calls[0].args.indexOf('--launch-request-id') + 1], 'lrq_hammer_1');
  assert.equal(calls[0].args[calls[0].args.indexOf('--ticket-ref') + 1], 'WGS-02');
  assert.equal(calls[0].args[calls[0].args.indexOf('--pr-number') + 1], '3311');
  assert.equal(calls[0].args[calls[0].args.indexOf('--merge-commit-sha') + 1], 'a'.repeat(40));
  assert.equal(calls[0].args[calls[0].args.indexOf('--merged-by') + 1], 'hammer');
  assert.equal(calls[0].args[calls[0].args.indexOf('--mode') + 1], 'squash');
  assert.equal(calls[0].options.env.PYTHONPATH, '/existing/pythonpath');
  assert.match(calls[0].options.env.PYTHONPATH, /\/existing\/pythonpath/);
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

test('AMA closer merge commit lookup retries missing merge commit oid', async () => {
  const calls = [];
  const warnings = [];
  const sha = 'e'.repeat(40);
  const result = await __testables__.fetchMergeCommitShaBestEffort({
    execFileImpl: async () => {
      calls.push(true);
      if (calls.length === 1) return { stdout: JSON.stringify({ mergeCommit: null }), stderr: '' };
      return { stdout: JSON.stringify({ mergeCommit: { oid: sha } }), stderr: '' };
    },
    repo: 'laceyenterprises/agent-os',
    prNumber: 3311,
    logger: { warn: (msg) => warnings.push(msg) },
  });

  assert.equal(result, sha);
  assert.equal(calls.length, 2);
  assert.match(warnings.join('\n'), /merge_commit_lookup_transient_retry/);
  assert.match(warnings.join('\n'), /mergeCommit\.oid missing/);
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
  const prompt = readFileSync(new URL('../bin/hammer-merge.sh', import.meta.url), 'utf8');
  assert.match(prompt, /ham_emit_git_merge_signal\(\)/);
  assert.match(prompt, /record-merge-signal.mjs/);
  assert.match(prompt, /ham_mark_ama_closer_lease_succeeded\(\)/);
  assert.match(prompt, /terminalOutcome: 'succeeded'/);
  assert.match(
    prompt,
    /headSha: process\.env\.POST_REMEDIATION_SHA \|\| process\.env\.TARGET_REMEDIATION_SHA/,
    'HAM should use the rekeyed lease at its pushed head',
  );
  assert.match(
    prompt,
    /identity\.headSha = process\.env\.TARGET_REMEDIATION_SHA/,
    'HAM should fall back to the dispatch-time lease when no rekey happened',
  );
  assert.ok(
    prompt.indexOf('if ! ham_mark_ama_closer_lease_succeeded; then') > prompt.indexOf('ham_append_terminal_audit succeeded merged'),
    'AMA closer lease should be terminalized after the merged audit append succeeds',
  );
  assert.ok(
    prompt.indexOf('if ! ham_emit_git_merge_signal; then') < prompt.indexOf('if ! ham_mark_ama_closer_lease_succeeded; then'),
    'merge signal emission should happen before the AMA closer lease is terminalized',
  );
  assert.ok(
    prompt.indexOf('if ! ham_emit_git_merge_signal; then') > prompt.indexOf('HAM_MERGE_COMMIT='),
    'merge signal should run after merge commit capture',
  );
  assert.ok(
    prompt.indexOf('if ! ham_mark_ama_closer_lease_succeeded; then') < prompt.indexOf('  ham_release_merge_lease\nelse'),
    'successful merge lease release should wait for signal emission and lease terminalization',
  );
  assert.match(
    prompt,
    /if ! ham_emit_git_merge_signal; then[\s\S]*?AMA closer lease remains retryable[\s\S]*?return 1/,
    'signal failure should leave AMA closer lease non-terminal so daemon recovery can retry',
  );
  assert.match(
    prompt,
    /while \[ "\$HAM_SIGNAL_ATTEMPTS" -lt "\$HAM_MERGE_RETRY_CAP" \]/,
    'merge signal subprocess should have a bounded retry loop',
  );
  assert.doesNotMatch(
    prompt,
    /if ! ham_emit_git_merge_signal; then[\s\S]*?\n  fi\n  trap ham_release_merge_lease EXIT\n  ham_release_merge_lease/,
  );
});


for (const method of ['readMergedBuildCompletionSignal', 'readMergedBuildCompletionSignalAsync']) {
  for (const reason of ['worker-observation-scope-denied', 'worker-observation-unavailable', 'dispatch-read-unavailable']) {
    test(`${method}: ${reason} uses missing-capture reconciliation`, async () => {
      const warnings = [];
      const result = await __testables__[method]({repo:'example/repo',prNumber:1,headSha:'a'.repeat(40),
        logger:{warn:message => warnings.push(JSON.parse(message))},
        readBuildCompletionSignalForPrImpl:() => ({ok:false,reason}),
        readBuildCompletionProducerEvidenceImpl:() => assert.fail('refused PR read must not broaden scope')});
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'missing-build-completion-signal');
      assert.equal(result.readReason, reason.endsWith('scope-denied')
        ? 'merge-capture-read-scope-denied' : 'merge-capture-read-unavailable');
      assert.equal(warnings[0].reason, result.readReason);
    });
  }
  test(`${method}: allowed capture stays bound to the reviewed head`, async () => {
    const head = 'a'.repeat(40);
    const result = await __testables__[method]({repo:'example/repo',prNumber:1,headSha:head,
      readBuildCompletionSignalForPrImpl:() => ({ok:true,row:{head_sha:head,completion_id:'receipt'}}),
      readBuildCompletionProducerEvidenceImpl:() => assert.fail('valid capture needs no fallback')});
    assert.equal(result.ok, true);
    assert.equal(result.headShaMatchesReviewed, true);
    assert.equal(result.readReason, undefined);
  });
  test(`${method}: producer probe failure also degrades after a missing capture`, async () => {
    const result = await __testables__[method]({repo:'example/repo',prNumber:1,headSha:'a'.repeat(40),logger:{warn(){}},
      readBuildCompletionSignalForPrImpl:() => ({ok:false,reason:'missing-build-completion-signal'}),
      readBuildCompletionProducerEvidenceImpl:() => ({ok:false,reason:'worker-observation-scope-denied'})});
    assert.equal(result.reason, 'missing-build-completion-signal');
    assert.equal(result.readReason, 'merge-capture-read-scope-denied');
  });
  test(`${method}: thrown read failures cannot fail the closer`, async () => {
    const result = await __testables__[method]({repo:'example/repo',prNumber:1,logger:{warn(){}},
      readBuildCompletionSignalForPrImpl:() => {throw new Error('synthetic private failure');}});
    assert.equal(result.reason, 'missing-build-completion-signal');
    assert.equal(result.readReason, 'merge-capture-read-unavailable');
    assert.doesNotMatch(JSON.stringify(result), /private failure/);
  });
}

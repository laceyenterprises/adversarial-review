import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileBuilderClass } from '../src/builder-provenance-routing.mjs';
import { routeSubject } from '../src/adapters/subject/github-pr/routing.mjs';
import { readPrBuilderProvenance } from '../src/session-ledger-read-adapter.mjs';
import { main as reroute } from '../bin/reroute-builder-review.mjs';

const headSha = 'a'.repeat(40);
for (const [title, actual, reviewer] of [
  ['claude-code', 'codex', 'claude'],
  ['codex', 'claude-code', 'codex'],
]) {
  test(`${title} title with ${actual} ledger routes by actual builder`, () => {
    const result = reconcileBuilderClass({ builderClass: title }, { ok: true, actualHarness: actual, launchRequestId: 'lrq_fixture' });
    assert.equal(result.finding.name, 'builder_class_mismatch');
    const route = routeSubject(result.subject, {
      loaderImpl: () => ({ get: (_key, fallback) => fallback }),
      env: {}, geminiReviewerMode: 'off',
    });
    assert.equal(route.reviewerModel, reviewer);
  });
}
test('unreadable ledger preserves title routing and records inconclusive', () => {
  const subject = { builderClass: 'codex' };
  const result = reconcileBuilderClass(subject, { ok: false, reason: 'unreadable' });
  assert.equal(result.subject, subject);
  assert.equal(result.finding.name, 'builder_class_inconclusive');
});
test('builder lookup binds exact head and uses direct read-only transaction', () => {
  let captured;
  const result = readPrBuilderProvenance({ repo: 'org/repo', prNumber: 12, headSha,
    ledgerTarget: 'postgresql://test@127.0.0.1:6432/agent_os_ledger_test',
    spawnSyncImpl: (_cmd, args, options) => {
      captured = { args, options };
      return { status: 0, stdout: '{"actualHarness":"codex","launchRequestId":"lrq_fixture"}\n' };
    },
  });
  assert.equal(result.actualHarness, 'codex');
  assert.ok(captured.args.includes('postgresql://test@127.0.0.1:5432/agent_os_ledger_test'));
  assert.ok(captured.args.includes('-q'));
  assert.match(captured.options.input, /BEGIN READ ONLY;/);
  assert.match(captured.options.input, /COMMIT;/);
  assert.doesNotMatch(captured.options.input, /^\s*SET\s/im);
  assert.match(captured.options.input, /bc.head_sha = :'head_sha'/);
});
test('operator reroute defaults to preview, apply uses existing exact-head retrigger', async () => {
  const calls = [];
  const deps = {
    fetchPr: () => ({ state: 'OPEN', headRefOid: headSha, title: '[claude-code] fixture' }),
    readProvenance: () => ({ ok: true, actualHarness: 'codex' }),
    stdout: { write: () => {} },
    retrigger: args => { calls.push(args); return 0; },
  };
  await reroute(['--repo', 'org/repo', '--pr', '12'], deps);
  assert.equal(calls.length, 0);
  await reroute(['--repo', 'org/repo', '--pr', '12', '--apply', '--reason', 'fixture'], deps);
  assert.ok(calls[0].includes('--exact-head-now'));
  assert.ok(calls[0].includes(headSha));
  assert.ok(calls[0].includes('--no-bump-budget'));
  await assert.rejects(reroute(['--repo', 'org/repo', '--pr', '12', '--apply', '--reason', 'fixture'], {
    ...deps, fetchPr: () => ({ state: 'MERGED' }),
  }), /terminal PR/);
  assert.equal(calls.length, 1);
});

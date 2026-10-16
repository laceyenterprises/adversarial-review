import test from 'node:test';
import assert from 'node:assert/strict';
import { appendScopeViolationFinding, evaluateAdditiveOnlyScope, reviewBodyHasScopeViolationFinding } from '../src/additive-only-scope.mjs';
import { applyLivePackCrossEditReview } from '../src/live-pack-cross-edit.mjs';
import { applyReviewScopeGates } from '../src/reviewer-scope-gates.mjs';
import { normalizeEffectiveReviewVerdict } from '../src/kernel/verdict.mjs';

test('posting scope composition preserves both gates and current-label authority byte for byte', async () => {
  const reviewText = '## Blocking issues\n- None.\n\n## Verdict\nComment only\n';
  const diff = 'diff --git a/projects/p/SPEC.md b/projects/p/SPEC.md\n--- a/projects/p/SPEC.md\n+++ b/projects/p/SPEC.md\n';
  for (const scopeViolationFinding of [null, { kind: 'scope-violation', files: ['src/outside.mjs'] }]) {
    for (const fails of [false, true]) {
      const options = {
        repo: 'owner/repo', prNumber: 1, diff,
        prContext: { title: '[codex] P-01: own', headRefName: 'feature/runner', labels: ['live-pack-edit-approved'] },
        labels: [], reviewerHeadSha: 'head', log: null,
        evaluateImpl: async (args) => {
          assert.deepEqual(args.labels, [], 'stale PR-context labels cannot waive the gate');
          assert.equal(args.title, '[codex] P-01: own');
          assert.equal(args.headRef, 'head');
          if (fails) throw new Error('ledger unavailable');
          return { findings: [] };
        },
      };
      const expected = await applyLivePackCrossEditReview(
        scopeViolationFinding ? appendScopeViolationFinding(reviewText, scopeViolationFinding) : reviewText,
        options,
      );
      const actual = await applyReviewScopeGates(reviewText, { scopeViolationFinding, ...options });
      assert.equal(actual, expected);
      assert.equal(reviewBodyHasScopeViolationFinding(actual), Boolean(scopeViolationFinding));
      if (fails) assert.equal(normalizeEffectiveReviewVerdict(actual, { log: null }), 'request-changes');
    }
  }
});


test('next review pass composes normally after withdrawing a derived scope class', async () => {
  const snapshot = {
    repo: 'example/sample-repo', prNumber: 57, currentHeadSha: 'implementation',
    commits: [{ sha: 'survey' }, { sha: 'implementation' }],
    filesByCommit: { survey: [{ filename: 'projects/sample/SCOPE.md' }], implementation: [{ filename: 'src/feature.mjs' }] },
    openingHeadSha: 'implementation',
    openingFiles: { files: [{ filename: 'projects/sample/SCOPE.md' }, { filename: 'src/feature.mjs' }], truncated: false },
  };
  const reviewText = '## Blocking issues\n- Fix the implementation.\n\n## Verdict\nRequest changes\n';
  const previousFinding = { kind: 'scope-violation', violating_files: ['src/feature.mjs'] };
  assert.equal(reviewBodyHasScopeViolationFinding(appendScopeViolationFinding(reviewText, previousFinding)), true);
  const next = evaluateAdditiveOnlyScope(snapshot);
  const body = await applyReviewScopeGates(reviewText, {
    repo: snapshot.repo, prNumber: snapshot.prNumber, diff: '', labels: [],
    reviewerHeadSha: 'implementation', scopeViolationFinding: next.finding,
    evaluateImpl: async () => ({ findings: [] }), log: null,
  });
  assert.equal(body, reviewText);
  assert.equal(reviewBodyHasScopeViolationFinding(body), false);
  assert.equal(normalizeEffectiveReviewVerdict(body, { log: null }), 'request-changes');
});

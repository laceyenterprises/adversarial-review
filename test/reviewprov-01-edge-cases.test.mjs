import './helpers/registry-session-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { __test__ } from '../src/reviewer-harness.mjs';
import { buildReviewCommentBody, VERDICT_MODE_ENFORCE } from '../src/review-comment-body.mjs';

for (const suffix of ['Preview', 'Exp 1206', 'Thinking']) {
  test(`model qualifier ${suffix} is not recorded as thinking effort`, () => {
    assert.equal(__test__.geminiRequestedThinkingLevel(`Gemini (${suffix})`, 'antigravity'), null);
  });
}
for (const suffix of ['Low', 'Medium', 'High', 'XHigh']) {
  test(`recognized thinking effort ${suffix} retains its normalized identity`, () => {
    assert.equal(__test__.geminiRequestedThinkingLevel(`Gemini (${suffix})`, 'antigravity'), suffix.toLowerCase());
  });
}
for (const displayName of ['Gemini', 'Claude', 'Codex']) {
  test(`missing runtime for ${displayName} remains unknown rather than inferred from family`, () => {
    const body = buildReviewCommentBody({ reviewerMetadata: { displayName, reviewerIdentity: 'fixture' },
      verdictMode: VERDICT_MODE_ENFORCE, execution: { model: 'fixture', effort: null },
      reviewText: '## Verdict\nComment only' });
    assert.match(body, /> Reviewer: harness unknown · model fixture · effort n\/a/);
  });
}

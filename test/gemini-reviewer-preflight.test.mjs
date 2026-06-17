import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  preflightGeminiReviewerToken,
  isGeminiReviewerSelected,
  assertNoLegacyGeminiReviewerTokenEnv,
  GEMINI_REVIEWER_TOKEN_ENV,
  GEMINI_REVIEWER_LEGACY_TOKEN_ENV,
  GEMINI_REVIEWER_TOKEN_UNRESOLVED_MESSAGE,
  GEMINI_REVIEWER_LEGACY_CONFLICT_MESSAGE,
} from '../src/gemini-reviewer-preflight.mjs';

test('the unresolved-token message is the exact single-line SPEC contract', () => {
  assert.equal(
    GEMINI_REVIEWER_TOKEN_UNRESOLVED_MESSAGE,
    'gemini reviewer selected but GH_GEMINI_REVIEWER_TOKEN unresolved — '
      + 'check the op.env mapping for GEMINI_REVIEWER_GH_TOKEN '
      + '(see docs/RUNBOOK-gemini-reviewer-app.md)',
  );
  // Single line, names both the env var and the runbook.
  assert.doesNotMatch(GEMINI_REVIEWER_TOKEN_UNRESOLVED_MESSAGE, /\n/);
  assert.match(GEMINI_REVIEWER_TOKEN_UNRESOLVED_MESSAGE, /GH_GEMINI_REVIEWER_TOKEN/);
  assert.match(GEMINI_REVIEWER_TOKEN_UNRESOLVED_MESSAGE, /GEMINI_REVIEWER_GH_TOKEN/);
  assert.match(GEMINI_REVIEWER_TOKEN_UNRESOLVED_MESSAGE, /docs\/RUNBOOK-gemini-reviewer-app\.md/);
});

test('isGeminiReviewerSelected detects the routed botTokenEnv', () => {
  assert.equal(isGeminiReviewerSelected({ botTokenEnv: GEMINI_REVIEWER_TOKEN_ENV }), true);
  assert.equal(isGeminiReviewerSelected({ botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN' }), false);
  assert.equal(isGeminiReviewerSelected({ botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN' }), false);
});

test('isGeminiReviewerSelected detects the gemini reviewer identity', () => {
  assert.equal(isGeminiReviewerSelected({ reviewerIdentity: 'gemini-reviewer-lacey' }), true);
  assert.equal(isGeminiReviewerSelected({ reviewerIdentity: 'gemini-reviewer' }), true);
  assert.equal(isGeminiReviewerSelected({ reviewerIdentity: 'GEMINI-REVIEWER-LACEY' }), true);
  assert.equal(isGeminiReviewerSelected({ reviewerIdentity: 'codex-reviewer-lacey' }), false);
  assert.equal(isGeminiReviewerSelected({}), false);
});

test('preflight throws the legible runbook-naming error when the gemini token is unresolved', () => {
  for (const env of [
    { [GEMINI_REVIEWER_TOKEN_ENV]: '' },
    { [GEMINI_REVIEWER_TOKEN_ENV]: '   ' },
    {}, // entirely absent
  ]) {
    assert.throws(
      () => preflightGeminiReviewerToken({ env, botTokenEnv: GEMINI_REVIEWER_TOKEN_ENV }),
      (err) => {
        assert.equal(err.message, GEMINI_REVIEWER_TOKEN_UNRESOLVED_MESSAGE);
        return true;
      },
    );
  }
});

test('preflight does NOT fall back to another identity when the gemini token is unresolved', () => {
  // A codex token is sitting in env, but the gemini reviewer was selected with no
  // gemini token — the preflight must refuse rather than letting the post proceed
  // (which would mis-post under codex-reviewer-lacey's token).
  const env = { GH_CODEX_REVIEWER_TOKEN: 'ghs_codex', [GEMINI_REVIEWER_TOKEN_ENV]: '' };
  assert.throws(
    () => preflightGeminiReviewerToken({ env, botTokenEnv: GEMINI_REVIEWER_TOKEN_ENV }),
    new RegExp(GEMINI_REVIEWER_TOKEN_UNRESOLVED_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
});

test('preflight passes when a gemini reviewer has a resolved token', () => {
  const env = { [GEMINI_REVIEWER_TOKEN_ENV]: 'ghs_gemini_fresh' };
  assert.doesNotThrow(() =>
    preflightGeminiReviewerToken({ env, botTokenEnv: GEMINI_REVIEWER_TOKEN_ENV }));
});

test('preflight is a no-op for a non-gemini reviewer with a clean env', () => {
  const env = { GH_CLAUDE_REVIEWER_TOKEN: 'ghs_claude' };
  assert.doesNotThrow(() =>
    preflightGeminiReviewerToken({ env, botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN' }));
});

test('preflight fails closed when the legacy GEMINI_REVIEWER_GH_TOKEN env var is present', () => {
  // Even with a perfectly good canonical token, the legacy item-named env var
  // must fail closed before any post.
  const env = {
    [GEMINI_REVIEWER_TOKEN_ENV]: 'ghs_gemini_fresh',
    [GEMINI_REVIEWER_LEGACY_TOKEN_ENV]: 'ghs_leaked_item_named_value',
  };
  assert.throws(
    () => preflightGeminiReviewerToken({ env, botTokenEnv: GEMINI_REVIEWER_TOKEN_ENV }),
    (err) => {
      assert.equal(err.message, GEMINI_REVIEWER_LEGACY_CONFLICT_MESSAGE);
      return true;
    },
  );
});

test('legacy-conflict guard fires regardless of which reviewer is selected', () => {
  const env = {
    GH_CLAUDE_REVIEWER_TOKEN: 'ghs_claude',
    [GEMINI_REVIEWER_LEGACY_TOKEN_ENV]: 'ghs_leaked',
  };
  assert.throws(
    () => preflightGeminiReviewerToken({ env, botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN' }),
    new RegExp(GEMINI_REVIEWER_LEGACY_TOKEN_ENV),
  );
  // And the standalone assertion behaves the same.
  assert.throws(() => assertNoLegacyGeminiReviewerTokenEnv(env), /GEMINI_REVIEWER_GH_TOKEN/);
  assert.doesNotThrow(() => assertNoLegacyGeminiReviewerTokenEnv({ GH_CLAUDE_REVIEWER_TOKEN: 'x' }));
});

test('a blank legacy env var is not treated as a conflict', () => {
  const env = {
    [GEMINI_REVIEWER_TOKEN_ENV]: 'ghs_gemini_fresh',
    [GEMINI_REVIEWER_LEGACY_TOKEN_ENV]: '   ',
  };
  assert.doesNotThrow(() =>
    preflightGeminiReviewerToken({ env, botTokenEnv: GEMINI_REVIEWER_TOKEN_ENV }));
});

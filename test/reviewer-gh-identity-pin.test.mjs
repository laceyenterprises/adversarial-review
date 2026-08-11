import test from 'node:test';
import assert from 'node:assert/strict';

import { pinReviewerGhIdentity } from '../src/reviewer.mjs';

// SEV0 2026-08-11: a daemon-spawned reviewer's `gh api graphql` PR-context fetch
// had no usable GH_TOKEN in its env, so gh fell back to its keychain-stored PAT —
// inaccessible in the system-domain daemon security session — and the fetch
// failed, mis-classified as `oauth-broken`, stalling all reviews. pinReviewerGhIdentity
// makes every gh call use the reviewer's own bot identity token, keychain-free.

test('pins GH_TOKEN + GITHUB_TOKEN to the reviewer bot token', () => {
  const env = { GH_GEMINI_REVIEWER_TOKEN: 'gho_gemini_reviewer_xyz' };
  const result = pinReviewerGhIdentity(env, 'GH_GEMINI_REVIEWER_TOKEN');
  assert.equal(result.pinned, true);
  assert.equal(env.GH_TOKEN, 'gho_gemini_reviewer_xyz');
  assert.equal(env.GITHUB_TOKEN, 'gho_gemini_reviewer_xyz');
});

test('overrides an inherited merge-agent GITHUB_TOKEN so gh uses only the reviewer identity', () => {
  // A daemon-spawned reviewer inherits the watcher's merge-agent GITHUB_TOKEN;
  // the fetch must still run as the reviewer's own identity, not the watcher's.
  const env = {
    GITHUB_TOKEN: 'gho_watcher_merge_agent',
    GH_GEMINI_REVIEWER_TOKEN: 'gho_gemini_reviewer_xyz',
  };
  pinReviewerGhIdentity(env, 'GH_GEMINI_REVIEWER_TOKEN');
  assert.equal(env.GH_TOKEN, 'gho_gemini_reviewer_xyz');
  assert.equal(env.GITHUB_TOKEN, 'gho_gemini_reviewer_xyz');
});

test('does not fabricate or clobber when the bot token env is unset (caller warns instead)', () => {
  const env = { GITHUB_TOKEN: 'gho_watcher_merge_agent' };
  const result = pinReviewerGhIdentity(env, 'GH_GEMINI_REVIEWER_TOKEN');
  assert.equal(result.pinned, false);
  assert.equal(env.GH_TOKEN, undefined);
  // an inherited value is left untouched rather than blanked out
  assert.equal(env.GITHUB_TOKEN, 'gho_watcher_merge_agent');
});

test('treats an empty-string bot token as unset', () => {
  const env = { GH_GEMINI_REVIEWER_TOKEN: '' };
  const result = pinReviewerGhIdentity(env, 'GH_GEMINI_REVIEWER_TOKEN');
  assert.equal(result.pinned, false);
  assert.equal(env.GH_TOKEN, undefined);
});

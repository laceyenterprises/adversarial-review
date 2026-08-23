// Regression: a reviewer that dies AFTER posting its review must be recovered,
// not recorded `dead-no-review`.
//
// Reviewers post through GitHub Apps, so the review author is
// `lacey-<model>-reviewer[bot]`. reviewer-reattach.mjs kept its own copy of the
// reviewer-login table holding ONLY the legacy PAT login
// (`<model>-reviewer-lacey`) and compared it with exact string equality, so the
// probe could never match a posted review. Observed live 2026-08-22 on
// laceyenterprises/agent-os#5709, #5710 and #5711: each had a posted
// `comment-only` review from `lacey-gemini-reviewer[bot]`, each reviewer session
// then died, and each was stamped
//   "Reviewer session <uuid> is no longer alive and no GitHub review was found
//    from gemini-reviewer-lacey"
// leaving reviewer_passes.status='running' forever and the PR unmergeable.

import { strict as assert } from 'node:assert';
import test from 'node:test';

import { makeReviewPostedProbe, reviewerBotLogin } from '../src/reviewer-reattach.mjs';

const STARTED_AT = '2026-08-22T22:13:14.831Z';
const POSTED_AT = '2026-08-22T22:15:08.000Z';

function octokitReturning(reviews) {
  return {
    paginate: async () => reviews,
    rest: { pulls: { listReviews: async () => ({ data: reviews }) } },
  };
}

function row(overrides = {}) {
  return {
    repo: 'laceyenterprises/agent-os',
    pr_number: 5711,
    reviewer: 'gemini',
    reviewer_started_at: STARTED_AT,
    ...overrides,
  };
}

test('a review posted under the GitHub App login is found', async () => {
  const probe = makeReviewPostedProbe(octokitReturning([
    { user: { login: 'lacey-gemini-reviewer[bot]' }, submitted_at: POSTED_AT },
  ]));
  const found = await probe(row());
  assert.ok(found, 'the App-posted review must be recovered, not reported missing');
  assert.equal(found.submitted_at, POSTED_AT);
});

test('a review posted under the legacy PAT login is still found', async () => {
  // Mixed deployments and inherited-token fallback still produce this author.
  const probe = makeReviewPostedProbe(octokitReturning([
    { user: { login: 'gemini-reviewer-lacey' }, submitted_at: POSTED_AT },
  ]));
  assert.ok(await probe(row()), 'legacy artifacts must not be dropped');
});

test('the [bot] suffix and case do not decide the match', async () => {
  for (const login of [
    'lacey-gemini-reviewer',
    'LACEY-GEMINI-REVIEWER[BOT]',
    'Lacey-Gemini-Reviewer[bot]',
  ]) {
    const probe = makeReviewPostedProbe(octokitReturning([
      { user: { login }, submitted_at: POSTED_AT },
    ]));
    assert.ok(await probe(row()), `login ${login} should match`);
  }
});

test('a different reviewer bot is not accepted as this reviewer', async () => {
  const probe = makeReviewPostedProbe(octokitReturning([
    { user: { login: 'lacey-codex-reviewer[bot]' }, submitted_at: POSTED_AT },
  ]));
  assert.equal(await probe(row()), null, 'cross-reviewer matches would settle the wrong pass');
});

test('a review posted BEFORE this session started is not counted', async () => {
  const probe = makeReviewPostedProbe(octokitReturning([
    { user: { login: 'lacey-gemini-reviewer[bot]' }, submitted_at: '2026-08-22T21:00:00.000Z' },
  ]));
  assert.equal(await probe(row()), null, 'a stale prior review must not settle this pass');
});

test('an unknown reviewer resolves no logins and probes nothing', async () => {
  const probe = makeReviewPostedProbe(octokitReturning([
    { user: { login: 'lacey-gemini-reviewer[bot]' }, submitted_at: POSTED_AT },
  ]));
  assert.equal(await probe(row({ reviewer: 'nope' })), null);
  assert.equal(reviewerBotLogin('nope'), null);
});

test('every reviewer resolves to its GitHub App login, not the legacy PAT login', () => {
  assert.equal(reviewerBotLogin('gemini'), 'lacey-gemini-reviewer[bot]');
  assert.equal(reviewerBotLogin('codex'), 'lacey-codex-reviewer[bot]');
  assert.equal(reviewerBotLogin('claude'), 'lacey-claude-reviewer[bot]');
  // The failure message quotes this value; the legacy name sent operators
  // hunting for an account that never posts.
  assert.ok(!String(reviewerBotLogin('gemini')).startsWith('gemini-reviewer'));
});

test('cross-model reviewer names find reviews posted by the codex bot aliases', async () => {
  for (const reviewer of ['pi', 'opencode', 'hermes']) {
    for (const login of ['lacey-codex-reviewer[bot]', 'codex-reviewer-lacey']) {
      const probe = makeReviewPostedProbe(octokitReturning([
        { user: { login }, submitted_at: POSTED_AT },
      ]));
      assert.ok(
        await probe(row({ reviewer })),
        `${reviewer} should recover reviews posted by ${login}`
      );
    }
  }
});

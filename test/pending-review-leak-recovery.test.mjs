import test from 'node:test';
import assert from 'node:assert/strict';

import { clearPendingReviewsForSelf } from '../src/reviewer.mjs';
import { reconcilePendingReviewsForSelf } from '../src/reviewer-pre-write.mjs';
import { classifyReviewerFailure } from '../src/adapters/reviewer-runtime/cli-direct/classification.mjs';

// ── classifier ──────────────────────────────────────────────────────────────

test('classifier returns "pending-review-leak" for GH GraphQL one-pending error', () => {
  const stderr = [
    '[reviewer] DEBUG: posting GitHub review body length=4321',
    '[reviewer] GITHUB POST FAILED for laceyenterprises/agent-os#1234: ' +
      'Command failed: gh pr review 1234 ...',
    'failed to create review: GraphQL: User can only have one pending review ' +
      'per pull request (addPullRequestReview)',
  ].join('\n');
  assert.equal(classifyReviewerFailure(stderr, 1, null, {}), 'pending-review-leak');
});

test('classifier still returns "unknown" for unrelated stderr', () => {
  assert.equal(
    classifyReviewerFailure('some random failure with no special markers', 1, null, {}),
    'unknown'
  );
});

// ── clearPendingReviewsForSelf ──────────────────────────────────────────────

function makeFetchStub(fixtures) {
  const calls = [];
  return async function fetchImpl(url, opts = {}) {
    calls.push({ url, opts });
    for (const fx of fixtures) {
      if (fx.match(url, opts)) {
        const status = fx.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          async json() { return fx.body ?? null; },
        };
      }
    }
    throw new Error(`unmocked fetch: ${opts.method || 'GET'} ${url}`);
  };
}

test('clearPendingReviewsForSelf deletes the bot\'s pending review and leaves submitted ones alone', async () => {
  const deleted = [];
  const fetchImpl = makeFetchStub([
    {
      match: (u) => u === 'https://api.github.com/user',
      body: { login: 'claude-reviewer-lacey' },
    },
    {
      match: (u) => u.endsWith('/pulls/177/reviews') && (!arguments[1]?.method || arguments[1].method === 'GET'),
      body: [
        { id: 1001, state: 'COMMENTED', user: { login: 'claude-reviewer-lacey' } },
        { id: 1002, state: 'PENDING',   user: { login: 'claude-reviewer-lacey' } },
        { id: 1003, state: 'PENDING',   user: { login: 'other-bot' } }, // not us
      ],
    },
    {
      match: (u, o) => u.endsWith('/reviews/1002') && o?.method === 'DELETE',
      body: { id: 1002 },
    },
  ]);
  // The first stub closes over `arguments` which isn't bound in arrow; rewrite cleanly:
  const fetchClean = async function (url, opts = {}) {
    if (url === 'https://api.github.com/user') {
      return { ok: true, status: 200, async json() { return { login: 'claude-reviewer-lacey' }; } };
    }
    if (url.endsWith('/pulls/177/reviews') && (!opts.method || opts.method === 'GET')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return [
            { id: 1001, state: 'COMMENTED', user: { login: 'claude-reviewer-lacey' } },
            { id: 1002, state: 'PENDING',   user: { login: 'claude-reviewer-lacey' } },
            { id: 1003, state: 'PENDING',   user: { login: 'other-bot' } },
          ];
        },
      };
    }
    if (url.endsWith('/reviews/1002') && opts.method === 'DELETE') {
      deleted.push(1002);
      return { ok: true, status: 200, async json() { return { id: 1002 }; } };
    }
    throw new Error(`unmocked fetch: ${opts.method || 'GET'} ${url}`);
  };

  const result = await clearPendingReviewsForSelf({
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 177,
    token: 'ghp_test',
    fetchImpl: fetchClean,
    log: { log() {}, warn() {} },
  });

  assert.equal(result.cleared, 1);
  assert.equal(result.listed, 3);
  assert.equal(result.selfLogin, 'claude-reviewer-lacey');
  assert.deepEqual(deleted, [1002]);
});

test('clearPendingReviewsForSelf resolves codex-reviewer-lacey from the token and deletes only that draft', async () => {
  const deleted = [];
  const fetchImpl = async function (url, opts = {}) {
    if (url === 'https://api.github.com/user') {
      return { ok: true, status: 200, async json() { return { login: 'codex-reviewer-lacey' }; } };
    }
    if (url.endsWith('/pulls/188/reviews') && (!opts.method || opts.method === 'GET')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return [
            { id: 2001, state: 'PENDING', user: { login: 'claude-reviewer-lacey' } },
            { id: 2002, state: 'PENDING', user: { login: 'codex-reviewer-lacey' } },
          ];
        },
      };
    }
    if (url.endsWith('/reviews/2002') && opts.method === 'DELETE') {
      deleted.push(2002);
      return { ok: true, status: 200, async json() { return { id: 2002 }; } };
    }
    throw new Error(`unmocked fetch: ${opts.method || 'GET'} ${url}`);
  };

  const result = await clearPendingReviewsForSelf({
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 188,
    token: 'ghp_test',
    fetchImpl,
    log: { log() {}, warn() {} },
  });

  assert.equal(result.cleared, 1);
  assert.equal(result.listed, 2);
  assert.equal(result.selfLogin, 'codex-reviewer-lacey');
  assert.deepEqual(deleted, [2002]);
});

test('clearPendingReviewsForSelf is best-effort when /user probe fails', async () => {
  const fetchImpl = async (url) => {
    if (url === 'https://api.github.com/user') {
      return { ok: false, status: 401, async json() { return { message: 'Bad credentials' }; } };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const result = await clearPendingReviewsForSelf({
    repo: 'laceyenterprises/agent-os',
    prNumber: 1,
    token: 'ghp_test',
    fetchImpl,
    log: { log() {}, warn() {} },
  });
  assert.equal(result.cleared, 0);
  assert.equal(result.listed, 0);
});

test('clearPendingReviewsForSelf returns 0/0 with no token', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, status: 200, async json() { return null; } }; };
  const result = await clearPendingReviewsForSelf({
    repo: 'laceyenterprises/agent-os',
    prNumber: 1,
    token: null,
    fetchImpl,
  });
  assert.equal(result.cleared, 0);
  assert.equal(result.listed, 0);
  assert.equal(called, false);
});

test('clearPendingReviewsForSelf does NOT delete other bots pending reviews', async () => {
  const deleted = [];
  const fetchImpl = async function (url, opts = {}) {
    if (url === 'https://api.github.com/user') {
      return { ok: true, status: 200, async json() { return { login: 'claude-reviewer-lacey' }; } };
    }
    if (url.endsWith('/pulls/42/reviews') && (!opts.method || opts.method === 'GET')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return [
            { id: 99, state: 'PENDING', user: { login: 'codex-reviewer-lacey' } }, // not us
          ];
        },
      };
    }
    if (opts.method === 'DELETE') {
      deleted.push(url);
      return { ok: true, status: 200, async json() { return {}; } };
    }
    throw new Error(`unexpected fetch: ${opts.method} ${url}`);
  };
  const result = await clearPendingReviewsForSelf({
    repo: 'laceyenterprises/agent-os',
    prNumber: 42,
    token: 'ghp_test',
    fetchImpl,
    log: { log() {}, warn() {} },
  });
  assert.equal(result.cleared, 0);
  assert.deepEqual(deleted, []);
});

test('clearPendingReviewsForSelf swallows transient DELETE failure and continues', async () => {
  const deleted = [];
  const fetchImpl = async function (url, opts = {}) {
    if (url === 'https://api.github.com/user') {
      return { ok: true, status: 200, async json() { return { login: 'claude-reviewer-lacey' }; } };
    }
    if (url.endsWith('/pulls/7/reviews') && (!opts.method || opts.method === 'GET')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return [
            { id: 10, state: 'PENDING', user: { login: 'claude-reviewer-lacey' } },
            { id: 11, state: 'PENDING', user: { login: 'claude-reviewer-lacey' } },
          ];
        },
      };
    }
    if (url.endsWith('/reviews/10') && opts.method === 'DELETE') {
      return { ok: false, status: 500, async json() { return { message: 'transient' }; } };
    }
    if (url.endsWith('/reviews/11') && opts.method === 'DELETE') {
      deleted.push(11);
      return { ok: true, status: 200, async json() { return {}; } };
    }
    throw new Error(`unexpected fetch: ${opts.method} ${url}`);
  };
  const result = await clearPendingReviewsForSelf({
    repo: 'laceyenterprises/agent-os',
    prNumber: 7,
    token: 'ghp_test',
    fetchImpl,
    log: { log() {}, warn() {} },
  });
  assert.equal(result.cleared, 1); // only 11 succeeded
  assert.deepEqual(deleted, [11]);
});

test('reconcilePendingReviewsForSelf accepts numeric now and keeps fresh current-head draft', async () => {
  const deleted = [];
  const fetchImpl = async function (url, opts = {}) {
    if (url === 'https://api.github.com/user') {
      return { ok: true, status: 200, async json() { return { login: 'claude-reviewer-lacey' }; } };
    }
    if (url.endsWith('/pulls/7/reviews') && (!opts.method || opts.method === 'GET')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return [
            { id: 12, state: 'PENDING', commit_id: 'head', created_at: '2026-05-30T04:00:00.000Z', user: { login: 'claude-reviewer-lacey' } },
          ];
        },
      };
    }
    if (opts.method === 'DELETE') {
      deleted.push(url);
      return { ok: true, status: 200, async json() { return {}; } };
    }
    throw new Error(`unexpected fetch: ${opts.method || 'GET'} ${url}`);
  };

  const result = await reconcilePendingReviewsForSelf({
    repo: 'laceyenterprises/agent-os',
    prNumber: 7,
    token: 'ghp_test',
    currentHeadSha: 'head',
    respawnAgeSeconds: 900,
    now: Date.parse('2026-05-30T04:01:00.000Z'),
    fetchImpl,
    log: { log() {}, warn() {} },
  });

  assert.equal(result.shouldSpawn, false);
  assert.equal(result.listed, 1);
  assert.equal(result.pendingMine, 1);
  assert.equal(result.retained, 1);
  assert.deepEqual(deleted, []);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearPendingReviewsForSelf,
  reconcilePendingReviewsForSelf,
} from '../src/reviewer-pre-write.mjs';

const silentLog = { warn() {}, log() {} };

// Build a fetch stub keyed by URL substring.
function makeFetch(routes) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET' });
    for (const [needle, res] of routes) {
      if (String(url).includes(needle)) return res;
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { impl, calls };
}

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });
const forbidden = { ok: false, status: 403, json: async () => ({ message: 'Resource not accessible by integration' }) };

test('app token: selfLogin is used and /user is NOT probed', async () => {
  const { impl, calls } = makeFetch([
    ['/user', forbidden], // would 403 if probed
    ['/reviews', okJson([
      { id: 1, state: 'PENDING', user: { login: 'codex-reviewer-lacey[bot]' }, },
    ])],
  ]);
  const result = await clearPendingReviewsForSelf({
    repo: 'acme/repo', prNumber: 7, token: 'app-tok',
    selfLogin: 'codex-reviewer-lacey', fetchImpl: impl, log: silentLog,
  });
  assert.equal(calls.some((c) => c.url.endsWith('/user')), false, '/user must not be probed when selfLogin is supplied');
  assert.equal(result.selfLogin, 'codex-reviewer-lacey');
  // [bot]-suffixed pending review is recognized as ours and cleared.
  assert.equal(result.listed, 1);
  assert.equal(result.cleared, 1);
});

test('PAT path: falls back to /user when no selfLogin supplied', async () => {
  const { impl, calls } = makeFetch([
    ['/user', okJson({ login: 'some-pat-user' })],
    ['/reviews', okJson([])],
  ]);
  const result = await clearPendingReviewsForSelf({
    repo: 'acme/repo', prNumber: 7, token: 'pat',
    fetchImpl: impl, log: silentLog,
  });
  assert.equal(calls.some((c) => c.url.endsWith('/user')), true, 'PAT path probes /user');
  assert.equal(result.selfLogin, 'some-pat-user');
});

test('[bot]-suffix tolerance: exact and stripped forms both match', async () => {
  const { impl } = makeFetch([
    ['/reviews', okJson([
      { id: 1, state: 'PENDING', user: { login: 'codex-reviewer-lacey[bot]' } }, // suffixed
      { id: 2, state: 'PENDING', user: { login: 'codex-reviewer-lacey' } },      // exact
      { id: 3, state: 'PENDING', user: { login: 'someone-else' } },              // not ours
      { id: 4, state: 'APPROVED', user: { login: 'codex-reviewer-lacey[bot]' } }, // not PENDING
    ])],
  ]);
  const result = await clearPendingReviewsForSelf({
    repo: 'acme/repo', prNumber: 9, token: 'app-tok',
    selfLogin: 'codex-reviewer-lacey', fetchImpl: impl, log: silentLog,
  });
  assert.equal(result.cleared, 2, 'both the [bot] and exact PENDING reviews are ours');
});

test('reconcile: selfLogin supplied avoids identity-probe-failed under an app token', async () => {
  const { impl } = makeFetch([
    ['/user', forbidden],
    ['/reviews', okJson([])],
  ]);
  const result = await reconcilePendingReviewsForSelf({
    repo: 'acme/repo', prNumber: 11, token: 'app-tok',
    currentHeadSha: 'abc', respawnAgeSeconds: 600,
    selfLogin: 'merge-agent-lacey', fetchImpl: impl, log: silentLog,
  });
  assert.equal(result.skippedReason, null, 'must not skip with identity-probe-failed when selfLogin is known');
  assert.equal(result.selfLogin, 'merge-agent-lacey');
  assert.equal(result.shouldSpawn, true);
});

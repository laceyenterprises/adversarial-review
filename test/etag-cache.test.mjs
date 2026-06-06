import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createWatcherOctokit,
  fetchConditionalRestPage,
} from '../src/conditional-request.mjs';
import {
  buildEtagCallKey,
  getCachedEtag,
  getEtagCachePath,
  putCachedEtag,
} from '../src/etag-cache.mjs';

function makeRootDir() {
  return mkdtempSync(path.join(tmpdir(), 'etag-cache-'));
}

function cleanup(rootDir) {
  rmSync(rootDir, { recursive: true, force: true });
}

test('304 cache hit returns cached body, emits conditional_304 telemetry, and suppresses labels_list telemetry', async () => {
  const rootDir = makeRootDir();
  try {
    const repo = 'laceyenterprises/adversarial-review';
    const prNumber = 1388;
    const params = { per_page: 100 };
    const callKey = buildEtagCallKey({
      repo,
      prNumber,
      category: 'labels_list',
      endpoint: 'issues.labels',
      params,
    });
    putCachedEtag(rootDir, callKey, '"labels-v1"', [{ name: 'fast-merge:docs' }]);

    const telemetry = [];
    const response = await fetchConditionalRestPage({
      category: 'labels_list',
      endpoint: 'issues.labels',
      repo,
      prNumber,
      rootDir,
      params,
      recordApiCallImpl: (row) => telemetry.push(row),
      request: async (requestParams) => {
        assert.equal(requestParams.headers['if-none-match'], '"labels-v1"');
        return { status: 304, headers: { etag: '"labels-v1"' }, data: null };
      },
    });

    assert.equal(response.status, 304);
    assert.equal(response.fromConditionalCache, true);
    assert.deepEqual(response.data, [{ name: 'fast-merge:docs' }]);
    assert.deepEqual(
      telemetry.map((row) => row.category),
      ['conditional_304'],
    );
  } finally {
    cleanup(rootDir);
  }
});

test('200 response overwrites stale cache and a subsequent call reuses the new ETag on 304', async () => {
  const rootDir = makeRootDir();
  try {
    const repo = 'laceyenterprises/adversarial-review';
    const prNumber = 1388;
    const params = { page: 1, per_page: 100 };
    const callKey = buildEtagCallKey({
      repo,
      prNumber,
      category: 'timeline_events',
      endpoint: 'issues.timeline',
      params,
    });
    putCachedEtag(rootDir, callKey, '"timeline-old"', [{ id: 'stale' }]);

    const seenIfNoneMatch = [];
    const first = await fetchConditionalRestPage({
      category: 'timeline_events',
      endpoint: 'issues.timeline',
      repo,
      prNumber,
      rootDir,
      params,
      request: async (requestParams) => {
        seenIfNoneMatch.push(requestParams.headers['if-none-match']);
        return {
          status: 200,
          headers: { etag: '"timeline-new"' },
          data: [{ id: 'fresh' }],
        };
      },
    });
    assert.equal(first.status, 200);
    assert.deepEqual(first.data, [{ id: 'fresh' }]);
    assert.deepEqual(seenIfNoneMatch, ['"timeline-old"']);
    assert.deepEqual(getCachedEtag(rootDir, callKey), {
      etag: '"timeline-new"',
      body: [{ id: 'fresh' }],
    });

    const second = await fetchConditionalRestPage({
      category: 'timeline_events',
      endpoint: 'issues.timeline',
      repo,
      prNumber,
      rootDir,
      params,
      request: async (requestParams) => {
        assert.equal(requestParams.headers['if-none-match'], '"timeline-new"');
        return {
          status: 304,
          headers: { etag: '"timeline-new"' },
          data: null,
        };
      },
    });
    assert.equal(second.status, 304);
    assert.equal(second.fromConditionalCache, true);
    assert.deepEqual(second.data, [{ id: 'fresh' }]);
  } finally {
    cleanup(rootDir);
  }
});

test('200 followed by 304 roundtrip reuses the body cached by the first call', async () => {
  const rootDir = makeRootDir();
  try {
    const repo = 'laceyenterprises/adversarial-review';
    const prNumber = 2201;
    const params = { page: 2, per_page: 100 };

    const first = await fetchConditionalRestPage({
      category: 'other',
      endpoint: 'issues.comments',
      repo,
      prNumber,
      rootDir,
      params,
      request: async (requestParams) => {
        assert.equal(requestParams.headers, undefined);
        return {
          status: 200,
          headers: { etag: '"comments-v1"' },
          data: [{ id: 'IC_1', body: 'closeout' }],
        };
      },
    });
    assert.equal(first.status, 200);

    const telemetry = [];
    const second = await fetchConditionalRestPage({
      category: 'other',
      endpoint: 'issues.comments',
      repo,
      prNumber,
      rootDir,
      params,
      recordApiCallImpl: (row) => telemetry.push(row),
      request: async (requestParams) => {
        assert.equal(requestParams.headers['if-none-match'], '"comments-v1"');
        return { status: 304, headers: { etag: '"comments-v1"' }, data: null };
      },
    });
    assert.equal(second.status, 304);
    assert.deepEqual(second.data, [{ id: 'IC_1', body: 'closeout' }]);
    assert.deepEqual(
      telemetry.map((row) => row.category),
      ['conditional_304'],
    );
  } finally {
    cleanup(rootDir);
  }
});

test('request-shape isolation keeps timeline pages and filtered comment queries from replaying each other', () => {
  const rootDir = makeRootDir();
  try {
    const repo = 'laceyenterprises/adversarial-review';
    const prNumber = 4455;
    const timelinePage1 = buildEtagCallKey({
      repo,
      prNumber,
      category: 'timeline_events',
      endpoint: 'issues.timeline',
      params: { page: 1, per_page: 100 },
    });
    const timelinePage2 = buildEtagCallKey({
      repo,
      prNumber,
      category: 'timeline_events',
      endpoint: 'issues.timeline',
      params: { page: 2, per_page: 100 },
    });
    const commentsSinceA = buildEtagCallKey({
      repo,
      prNumber,
      category: 'other',
      endpoint: 'issues.comments',
      params: { page: 1, per_page: 100, since: '2026-06-01T00:00:00.000Z' },
    });
    const commentsSinceB = buildEtagCallKey({
      repo,
      prNumber,
      category: 'other',
      endpoint: 'issues.comments',
      params: { page: 1, per_page: 100, since: '2026-06-02T00:00:00.000Z' },
    });

    assert.notEqual(timelinePage1, timelinePage2);
    assert.notEqual(commentsSinceA, commentsSinceB);

    putCachedEtag(rootDir, timelinePage1, '"p1"', [{ id: 'page-1' }]);
    putCachedEtag(rootDir, timelinePage2, '"p2"', [{ id: 'page-2' }]);
    putCachedEtag(rootDir, commentsSinceA, '"c1"', [{ id: 'comment-a' }]);
    putCachedEtag(rootDir, commentsSinceB, '"c2"', [{ id: 'comment-b' }]);

    assert.deepEqual(getCachedEtag(rootDir, timelinePage1)?.body, [{ id: 'page-1' }]);
    assert.deepEqual(getCachedEtag(rootDir, timelinePage2)?.body, [{ id: 'page-2' }]);
    assert.deepEqual(getCachedEtag(rootDir, commentsSinceA)?.body, [{ id: 'comment-a' }]);
    assert.deepEqual(getCachedEtag(rootDir, commentsSinceB)?.body, [{ id: 'comment-b' }]);
  } finally {
    cleanup(rootDir);
  }
});

test('concurrent readers for the same callKey see complete cached bodies during atomic rename updates', async () => {
  const rootDir = makeRootDir();
  try {
    const callKey = buildEtagCallKey({
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 5522,
      category: 'timeline_events',
      endpoint: 'issues.timeline',
      params: { page: 1, per_page: 100 },
    });
    const bodies = [
      [{ id: 'before' }],
      [{ id: 'after' }],
    ];
    putCachedEtag(rootDir, callKey, '"before"', bodies[0]);

    const seen = [];
    const readers = Array.from({ length: 2 }, async () => {
      for (let index = 0; index < 20; index += 1) {
        const cached = getCachedEtag(rootDir, callKey);
        assert.ok(cached);
        seen.push(cached.body);
        await Promise.resolve();
      }
    });
    const writer = Promise.resolve().then(() => {
      putCachedEtag(rootDir, callKey, '"after"', bodies[1]);
    });

    await Promise.all([...readers, writer]);

    for (const body of seen) {
      assert.ok(
        JSON.stringify(body) === JSON.stringify(bodies[0])
          || JSON.stringify(body) === JSON.stringify(bodies[1]),
      );
    }
  } finally {
    cleanup(rootDir);
  }
});

test('missing cache file between fetches falls back to an unconditional 200 without crashing', async () => {
  const rootDir = makeRootDir();
  try {
    const repo = 'laceyenterprises/adversarial-review';
    const prNumber = 7788;
    const params = { per_page: 100 };
    const callKey = buildEtagCallKey({
      repo,
      prNumber,
      category: 'labels_list',
      endpoint: 'issues.labels',
      params,
    });
    putCachedEtag(rootDir, callKey, '"gone-soon"', [{ name: 'old' }]);
    rmSync(getEtagCachePath(rootDir, callKey), { force: true });

    let sawConditionalHeader = false;
    const response = await fetchConditionalRestPage({
      category: 'labels_list',
      endpoint: 'issues.labels',
      repo,
      prNumber,
      rootDir,
      params,
      request: async (requestParams) => {
        sawConditionalHeader = Object.prototype.hasOwnProperty.call(requestParams, 'headers');
        return {
          status: 200,
          headers: { etag: '"fresh-after-delete"' },
          data: [{ name: 'new' }],
        };
      },
    });

    assert.equal(sawConditionalHeader, false);
    assert.equal(response.status, 200);
    assert.deepEqual(response.data, [{ name: 'new' }]);
    assert.deepEqual(getCachedEtag(rootDir, callKey), {
      etag: '"fresh-after-delete"',
      body: [{ name: 'new' }],
    });
  } finally {
    cleanup(rootDir);
  }
});

test('Octokit conditional hook surfaces an explicit 304 response from a thrown RequestError-style object', async () => {
  let wrappedRequest = null;
  const fakeOctokit = {
    hook: {
      wrap(name, callback) {
        assert.equal(name, 'request');
        wrappedRequest = callback;
      },
    },
  };

  const octokit = createWatcherOctokit({
    auth: 'token',
    octokitFactory: () => fakeOctokit,
  });
  assert.equal(octokit, fakeOctokit);
  assert.equal(typeof wrappedRequest, 'function');

  // Octokit v22 can surface a 304 as a thrown RequestError. The watcher
  // must convert that into an explicit status-bearing response so the
  // call site can branch on `status === 304` instead of empty-body quirks.
  const response = await wrappedRequest(
    async () => {
      const err = new Error('Not modified');
      err.status = 304;
      err.response = { status: 304, headers: { etag: '"fixture-304"' }, data: null };
      throw err;
    },
    { headers: { 'if-none-match': '"fixture-304"' } },
  );

  assert.equal(response.status, 304);
  assert.deepEqual(response.headers, { etag: '"fixture-304"' });
});

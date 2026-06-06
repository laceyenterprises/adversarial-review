import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getCachedDiff,
  getDiffCachePaths,
  putCachedDiff,
  resolveDiffCacheDir,
} from '../src/diff-cache.mjs';
import { __test__ } from '../src/reviewer.mjs';

const { fetchPRDiff } = __test__;

function makeRootDir(prefix = 'diff-cache-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function readMeta(rootDir, repo, prNumber, headSha) {
  const { metaPath } = getDiffCachePaths(rootDir, repo, prNumber, headSha);
  return JSON.parse(readFileSync(metaPath, 'utf8'));
}

test('hit returns cached bytes without spawning gh', async () => {
  const rootDir = makeRootDir();
  const repo = 'laceyenterprises/adversarial-review';
  const prNumber = 57;
  const headSha = '0123456789abcdef';
    const expected = Buffer.from('diff --git a/a b/a\n');
    const recordedCalls = [];
    try {
      putCachedDiff(repo, prNumber, headSha, expected, { rootDir, now: new Date('2026-06-06T10:00:00.000Z') });
      let execCalls = 0;
    const diff = await fetchPRDiff(repo, prNumber, headSha, {
      execFileImpl: async () => {
        execCalls += 1;
        throw new Error('gh must not be called on cache hit');
      },
      getCachedDiffImpl: (cacheRepo, cachePrNumber, cacheHeadSha) => getCachedDiff(cacheRepo, cachePrNumber, cacheHeadSha, { rootDir }),
      putCachedDiffImpl: (cacheRepo, cachePrNumber, cacheHeadSha, bytes) => putCachedDiff(cacheRepo, cachePrNumber, cacheHeadSha, bytes, { rootDir }),
      recordApiCallImpl: (call) => {
        recordedCalls.push(call);
        return null;
      },
    });

    assert.equal(execCalls, 0);
    assert.deepEqual(diff, expected);
    assert.deepEqual(recordedCalls.map(({ category, status }) => ({ category, status })), [
      { category: 'cache_hit_diff_fetch', status: 'hit' },
    ]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('miss spawns gh, returns its output, and writes a cache entry', async () => {
  const rootDir = makeRootDir();
  const repo = 'laceyenterprises/adversarial-review';
  const prNumber = 58;
  const headSha = 'abcdef0123456789';
  const expected = Buffer.from('diff --git a/src/reviewer.mjs b/src/reviewer.mjs\n');
  const recordedCategories = [];
  try {
    let execCalls = 0;
    const diff = await fetchPRDiff(repo, prNumber, headSha, {
      execFileImpl: async (command, args, options) => {
        execCalls += 1;
        assert.equal(command, 'gh');
        assert.deepEqual(args, ['pr', 'diff', String(prNumber), '--repo', repo]);
        assert.equal(options.encoding, 'buffer');
        return { stdout: expected, stderr: Buffer.alloc(0) };
      },
      getCachedDiffImpl: (cacheRepo, cachePrNumber, cacheHeadSha) => getCachedDiff(cacheRepo, cachePrNumber, cacheHeadSha, { rootDir }),
      putCachedDiffImpl: (cacheRepo, cachePrNumber, cacheHeadSha, bytes) => putCachedDiff(cacheRepo, cachePrNumber, cacheHeadSha, bytes, { rootDir }),
      recordApiCallImpl: ({ category }) => {
        recordedCategories.push(category);
        return null;
      },
    });

    const { patchPath, metaPath } = getDiffCachePaths(rootDir, repo, prNumber, headSha);
    assert.equal(execCalls, 1);
    assert.deepEqual(diff, expected);
    assert.equal(existsSync(patchPath), true);
    assert.equal(existsSync(metaPath), true);
    assert.deepEqual(recordedCategories, ['diff_fetch']);
    assert.deepEqual(Object.keys(readMeta(rootDir, repo, prNumber, headSha)).sort(), ['cached_at']);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cache paths validate repo and head components before touching disk', () => {
  const rootDir = makeRootDir();
  try {
    for (const repo of ['laceyenterprises/adversarial-review/extra', '../adversarial-review', 'laceyenterprises\\adversarial-review']) {
      assert.throws(() => getDiffCachePaths(rootDir, repo, 58, 'abcdef0123456789'), /diff cache/i);
    }
    for (const headSha of ['../abcdef', 'abc/def', 'abc\\def', '']) {
      assert.throws(() => getDiffCachePaths(rootDir, 'laceyenterprises/adversarial-review', 58, headSha), /diff cache/i);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cache writes use non-world-readable files and directories', () => {
  const rootDir = makeRootDir();
  const repo = 'laceyenterprises/adversarial-review';
  const prNumber = 59;
  const headSha = 'modeheadshaabcdef';
  try {
    putCachedDiff(repo, prNumber, headSha, Buffer.from('mode-check'), { rootDir, now: new Date('2026-06-06T10:00:00.000Z') });
    const { dir, patchPath, metaPath } = getDiffCachePaths(rootDir, repo, prNumber, headSha);
    assert.equal(statSync(dir).mode & 0o007, 0);
    assert.equal(statSync(patchPath).mode & 0o007, 0);
    assert.equal(statSync(metaPath).mode & 0o007, 0);
    assert.equal(statSync(patchPath).mode & 0o600, 0o600);
    assert.equal(statSync(metaPath).mode & 0o600, 0o600);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('LRU eviction deletes the oldest entries until usage falls under budget', () => {
  const rootDir = makeRootDir();
  const repo = 'laceyenterprises/adversarial-review';
  const entryBytes = 16 * 1024 * 1024;
  const env = { GHO_DIFF_CACHE_MAX_BYTES: String(50 * 1024 * 1024) };
  try {
    for (let index = 0; index < 5; index += 1) {
      putCachedDiff(repo, 60 + index, `headsha-${index}-abcdef012345`, Buffer.alloc(entryBytes, index), {
        rootDir,
        env,
        now: new Date(`2026-06-06T0${index}:00:00.000Z`),
      });
    }

    for (let index = 0; index < 2; index += 1) {
      const { patchPath, metaPath } = getDiffCachePaths(rootDir, repo, 60 + index, `headsha-${index}-abcdef012345`);
      assert.equal(existsSync(patchPath), false);
      assert.equal(existsSync(metaPath), false);
    }

    for (let index = 2; index < 5; index += 1) {
      const { patchPath, metaPath } = getDiffCachePaths(rootDir, repo, 60 + index, `headsha-${index}-abcdef012345`);
      assert.equal(existsSync(patchPath), true);
      assert.equal(existsSync(metaPath), true);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('TTL expiry is GC-only: fixed-head reads return stale bytes and refresh LRU', async () => {
  const rootDir = makeRootDir();
  const repo = 'laceyenterprises/adversarial-review';
  const prNumber = 77;
  const headSha = 'ttlheadshaabcdef';
  const staleBytes = Buffer.from('stale');
  const env = { GHO_DIFF_CACHE_TTL_HOURS: '24' };
  try {
    putCachedDiff(repo, prNumber, headSha, staleBytes, {
      rootDir,
      env,
      now: new Date('2026-06-04T00:00:00.000Z'),
    });

    let execCalls = 0;
    const diff = await fetchPRDiff(repo, prNumber, headSha, {
      execFileImpl: async () => {
        execCalls += 1;
        throw new Error('gh must not be called for fixed-head cache reads');
      },
      getCachedDiffImpl: (cacheRepo, cachePrNumber, cacheHeadSha) => getCachedDiff(cacheRepo, cachePrNumber, cacheHeadSha, {
        rootDir,
        env,
        now: Date.parse('2026-06-06T12:00:00.000Z'),
      }),
      putCachedDiffImpl: (cacheRepo, cachePrNumber, cacheHeadSha, bytes) => putCachedDiff(cacheRepo, cachePrNumber, cacheHeadSha, bytes, {
        rootDir,
        env,
        now: new Date('2026-06-06T12:00:00.000Z'),
      }),
      recordApiCallImpl: () => null,
    });

    assert.equal(execCalls, 0);
    assert.deepEqual(diff, staleBytes);
    assert.deepEqual(getCachedDiff(repo, prNumber, headSha, {
      rootDir,
      env,
      now: Date.parse('2026-06-06T12:00:00.000Z'),
    })?.bytes, staleBytes);
    assert.equal(readMeta(rootDir, repo, prNumber, headSha).cached_at, '2026-06-06T12:00:00.000Z');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('concurrent put and get returns only complete old or new payloads', async () => {
  const rootDir = makeRootDir();
  const repo = 'laceyenterprises/adversarial-review';
  const prNumber = 88;
  const headSha = 'concurrentheadsha';
  const oldBytes = Buffer.from('old-value');
  const newBytesA = Buffer.from('new-value-a'.repeat(1024));
  const newBytesB = Buffer.from('new-value-b'.repeat(1024));
  try {
    putCachedDiff(repo, prNumber, headSha, oldBytes, { rootDir, now: new Date('2026-06-06T08:00:00.000Z') });

    const writer = async (payload, offsetHours) => {
      for (let index = 0; index < 20; index += 1) {
        putCachedDiff(repo, prNumber, headSha, payload, {
          rootDir,
          now: new Date(`2026-06-06T${String(9 + offsetHours).padStart(2, '0')}:${String(index).padStart(2, '0')}:00.000Z`),
        });
        await new Promise((resolve) => setImmediate(resolve));
      }
    };

    const reader = async () => {
      for (let index = 0; index < 80; index += 1) {
        const cached = getCachedDiff(repo, prNumber, headSha, { rootDir });
        assert.ok(cached, 'reader must always see a cache entry');
        const text = cached.bytes.toString('utf8');
        assert.ok(
          text === oldBytes.toString('utf8') ||
          text === newBytesA.toString('utf8') ||
          text === newBytesB.toString('utf8'),
          'reader must only observe complete old or new payloads'
        );
        await new Promise((resolve) => setImmediate(resolve));
      }
    };

    await Promise.all([
      writer(newBytesA, 0),
      writer(newBytesB, 1),
      reader(),
    ]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cache file format round-trips bytes exactly', () => {
  const rootDir = makeRootDir();
  const repo = 'laceyenterprises/adversarial-review';
  const prNumber = 99;
  const headSha = 'roundtripheadsha';
  const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x61, 0x62, 0x63]);
  try {
    putCachedDiff(repo, prNumber, headSha, bytes, { rootDir, now: new Date('2026-06-06T09:00:00.000Z') });
    const cached = getCachedDiff(repo, prNumber, headSha, { rootDir, now: Date.parse('2026-06-06T09:00:00.000Z') });
    assert.ok(cached);
    assert.deepEqual(cached.bytes, bytes);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cache key includes head SHA so multiple revisions for the same PR coexist', () => {
  const rootDir = makeRootDir();
  const repo = 'laceyenterprises/adversarial-review';
  const prNumber = 101;
  const firstHeadSha = '111111111111aaaa';
  const secondHeadSha = '222222222222bbbb';
  try {
    putCachedDiff(repo, prNumber, firstHeadSha, Buffer.from('first'), { rootDir, now: new Date('2026-06-06T10:00:00.000Z') });
    putCachedDiff(repo, prNumber, secondHeadSha, Buffer.from('second'), { rootDir, now: new Date('2026-06-06T10:01:00.000Z') });

    assert.deepEqual(getCachedDiff(repo, prNumber, firstHeadSha, { rootDir })?.bytes, Buffer.from('first'));
    assert.deepEqual(getCachedDiff(repo, prNumber, secondHeadSha, { rootDir })?.bytes, Buffer.from('second'));
    assert.equal(resolveDiffCacheDir(rootDir).includes('data/api-cache/diffs'), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

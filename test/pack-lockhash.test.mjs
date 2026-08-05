import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PackLockhashInputError,
  discoverPackFromDiff,
  isAgentOsPacksRepo,
  isPackLockhashInputError,
  resolveReviewedPackLockhash,
} from '../src/pack-lockhash.mjs';

function fixtureDiff(paths) {
  return paths.map((path) => [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${path}`,
    '@@ -0,0 +1 @@',
    '+fixture',
  ].join('\n')).join('\n');
}

test('agent-os-packs repo detection accepts full names and rejects core', () => {
  assert.equal(isAgentOsPacksRepo('laceyenterprises/agent-os-packs'), true);
  assert.equal(isAgentOsPacksRepo('agent-os-packs'), true);
  assert.equal(isAgentOsPacksRepo('laceyenterprises/agent-os'), false);
});

test('discoverPackFromDiff finds exactly one pack payload', () => {
  assert.deepEqual(
    discoverPackFromDiff(fixtureDiff([
      'packs/hello-apx/SPEC.md',
      'packs/hello-apx/SPEC.meta.json',
      'README.md',
    ])),
    {
      packId: 'hello-apx',
      packPath: 'packs/hello-apx',
      touchedPaths: [
        'packs/hello-apx/SPEC.md',
        'packs/hello-apx/SPEC.meta.json',
      ],
    }
  );
  assert.equal(discoverPackFromDiff(fixtureDiff(['README.md'])), null);
  assert.throws(
    () => discoverPackFromDiff(fixtureDiff([
      'packs/hello-apx/SPEC.md',
      'packs/other/SPEC.meta.json',
    ])),
    PackLockhashInputError
  );
});

test('resolveReviewedPackLockhash computes the canonical lockhash without a live repo', async () => {
  const specText = '# Hello APX\n';
  const metaText = '{"id":"hello-apx"}\n';
  const expected = 'abc123def456';

  const fetched = [];
  const resolved = await resolveReviewedPackLockhash({
    repo: 'laceyenterprises/agent-os-packs',
    headSha: 'a'.repeat(40),
    diffText: fixtureDiff([
      'packs/hello-apx/SPEC.md',
      'packs/hello-apx/SPEC.meta.json',
    ]),
    fetchFileAtRefImpl: async (_repo, path, ref) => {
      fetched.push({ path, ref });
      if (path.endsWith('SPEC.md')) return specText;
      if (path.endsWith('SPEC.meta.json')) return metaText;
      throw new Error(`unexpected path ${path}`);
    },
    computeLockhashImpl: async (spec, meta) => {
      assert.equal(spec, specText);
      assert.equal(meta, metaText);
      return expected;
    },
    log: { log() {} },
  });

  assert.equal(resolved.lockhash, expected);
  assert.equal(resolved.packId, 'hello-apx');
  assert.equal(resolved.packPath, 'packs/hello-apx');
  assert.equal(resolved.source, 'canonical_content.lockhash');
  assert.deepEqual(fetched, [
    { path: 'packs/hello-apx/SPEC.md', ref: 'a'.repeat(40) },
    { path: 'packs/hello-apx/SPEC.meta.json', ref: 'a'.repeat(40) },
  ]);
});

test('resolveReviewedPackLockhash classifies missing pack files as input errors', async () => {
  await assert.rejects(
    resolveReviewedPackLockhash({
      repo: 'laceyenterprises/agent-os-packs',
      headSha: 'b'.repeat(40),
      diffText: fixtureDiff(['packs/hello-apx/SPEC.md']),
      fetchFileAtRefImpl: async (_repo, path) => {
        if (path.endsWith('SPEC.md')) return '# Spec\n';
        const err = new Error('gh: Not Found (HTTP 404)');
        err.stderr = 'gh: Not Found (HTTP 404)';
        throw err;
      },
      computeLockhashImpl: async () => {
        throw new Error('should not compute without required files');
      },
      log: { log() {} },
    }),
    (err) => {
      assert.equal(isPackLockhashInputError(err), true);
      assert.match(err.message, /missing required file/);
      return true;
    }
  );
});

test('resolveReviewedPackLockhash classifies malformed pack metadata as input errors', async () => {
  await assert.rejects(
    resolveReviewedPackLockhash({
      repo: 'laceyenterprises/agent-os-packs',
      headSha: 'c'.repeat(40),
      diffText: fixtureDiff([
        'packs/hello-apx/SPEC.md',
        'packs/hello-apx/SPEC.meta.json',
      ]),
      fetchFileAtRefImpl: async (_repo, path) => path.endsWith('SPEC.md') ? '# Spec\n' : '{bad json',
      computeLockhashImpl: async () => {
        const err = new Error('JSONDecodeError: Expecting property name');
        err.stderr = 'JSONDecodeError: Expecting property name';
        throw err;
      },
      log: { log() {} },
    }),
    (err) => {
      assert.equal(isPackLockhashInputError(err), true);
      assert.match(err.message, /malformed canonical lockhash input/);
      return true;
    }
  );
});

test('resolveReviewedPackLockhash leaves transient lockhash failures fatal', async () => {
  await assert.rejects(
    resolveReviewedPackLockhash({
      repo: 'laceyenterprises/agent-os-packs',
      headSha: 'd'.repeat(40),
      diffText: fixtureDiff(['packs/hello-apx/SPEC.md']),
      fetchFileAtRefImpl: async () => {
        const err = new Error('TLS handshake timeout');
        err.stderr = 'TLS handshake timeout';
        throw err;
      },
      log: { log() {} },
    }),
    (err) => {
      assert.equal(isPackLockhashInputError(err), false);
      assert.match(err.message, /TLS handshake timeout/);
      return true;
    }
  );
});

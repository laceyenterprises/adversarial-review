import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  computeCanonicalSpecLockhash,
  discoverPackFromDiff,
  isAgentOsPacksRepo,
  resolveReviewedPackLockhash,
} from '../src/pack-lockhash.mjs';

const AGENT_OS_ROOT = join(import.meta.dirname, '..', '..', '..');
const FIXTURE_PACK = join(
  AGENT_OS_ROOT,
  'projects',
  'apx',
  'fixtures',
  'agent-os-packs',
  'packs',
  'hello-apx'
);

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
    /multiple packs/
  );
});

test('resolveReviewedPackLockhash computes the canonical fixture lockhash without a live repo', async () => {
  const specText = readFileSync(join(FIXTURE_PACK, 'SPEC.md'), 'utf8');
  const metaText = readFileSync(join(FIXTURE_PACK, 'SPEC.meta.json'), 'utf8');
  const expected = await computeCanonicalSpecLockhash(specText, metaText, {
    canonicalContentParent: join(AGENT_OS_ROOT, 'platform'),
  });

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
    computeLockhashImpl: (spec, meta) => computeCanonicalSpecLockhash(spec, meta, {
      canonicalContentParent: join(AGENT_OS_ROOT, 'platform'),
    }),
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

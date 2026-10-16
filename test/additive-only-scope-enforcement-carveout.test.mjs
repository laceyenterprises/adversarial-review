// Derivation and enforcement share the registry/baseline carve-out.

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateAdditiveOnlyScope } from '../src/additive-only-scope.mjs';

const REGISTRY = 'scripts/oss-readiness-allowlist.registry.json';
const BASELINE = 'scripts/oss-readiness-category-baseline.json';
const PACK_YAML = 'modules/worker-pool/post-merge-actions/sample-pack-official-record-bump.yaml';

function file(filename, { additions = 1, deletions = 0, status = 'modified' } = {}) {
  return { filename, status, additions, deletions };
}

function scope({ commits, labeled = true }) {
  const filesByCommit = {};
  for (const [sha, files] of Object.entries(commits)) {
    filesByCommit[sha] = { files, truncated: false };
  }
  return evaluateAdditiveOnlyScope({
    repo: 'example/sample-repo',
    prNumber: 57,
    labels: labeled ? [{ name: 'pr-class: additive-only' }] : [],
    prAuthor: 'builder',
    currentHeadSha: Object.keys(commits).at(-1),
    commits: Object.keys(commits).map((sha) => ({ sha })),
    filesByCommit,
    openingHeadSha: Object.keys(commits)[0],
    openingFiles: filesByCommit[Object.keys(commits)[0]],
    timeline: [],
  });
}

test('synthetic pack shape: YAML in commit 1, ratchet lift in commit 2 — no violation', () => {
  const result = scope({
    commits: {
      opening: [
        file('projects/sample-pack/SPEC.md', { status: 'added' }),
        file('projects/sample-pack/plan.json', { status: 'added' }),
        file(PACK_YAML, { status: 'added', additions: 30 }),
        file(REGISTRY, { additions: 48, deletions: 0 }),
      ],
      later: [file(BASELINE, { additions: 2, deletions: 2 })],
    },
  });
  assert.equal(result.finding, null, 'the ratchet lift is forced by the YAML earlier in the PR');
  assert.equal(result.additiveOnly, true);
});

test('registry and baseline in the SAME commit as the YAML — no violation', () => {
  const result = scope({
    commits: {
      aaaaaaaaaaaa: [
        file('projects/sample-pack/SPEC.md', { status: 'added' }),
        file(PACK_YAML, { status: 'added' }),
        file(REGISTRY, { additions: 8, deletions: 0 }),
        file(BASELINE, { additions: 1, deletions: 1 }),
      ],
    },
  });
  assert.equal(result.finding, null);
});

// --- the carve-out must stay narrow -------------------------------------------------

test('baseline bump with NO post-merge action anywhere in the PR IS a violation', () => {
  const result = scope({
    commits: {
      bbbbbbbbbbbb: [file('projects/thing/SPEC.md', { status: 'added' })],
      cccccccccccc: [file(BASELINE, { additions: 1, deletions: 1 })],
    },
  });
  assert.ok(result.finding, 'nothing forced the ratchet lift; it must not be licensed');
  assert.deepEqual(result.finding.violating_files, [BASELINE]);
});

test('baseline bump is not licensed by a post-merge action removed before final PR state', () => {
  const result = scope({
    commits: {
      bbbbbbbbbbbb: [file(PACK_YAML, { status: 'added' })],
      cccccccccccc: [file(BASELINE, { additions: 1, deletions: 1 })],
      dddddddddddd: [file(PACK_YAML, { status: 'removed', additions: 0, deletions: 30 })],
    },
  });
  assert.ok(result.finding, 'historical add-then-remove forcing must not license the final PR');
  assert.deepEqual(result.finding.violating_files, [BASELINE]);
});

test('baseline bump is not licensed when the post-merge action is renamed away', () => {
  const result = scope({
    commits: {
      eeeeeeeeeeee: [file(PACK_YAML, { status: 'added' })],
      ffffffffffff: [file(BASELINE, { additions: 1, deletions: 1 })],
      '111111111111': [
        {
          ...file('projects/thing/not-a-post-merge-action.yaml', { status: 'renamed' }),
          previous_filename: PACK_YAML,
        },
      ],
    },
  });
  assert.ok(result.finding, 'renaming the forcing file out of post-merge actions removes forcing');
  assert.deepEqual(result.finding.violating_files, [BASELINE]);
});

test('baseline deletion is a violation even when forced by a post-merge action', () => {
  const result = scope({
    commits: {
      '222222222222': [file(PACK_YAML, { status: 'added' })],
      '333333333333': [file(BASELINE, { status: 'removed', additions: 0, deletions: 20 })],
    },
  });
  assert.ok(result.finding, 'forcing must not license deleting the ratchet baseline file');
  assert.deepEqual(result.finding.violating_files, [BASELINE]);
});

test('pure-additive registry-only commit does not violate labeled additive-only enforcement', () => {
  const result = scope({
    commits: {
      bbbbbbbbbbbb: [file('projects/thing/SPEC.md', { status: 'added' })],
      cccccccccccc: [file(REGISTRY, { additions: 2, deletions: 0 })],
    },
  });
  assert.equal(result.finding, null, 'registry enforcement only requires deletion-free changes');
  assert.equal(result.additiveOnly, true);
});

test('registry change that DELETES a registration is a violation even when forced', () => {
  const result = scope({
    commits: {
      dddddddddddd: [file(PACK_YAML, { status: 'added' })],
      eeeeeeeeeeee: [file(REGISTRY, { additions: 3, deletions: 5 })],
    },
  });
  assert.ok(result.finding, 'the exception never permits un-registering somebody else\'s hardcode');
  assert.deepEqual(result.finding.violating_files, [REGISTRY]);
});

test('registry with unknown deletion count fails closed even when forced', () => {
  const result = scope({
    commits: {
      ffffffffffff: [file(PACK_YAML, { status: 'added' })],
      '111111111111': [{ filename: REGISTRY }],
    },
  });
  assert.ok(result.finding, 'a bare {filename} object must not silently obtain the exception');
});

test('an unrelated non-allowlisted file is still a violation in a forced PR', () => {
  const result = scope({
    commits: {
      '222222222222': [file(PACK_YAML, { status: 'added' })],
      '333333333333': [file('modules/worker-pool/lib/hq-common.sh')],
    },
  });
  assert.ok(result.finding, 'forcing licenses the registry and baseline only, nothing else');
  assert.deepEqual(result.finding.violating_files, ['modules/worker-pool/lib/hq-common.sh']);
});


test('unlabeled pack opening uses the same registry and baseline carve-out', () => {
  const result = scope({ labeled: false, commits: {
    opening: [file(PACK_YAML, { status: 'added' }), file(REGISTRY, { additions: 5 }), file(BASELINE)],
    later: [file('projects/sample-pack/plan.json')],
  } });
  assert.equal(result.derivedAdditiveOnly, true);
  assert.equal(result.finding, null);
  assert.equal(result.backfillNeeded, true);
});

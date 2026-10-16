// Brand only on a completed, clean scan; derivation alone is not authority to label.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADDITIVE_ONLY_LABEL,
  SCOPE_EXPAND_LABEL,
  evaluateAdditiveOnlyScope,
  resolveAdditiveOnlyScopeReview,
} from '../src/additive-only-scope.mjs';

const PACK_YAML = 'modules/worker-pool/post-merge-actions/sample-pack-standup.yaml';

function scope({ commits, labels = [], timeline = [], currentHeadSha = null, openingHeadSha = Object.keys(commits)[0] }) {
  const filesByCommit = {};
  for (const [sha, entry] of Object.entries(commits)) {
    filesByCommit[sha] = Array.isArray(entry) ? { files: entry, truncated: false } : entry;
  }
  const shas = Object.keys(commits);
  return evaluateAdditiveOnlyScope({
    repo: 'example/sample-repo',
    prNumber: 57,
    labels,
    prAuthor: 'builder',
    currentHeadSha: currentHeadSha || shas.at(-1),
    commits: shas.map((sha) => ({ sha })),
    filesByCommit,
    openingHeadSha,
    openingFiles: filesByCommit[openingHeadSha],
    timeline,
  });
}

test('a later outside-scope push is enforced without branding the PR', () => {
  const result = scope({
    commits: {
      'opening': [
        { filename: 'projects/sample-pack/SPEC.md', status: 'added' },
        { filename: PACK_YAML, status: 'added' },
      ],
      'later': [
        { filename: 'docs/INDEX.md', status: 'modified' },
        {
          filename: 'docs/postmortems/SEV-sample.md',
          status: 'added',
        },
        { filename: 'src/observer.mjs', status: 'modified' },
        { filename: 'test/observer.test.mjs', status: 'added' },
      ],
    },
  });

  assert.equal(result.derivedAdditiveOnly, true);
  assert.equal(result.finding?.kind, 'scope-violation');
  assert.deepEqual(result.finding?.violating_files, [
    'docs/INDEX.md',
    'docs/postmortems/SEV-sample.md',
    'src/observer.mjs',
    'test/observer.test.mjs',
  ]);

  // But the PR is not branded with a class it has just been shown to violate.
  assert.equal(result.backfillNeeded, false);
});

test('a later mixed change is enforced without branding the PR', () => {
  const result = scope({
    commits: {
      'opening': [{ filename: PACK_YAML, status: 'modified' }],
      'later': [
        { filename: PACK_YAML, status: 'modified' },
        { filename: 'src/guide.md', status: 'modified' },
      ],
    },
  });

  assert.equal(result.derivedAdditiveOnly, true);
  assert.deepEqual(result.finding?.violating_files, ['src/guide.md']);
  assert.equal(result.backfillNeeded, false);
});

test('the brand survives for a PR that actually stayed in scope', () => {
  const result = scope({
    commits: {
      'opening': [
        { filename: 'projects/sample-route/SPEC.md', status: 'added' },
        { filename: 'projects/sample-route/plan.json', status: 'added' },
      ],
      'later': [{ filename: 'projects/sample-route/plan.json', status: 'modified' }],
    },
  });

  assert.equal(result.derivedAdditiveOnly, true);
  assert.equal(result.finding, null);
  assert.equal(result.backfillNeeded, true);
});

test('an unreadable commit is inconclusive, and inconclusive is not proof of scope', () => {
  const result = scope({
    commits: {
      'initial': [{ filename: 'projects/pack/plan.json', status: 'added' }],
      'huge': { files: [{ filename: 'projects/pack/plan.json', status: 'modified' }], truncated: true },
    },
  });

  assert.equal(result.finding?.file_list_truncated, true);
  assert.equal(result.backfillNeeded, false);
});

test('an operator scope-expand override does not get converted into a permanent brand', () => {
  const result = scope({
    commits: {
      'initial': [{ filename: 'projects/pack/plan.json', status: 'added' }],
      'later': [{ filename: 'src/worker.mjs', status: 'modified' }],
    },
    labels: [{ name: SCOPE_EXPAND_LABEL }],
    currentHeadSha: 'later',
    timeline: [
      { event: 'committed', sha: 'later' },
      { event: 'labeled', label: { name: SCOPE_EXPAND_LABEL }, actor: { login: 'operator' } },
    ],
  });

  assert.equal(result.overrideActive, true);
  assert.equal(result.finding, null);
  // The override is bound to `later`; the label would not be. Branding here
  // outlives the approval that licensed it.
  assert.equal(result.backfillNeeded, false);
});

test('resolver issues no label write on the evaluation that produced the finding', async () => {
  const calls = [];
  const result = await resolveAdditiveOnlyScopeReview({
    repo: 'example/sample-repo',
    prNumber: 57,
    snapshot: {
      prCreatedAt: '2026-08-25T05:26:14.000Z',
      prAuthor: 'builder',
      currentHeadSha: 'later',
      labels: [],
      openingHeadSha: 'opening',
      openingFiles: { files: [{ filename: 'projects/sample-pack/SPEC.md', status: 'added' }], truncated: false },
      commits: [{ sha: 'opening' }, { sha: 'later' }],
      filesByCommit: {
        'opening': [{ filename: 'projects/sample-pack/SPEC.md', status: 'added' }],
        'later': [
          { filename: 'src/observer.mjs', status: 'modified' },
        ],
      },
      timeline: [],
    },
    backfillLabelImpl: async (args) => {
      calls.push(args);
      return { attempted: true, added: true };
    },
  });

  assert.equal(result.finding?.kind, 'scope-violation');
  assert.equal(calls.length, 0);
  assert.equal(result.backfill, undefined);
});

test('a genuinely labeled PR is still enforced across every commit', () => {
  const result = scope({
    labels: [{ name: ADDITIVE_ONLY_LABEL }],
    commits: {
      'initial': [{ filename: 'src/escape.mjs', status: 'added' }],
      'later': [{ filename: 'projects/pack/plan.json', status: 'modified' }],
    },
  });

  assert.equal(result.additiveOnly, true);
  assert.deepEqual(result.finding?.violating_files, ['src/escape.mjs']);
});

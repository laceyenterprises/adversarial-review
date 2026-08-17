/** Enforcement must honour the same carve-out that derivation does.
 *
 * `additive-only-scope-registry-carveout.test.mjs` pins DERIVATION: a build
 * pack's file set counts as additive-only via the registry/baseline exceptions.
 * That path is `changedFilesWithinAdditiveOnlyAllowlist`.
 *
 * ENFORCEMENT took a different path and did not apply the carve-out at all. It
 * scanned each commit with the bare `additiveOnlyPathAllowed`, whose allowlist
 * is only projects/**, post-merge-actions/**, POSTMORTEM-*, AUDIT-*. Neither
 * `scripts/oss-readiness-allowlist.registry.json` nor
 * `scripts/oss-readiness-category-baseline.json` is in it.
 *
 * The result was self-contradictory: a build pack's initial commit DERIVES as
 * additive-only through the carve-out, so the reviewer backfills the label onto
 * the PR -- and then enforcement violates the PR using a rule that ignores the
 * same carve-out. Every build pack tripped it.
 *
 * agent-os#5465 is the worked example. Commit 1 carried projects/**, the
 * post-merge YAML, and the registry (additions=48, deletions=0) -- clean.
 * Commit 2 carried only the ratchet lift to the baseline. The emitted finding
 * named commit 2 and `scripts/oss-readiness-category-baseline.json`.
 *
 * A scope violation SUPPRESSES ALL AUTOMATED DISPATCH on the PR, so the pack got
 * no review and no remediation for 7 hours; `retrigger-review` and
 * `retrigger-remediation` both landed on a PR the pipeline had stopped serving.
 *
 * The forcing relationship is also PR-wide, not per-commit: the YAML is written
 * first and the correct ratchet number is only knowable after running the audit
 * against it, so the baseline bump is naturally a later commit. Requiring both in
 * one commit made the exception unreachable in the normal workflow.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateAdditiveOnlyScope } from '../src/additive-only-scope.mjs';

const REGISTRY = 'scripts/oss-readiness-allowlist.registry.json';
const BASELINE = 'scripts/oss-readiness-category-baseline.json';
const PACK_YAML = 'modules/worker-pool/post-merge-actions/app-standup-official-record-bump.yaml';

function file(filename, { additions = 1, deletions = 0, status = 'modified' } = {}) {
  return { filename, status, additions, deletions };
}

function scope({ commits, labeled = true }) {
  const filesByCommit = {};
  for (const [sha, files] of Object.entries(commits)) {
    filesByCommit[sha] = { files, truncated: false };
  }
  return evaluateAdditiveOnlyScope({
    repo: 'laceyenterprises/agent-os',
    prNumber: 5465,
    labels: labeled ? [{ name: 'pr-class: additive-only' }] : [],
    prAuthor: 'builder',
    currentHeadSha: Object.keys(commits).at(-1),
    commits: Object.keys(commits).map((sha) => ({ sha })),
    filesByCommit,
    timeline: [],
  });
}

test('agent-os#5465 shape: YAML in commit 1, ratchet lift in commit 2 — no violation', () => {
  const result = scope({
    commits: {
      cd69b78f7432: [
        file('projects/app-standup/SPEC.md', { status: 'added' }),
        file('projects/app-standup/plan.json', { status: 'added' }),
        file(PACK_YAML, { status: 'added', additions: 30 }),
        file(REGISTRY, { additions: 48, deletions: 0 }),
      ],
      e099eeb2ff84: [file(BASELINE, { additions: 2, deletions: 2 })],
    },
  });
  assert.equal(result.finding, null, 'the ratchet lift is forced by the YAML earlier in the PR');
  assert.equal(result.additiveOnly, true);
});

test('registry and baseline in the SAME commit as the YAML — no violation', () => {
  const result = scope({
    commits: {
      aaaaaaaaaaaa: [
        file('projects/app-standup/SPEC.md', { status: 'added' }),
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

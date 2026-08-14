/** A build pack must be able to satisfy the label the reviewer applies to it.
 *
 * `AGENTS.md` requires every build pack to ship a post-merge-actions YAML, and
 * that path IS additive-only allowlisted. But every such YAML hardcodes
 * production-host values -- at minimum `user: airlock` -- and the OSS-readiness
 * enforced gate refuses the push unless those hardcodes are registered in
 * `scripts/oss-readiness-allowlist.registry.json`, which is NOT allowlisted.
 *
 * So shipping an allowlisted file forced touching a non-allowlisted one, and no
 * build pack could satisfy `pr-class: additive-only` -- a label the reviewer
 * applies to build packs itself. agent-os#5372 was held on exactly this.
 *
 * The carve-out is narrow on purpose. The registry is a security control: a
 * blanket allowlist entry would let ANY additive-only PR rewrite it unreviewed.
 * It is permitted only when a post-merge-actions file in the same change set
 * forced the registration, and only when nothing is removed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { changedFilesWithinAdditiveOnlyAllowlist } from '../src/additive-only-scope.mjs';

const REGISTRY = 'scripts/oss-readiness-allowlist.registry.json';
const PACK_YAML = 'modules/worker-pool/post-merge-actions/finch-official-record-bump.yaml';

// Real REST commit-file shape: the fetch path pushes raw page objects, so
// additions/deletions survive to the predicate.
function file(filename, { additions = 1, deletions = 0 } = {}) {
  return { filename, status: 'modified', additions, deletions };
}

test('a build pack that must register its post-merge hardcodes is additive-only', () => {
  // The agent-os#5372 shape, verbatim.
  const files = [
    file('projects/finch/SPEC.md'),
    file('projects/finch/plan.json'),
    file('projects/finch/prompts/fin-01-prompt.md'),
    file(PACK_YAML),
    file(REGISTRY, { additions: 48, deletions: 0 }),
  ];
  assert.equal(changedFilesWithinAdditiveOnlyAllowlist(files), true);
});

test('the registry alone is NOT additive-only without a post-merge action forcing it', () => {
  // This is the case the carve-out must keep refusing: a pack quietly editing a
  // security control it had no structural reason to touch.
  const files = [file('projects/finch/plan.json'), file(REGISTRY)];
  assert.equal(changedFilesWithinAdditiveOnlyAllowlist(files), false);
});

test('removing an existing registration is never additive-only', () => {
  // Deleting a line un-registers somebody else's hardcode, which would let an
  // unrelated hardcode start failing -- or stop being audited.
  const files = [file(PACK_YAML), file(REGISTRY, { additions: 8, deletions: 1 })];
  assert.equal(changedFilesWithinAdditiveOnlyAllowlist(files), false);
});

test('an unknown deletion count fails closed', () => {
  // A caller handing us bare {filename} objects must not obtain the exception by
  // omission. Fail closed is the only safe reading of "I do not know".
  const files = [{ filename: PACK_YAML }, { filename: REGISTRY }];
  assert.equal(changedFilesWithinAdditiveOnlyAllowlist(files), false);
});

test('a non-allowlisted file is still refused even alongside a valid registry pairing', () => {
  const files = [
    file(PACK_YAML),
    file(REGISTRY, { deletions: 0 }),
    file('src/reviewer.mjs'),
  ];
  assert.equal(changedFilesWithinAdditiveOnlyAllowlist(files), false);
});

test('the carve-out does not widen the allowlist for other scripts/ paths', () => {
  const files = [file(PACK_YAML), file('scripts/os-restart.sh')];
  assert.equal(changedFilesWithinAdditiveOnlyAllowlist(files), false);
});

test('pre-existing behaviour is unchanged', () => {
  // Guard against the refactor silently altering the ordinary paths.
  assert.equal(
    changedFilesWithinAdditiveOnlyAllowlist([file('projects/codex-runaway-guardrails/plan.json')]),
    true,
  );
  assert.equal(changedFilesWithinAdditiveOnlyAllowlist([file('docs/AUDIT-2026-06-19.md')]), true);
  assert.equal(changedFilesWithinAdditiveOnlyAllowlist([file('src/evil.mjs')]), false);
  assert.equal(changedFilesWithinAdditiveOnlyAllowlist([]), false);
  // A change set of only unnamed entries must not read as "all allowed".
  assert.equal(changedFilesWithinAdditiveOnlyAllowlist([{}, { filename: '' }]), false);
});

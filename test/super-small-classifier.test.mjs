import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SINGLE_REVIEW_DEFAULTS,
  SUPER_SMALL_BASIS,
  SUPER_SMALL_REFUSAL,
  classifySuperSmall,
  classifySuperSmallForDiff,
  describeSuperSmallDecision,
  resolveSingleReviewPolicy,
} from '../src/super-small-classifier.mjs';
import { FORCE_FULL_REVIEW_LABEL, SLIM_REVIEW_DENY_PREFIXES_ENV } from '../src/slim-review-eligibility.mjs';

function policy(overrides = {}) {
  return {
    ...SINGLE_REVIEW_DEFAULTS,
    slimMaxFiles: 20,
    slimMaxChangedLines: 400,
    deniedPrefixes: [],
    forceFull: false,
    ...overrides,
  };
}

function codes(decision) {
  return decision.reasons.map((reason) => reason.code);
}

function unifiedDiff(files) {
  return files.map(({ path, added = 0, removed = 0 }) => [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${removed} +1,${added} @@`,
    ...Array.from({ length: removed }, (_, i) => `-old ${i}`),
    ...Array.from({ length: added }, (_, i) => `+new ${i}`),
  ].join('\n')).join('\n') + '\n';
}

test('a 12-line code fix on 2 files is super-small', () => {
  const decision = classifySuperSmall({
    changedFiles: [
      { path: 'src/pr-comments.mjs', added: 5, removed: 3 },
      { path: 'src/verdict-parser.mjs', added: 3, removed: 1 },
    ],
    policy: policy(),
  });
  assert.equal(decision.superSmall, true);
  assert.equal(decision.basis, SUPER_SMALL_BASIS.SMALL_CHANGE);
  assert.deepEqual(decision.stats, { files: 2, added: 8, removed: 4, changedLines: 12 });
  assert.match(describeSuperSmallDecision(decision), /^super-small \(small-change; 2 file\(s\), 12 changed line\(s\)\)/);
});

test('a 12-line fix classified from a real unified diff is super-small', () => {
  const decision = classifySuperSmallForDiff({
    diff: unifiedDiff([
      { path: 'src/pr-comments.mjs', added: 5, removed: 3 },
      { path: 'test/pr-comments.test.mjs', added: 4, removed: 0 },
    ]),
    policy: policy(),
  });
  assert.equal(decision.superSmall, true);
  assert.equal(decision.stats.changedLines, 12);
});

test('a 300-line docs-only PR is super-small through the slim limits', () => {
  const decision = classifySuperSmall({
    changedFiles: [
      { path: 'docs/RUNBOOK-ama-closure.md', added: 200, removed: 40 },
      { path: 'README.md', added: 60, removed: 0 },
    ],
    policy: policy(),
  });
  assert.equal(decision.superSmall, true);
  assert.equal(decision.basis, SUPER_SMALL_BASIS.DOCS_TESTS);
});

test('docs/tests-only past the slim limits, or with the slim rule off, is not super-small', () => {
  const big = classifySuperSmall({
    changedFiles: [{ path: 'docs/guide.md', added: 401, removed: 0 }],
    policy: policy(),
  });
  assert.equal(big.superSmall, false);
  assert.deepEqual(codes(big), [SUPER_SMALL_REFUSAL.TOO_LARGE]);
  const off = classifySuperSmall({
    changedFiles: [{ path: 'docs/guide.md', added: 300, removed: 0 }],
    policy: policy({ docsTestsFollowSlimLimits: false }),
  });
  assert.equal(off.superSmall, false);
});

test('a 10-line change to src/watcher.mjs gets normal rounds', () => {
  const decision = classifySuperSmall({
    changedFiles: [{ path: 'src/watcher.mjs', added: 6, removed: 4 }],
    policy: policy(),
  });
  assert.equal(decision.superSmall, false);
  assert.deepEqual(codes(decision), [SUPER_SMALL_REFUSAL.GATE_KEEPER_PATH]);
});

test('every gate-keeper surface path refuses, including under the submodule mount', () => {
  for (const path of [
    'src/reviewer.mjs',
    'src/review-state.mjs',
    'src/process-group-spawn.mjs',
    'src/reviewer-reattach.mjs',
    'src/reviewer-cascade.mjs',
    'src/kernel/prompt-stage.mjs',
    'src/adapters/agent-runtime/local/codex.mjs',
    'launchd/ai.agent-os.adversarial-watcher.plist',
    'tools/adversarial-review/deploy/launchd/follow-up.plist.template',
    'scripts/adversarial-follow-up-tick.sh',
    'tools/adversarial-review/src/watcher.mjs',
  ]) {
    const decision = classifySuperSmall({ changedFiles: [{ path, added: 1 }], policy: policy() });
    assert.equal(decision.superSmall, false, path);
    assert.ok(codes(decision).includes(SUPER_SMALL_REFUSAL.GATE_KEEPER_PATH), path);
  }
  // Near-miss names are ordinary code.
  const nearMiss = classifySuperSmall({
    changedFiles: [{ path: 'src/reviewer-prompt.mjs', added: 3 }],
    policy: policy(),
  });
  assert.equal(nearMiss.superSmall, true);
});

test('a 60-line code change gets normal rounds', () => {
  const decision = classifySuperSmall({
    changedFiles: [{ path: 'src/pr-comments.mjs', added: 40, removed: 20 }],
    policy: policy(),
  });
  assert.equal(decision.superSmall, false);
  assert.deepEqual(codes(decision), [SUPER_SMALL_REFUSAL.TOO_LARGE]);
});

test('six small files is over the file limit', () => {
  const decision = classifySuperSmall({
    changedFiles: Array.from({ length: 6 }, (_, i) => ({ path: `src/leaf-${i}.mjs`, added: 1 })),
    policy: policy(),
  });
  assert.equal(decision.superSmall, false);
  assert.deepEqual(codes(decision), [SUPER_SMALL_REFUSAL.TOO_LARGE]);
});

test('a migration file gets normal rounds', () => {
  for (const path of [
    'platform/db/alembic/versions/20260929_add_col.py',
    'migrations/0042_review_rows.sql',
    'schema/seed.sql',
  ]) {
    const decision = classifySuperSmall({ changedFiles: [{ path, added: 4 }], policy: policy() });
    assert.equal(decision.superSmall, false, path);
    assert.ok(codes(decision).includes(SUPER_SMALL_REFUSAL.MIGRATION_PATH), path);
  }
});

test('secret, credential and auth paths never qualify; author paths do', () => {
  for (const path of [
    'src/secret-source/op.mjs',
    'lib/credential-store.mjs',
    'src/githubOAuthBroker.mjs',
    'platform/op_adapter.py',
    'src/keychain-read.mjs',
    'src/auth/session.mjs',
    'src/authorization-check.mjs',
  ]) {
    const decision = classifySuperSmall({ changedFiles: [{ path, added: 2 }], policy: policy() });
    assert.equal(decision.superSmall, false, path);
    assert.ok(codes(decision).includes(SUPER_SMALL_REFUSAL.SECRET_AUTH_PATH), path);
  }
  const author = classifySuperSmall({
    changedFiles: [{ path: 'src/pr-author.mjs', added: 2 }],
    policy: policy(),
  });
  assert.equal(author.superSmall, true);
});

test('.github/workflows never qualifies', () => {
  const decision = classifySuperSmall({
    changedFiles: [{ path: '.github/workflows/ci.yml', added: 1, removed: 1 }],
    policy: policy(),
  });
  assert.equal(decision.superSmall, false);
  assert.ok(codes(decision).includes(SUPER_SMALL_REFUSAL.WORKFLOW_PATH));
});

test('a dependency manifest never qualifies', () => {
  const decision = classifySuperSmall({
    changedFiles: [{ path: 'package.json', added: 1, removed: 1 }],
    policy: policy(),
  });
  assert.equal(decision.superSmall, false);
  assert.ok(codes(decision).includes(SUPER_SMALL_REFUSAL.DEPENDENCY_MANIFEST));
});

test('an operator slim deny prefix refuses', () => {
  const resolved = resolveSingleReviewPolicy({
    env: { [SLIM_REVIEW_DENY_PREFIXES_ENV]: 'src/payments' },
    loadRoleConfigImpl: () => ({ get: (_key, fallback) => fallback }),
  });
  const decision = classifySuperSmall({
    changedFiles: [{ path: 'src/payments/refund.mjs', added: 3 }],
    policy: resolved,
  });
  assert.equal(decision.superSmall, false);
  assert.deepEqual(codes(decision), [SUPER_SMALL_REFUSAL.OPERATOR_DENIED_PREFIX]);
});

test('the force-full label gets normal rounds', () => {
  const decision = classifySuperSmall({
    changedFiles: [{ path: 'src/pr-comments.mjs', added: 5, removed: 3 }],
    labels: [{ name: FORCE_FULL_REVIEW_LABEL }],
    policy: policy(),
  });
  assert.equal(decision.superSmall, false);
  assert.deepEqual(codes(decision), [SUPER_SMALL_REFUSAL.OPERATOR_FORCED_FULL]);
});

test('enabled=false leaves every PR on normal rounds', () => {
  const decision = classifySuperSmall({
    changedFiles: [{ path: 'src/pr-comments.mjs', added: 5, removed: 3 }],
    policy: policy({ enabled: false }),
  });
  assert.equal(decision.superSmall, false);
  assert.deepEqual(codes(decision), [SUPER_SMALL_REFUSAL.DISABLED]);
});

test('unknown or empty change sets refuse', () => {
  assert.deepEqual(codes(classifySuperSmall({ changedFiles: null, policy: policy() })), [SUPER_SMALL_REFUSAL.CHANGED_FILES_UNKNOWN]);
  assert.deepEqual(codes(classifySuperSmall({ changedFiles: [], policy: policy() })), [SUPER_SMALL_REFUSAL.EMPTY_CHANGE_SET]);
});

test('resolveSingleReviewPolicy reads the config knobs and fails closed to disabled', () => {
  const values = {
    'roles.adversarial.single_review.enabled': true,
    'roles.adversarial.single_review.max_changed_lines': 20,
    'roles.adversarial.single_review.max_files': 2,
    'roles.adversarial.single_review.docs_tests_follow_slim_limits': false,
  };
  const resolved = resolveSingleReviewPolicy({
    env: {},
    loadRoleConfigImpl: () => ({ get: (key, fallback) => (key in values ? values[key] : fallback) }),
  });
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.maxChangedLines, 20);
  assert.equal(resolved.maxFiles, 2);
  assert.equal(resolved.docsTestsFollowSlimLimits, false);
  assert.equal(resolved.slimMaxChangedLines, 400);

  const broken = resolveSingleReviewPolicy({
    env: {},
    loadRoleConfigImpl: () => { throw new Error('config.yaml unreadable'); },
  });
  assert.equal(broken.enabled, false);
  assert.match(broken.configError, /unreadable/);
});

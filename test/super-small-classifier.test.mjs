import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SINGLE_REVIEW_DEFAULTS,
  SINGLE_REVIEW_ENABLED_ENV,
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

test('a submodule pointer bump never qualifies, from a real gitlink diff', () => {
  const diff = [
    'diff --git a/tools/adversarial-review b/tools/adversarial-review',
    'index 1111111..2222222 160000',
    '--- a/tools/adversarial-review',
    '+++ b/tools/adversarial-review',
    '@@ -1 +1 @@',
    '-Subproject commit 1111111111111111111111111111111111111111',
    '+Subproject commit 2222222222222222222222222222222222222222',
    '',
  ].join('\n');
  const decision = classifySuperSmallForDiff({ diff, policy: policy() });
  assert.equal(decision.superSmall, false);
  assert.deepEqual(codes(decision), [SUPER_SMALL_REFUSAL.GITLINK_CHANGE, SUPER_SMALL_REFUSAL.GATE_KEEPER_PATH]);

  // Any other submodule's gitlink refuses too, on the entry facts alone.
  const other = classifySuperSmallForDiff({
    diff: diff.replaceAll('tools/adversarial-review', 'vendor/libfoo'),
    policy: policy(),
  });
  assert.deepEqual(codes(other), [SUPER_SMALL_REFUSAL.GITLINK_CHANGE]);

  const added = classifySuperSmallForDiff({
    diff: [
      'diff --git a/vendor/libfoo b/vendor/libfoo',
      'new file mode 160000',
      'index 0000000..2222222',
      '--- /dev/null',
      '+++ b/vendor/libfoo',
      '@@ -0,0 +1 @@',
      '+Subproject commit 2222222222222222222222222222222222222222',
      '',
    ].join('\n'),
    policy: policy(),
  });
  assert.ok(codes(added).includes(SUPER_SMALL_REFUSAL.GITLINK_CHANGE));
});

test('.gitmodules is a gate-keeper path', () => {
  const decision = classifySuperSmallForDiff({
    diff: unifiedDiff([{ path: '.gitmodules', added: 1, removed: 1 }]),
    policy: policy(),
  });
  assert.equal(decision.superSmall, false);
  assert.ok(codes(decision).includes(SUPER_SMALL_REFUSAL.GATE_KEEPER_PATH));
});

test('renames are refused and classified by both paths', () => {
  const rename = (from, to) => [
    `diff --git a/${from} b/${to}`,
    'similarity index 100%',
    `rename from ${from}`,
    `rename to ${to}`,
    '',
  ].join('\n');

  const workflow = classifySuperSmallForDiff({ diff: rename('.github/workflows/ci.yml', '.github/ci.yml.disabled'), policy: policy() });
  assert.equal(workflow.superSmall, false);
  assert.ok(codes(workflow).includes(SUPER_SMALL_REFUSAL.RENAME_OR_COPY));
  assert.ok(codes(workflow).includes(SUPER_SMALL_REFUSAL.WORKFLOW_PATH));
  assert.equal(workflow.reasons.find((r) => r.code === SUPER_SMALL_REFUSAL.WORKFLOW_PATH).path, '.github/workflows/ci.yml');

  const gateKeeper = classifySuperSmallForDiff({ diff: rename('src/watcher.mjs', 'src/watcher-old.mjs'), policy: policy() });
  assert.ok(codes(gateKeeper).includes(SUPER_SMALL_REFUSAL.GATE_KEEPER_PATH));
  assert.ok(codes(gateKeeper).includes(SUPER_SMALL_REFUSAL.RENAME_OR_COPY));

  const innocuous = classifySuperSmallForDiff({ diff: rename('src/pr-comments.mjs', 'src/pr-comment.mjs'), policy: policy() });
  assert.deepEqual(codes(innocuous), [SUPER_SMALL_REFUSAL.RENAME_OR_COPY]);

  // The pre-image path is honoured when a caller passes changed files directly.
  const direct = classifySuperSmall({
    changedFiles: [{ path: 'docs/notes.sql.md', oldPath: 'migrations/0001_init.sql', added: 1 }],
    policy: policy(),
  });
  assert.ok(codes(direct).includes(SUPER_SMALL_REFUSAL.MIGRATION_PATH));
});

test('copies and mode changes are refused', () => {
  const copy = classifySuperSmallForDiff({
    diff: [
      'diff --git a/src/pr-comments.mjs b/src/pr-comments-copy.mjs',
      'similarity index 100%',
      'copy from src/pr-comments.mjs',
      'copy to src/pr-comments-copy.mjs',
      '',
    ].join('\n'),
    policy: policy(),
  });
  assert.deepEqual(codes(copy), [SUPER_SMALL_REFUSAL.RENAME_OR_COPY]);

  const mode = classifySuperSmallForDiff({
    diff: ['diff --git a/src/pr-comments.mjs b/src/pr-comments.mjs', 'old mode 100644', 'new mode 100755', ''].join('\n'),
    policy: policy(),
  });
  assert.deepEqual(codes(mode), [SUPER_SMALL_REFUSAL.MODE_CHANGE]);
});

test(`${SINGLE_REVIEW_ENABLED_ENV} overrides the config enabled key`, () => {
  const loadRoleConfigImpl = () => ({ get: (_key, fallback) => fallback });
  assert.equal(resolveSingleReviewPolicy({ env: { [SINGLE_REVIEW_ENABLED_ENV]: 'false' }, loadRoleConfigImpl }).enabled, false);
  assert.equal(resolveSingleReviewPolicy({ env: { [SINGLE_REVIEW_ENABLED_ENV]: '0' }, loadRoleConfigImpl }).enabled, false);
  assert.equal(resolveSingleReviewPolicy({ env: { [SINGLE_REVIEW_ENABLED_ENV]: 'garbage' }, loadRoleConfigImpl }).enabled, true);
  const configOff = () => ({ get: (key, fallback) => (key.endsWith('.enabled') ? false : fallback) });
  assert.equal(resolveSingleReviewPolicy({ env: { [SINGLE_REVIEW_ENABLED_ENV]: 'true' }, loadRoleConfigImpl: configOff }).enabled, true);
  assert.equal(resolveSingleReviewPolicy({ env: {}, loadRoleConfigImpl: configOff }).enabled, false);
});

// RPL-08 — low-risk slim review fast lane classifier.
//
// The contract under test is asymmetric and the tests are written that way: a
// missed acceptance costs latency, a wrong acceptance costs the gate. Every
// refusal case therefore asserts the specific refusal code, not just
// `slim === false`, so a rule that stops firing cannot be masked by a different
// rule that happens to catch the same fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FORCE_FULL_REVIEW_LABEL,
  LOW_RISK_CLASS,
  REVIEW_MODE,
  SLIM_REVIEW_DENY_PREFIXES_ENV,
  SLIM_REVIEW_ENABLED_ENV,
  SLIM_REVIEW_FORCE_FULL_ENV,
  SLIM_REVIEW_REFUSAL,
  buildReviewModeAuditBlock,
  buildSlimReviewContextBanner,
  changedFilesFromDiff,
  evaluateSlimReviewEligibility,
  evaluateSlimReviewEligibilityForDiff,
  gateKeeperCategoriesForPath,
  generatedChurnMarkerForPath,
  hasForceFullReviewLabel,
  isDocumentationPath,
  isTestPath,
  lowRiskClassForPath,
  resolveSlimReviewPolicy,
  summarizeReviewModeDecision,
} from '../src/slim-review-eligibility.mjs';

const POLICY = resolveSlimReviewPolicy({});

function decide(paths, overrides = {}) {
  return evaluateSlimReviewEligibility({
    changedFiles: paths.map((path) => (typeof path === 'string' ? { path, added: 3, removed: 1 } : path)),
    policy: POLICY,
    ...overrides,
  });
}

function refusalCodes(decision) {
  return new Set(decision.refusals.map((item) => item.code));
}

// ---------------------------------------------------------------------------
// Accepted: low-risk docs.
// ---------------------------------------------------------------------------

test('docs-only PRs enter slim mode', () => {
  for (const path of [
    'README.md',
    'docs/GLOSSARY.md',
    'docs/architecture/overview.md',
    'CONTRIBUTING.md',
    'docs/notes.txt',
    'LICENSE',
  ]) {
    const decision = decide([path]);
    assert.equal(decision.slim, true, `${path} should be slim-eligible: ${JSON.stringify(decision.refusals)}`);
    assert.equal(decision.mode, REVIEW_MODE.SLIM);
    assert.deepEqual(decision.lowRiskClasses, [LOW_RISK_CLASS.DOCS]);
  }
});

test('a topic word in a document title is not a gate-keeper privilege', () => {
  // `merge`, `verdict`, and `reviewer` are gate-keeper TOKENS in executable
  // paths. In a document filename they name a subject, and refusing them would
  // push the pipeline's own runbooks — the single most common low-risk PR in
  // this repo — permanently out of the fast lane.
  const decision = decide(['docs/RUNBOOK-fast-merge-lane.md']);
  assert.equal(decision.slim, true, JSON.stringify(decision.refusals));
});

// ---------------------------------------------------------------------------
// Accepted: single test-only change.
// ---------------------------------------------------------------------------

test('a single test-only change enters slim mode', () => {
  const decision = decide(['test/string-format.test.mjs']);
  assert.equal(decision.slim, true, JSON.stringify(decision.refusals));
  assert.deepEqual(decision.lowRiskClasses, [LOW_RISK_CLASS.TESTS]);
});

test('test path shapes across ecosystems classify as tests', () => {
  for (const path of [
    'test/string-format.test.mjs',
    'tests/unit/format_test.py',
    'spec/format.spec.ts',
    '__tests__/format.jsx',
    'platform/fmt/test_format.py',
    'pkg/fmt/format_test.go',
  ]) {
    assert.equal(isTestPath(path), true, `${path} should be a test path`);
    assert.equal(lowRiskClassForPath(path), LOW_RISK_CLASS.TESTS, path);
  }
});

test('mixed docs and tests stay slim and report both classes', () => {
  const decision = decide(['docs/GLOSSARY.md', 'test/string-format.test.mjs']);
  assert.equal(decision.slim, true, JSON.stringify(decision.refusals));
  assert.deepEqual(decision.lowRiskClasses, [LOW_RISK_CLASS.DOCS, LOW_RISK_CLASS.TESTS]);
});

// ---------------------------------------------------------------------------
// Refused: gate-keeper surfaces.
// ---------------------------------------------------------------------------

test('gate-keeper paths are refused with the gate-keeper code', () => {
  const cases = [
    ['src/watcher.mjs', 'reviewer-core'],
    ['src/reviewer.mjs', 'reviewer-core'],
    ['src/pollonce-phases.mjs', 'reviewer-core'],
    ['src/ama/merge-eligibility.mjs', 'merge-authority'],
    ['src/kernel/verdict.mjs', 'reviewer-core'],
    ['prompts/code-pr/reviewer.first.md', 'reviewer-core'],
    ['domains/code-pr.json', 'reviewer-core'],
    ['bin/merge-lease.mjs', 'pipeline-entrypoint'],
    ['scripts/adversarial-watcher-start.sh', 'pipeline-entrypoint'],
    ['migrations/20260911_review_latency_events.sql', 'schema-migration'],
    ['config.yaml', 'pipeline-config'],
    ['modules/worker-pool/lib/hq-adjudicate-merge.sh', 'merge-authority'],
  ];
  for (const [path, expectedCategory] of cases) {
    const categories = gateKeeperCategoriesForPath(path);
    assert.ok(categories.includes(expectedCategory), `${path} should be ${expectedCategory}, got ${categories.join(',')}`);
    const decision = decide([path]);
    assert.equal(decision.slim, false, path);
    assert.ok(refusalCodes(decision).has(SLIM_REVIEW_REFUSAL.GATE_KEEPER_PATH), path);
  }
});

test('a test that encodes gate-keeper behaviour cannot enter slim mode', () => {
  // The test file is a low-risk CLASS but a gate-keeper SURFACE. Slim mode is a
  // conjunction, so the gate-keeper refusal wins: a change to the watcher claim
  // loop's regression test rewrites the pipeline's own contract, and a reviewer
  // asked to judge that without full context is the wrong trade.
  const decision = decide(['test/watcher-claim-loop.test.mjs']);
  assert.equal(decision.slim, false);
  assert.equal(decision.mode, REVIEW_MODE.FULL);
  assert.ok(refusalCodes(decision).has(SLIM_REVIEW_REFUSAL.GATE_KEEPER_PATH));
});

test('markdown inside a control-plane directory is still gate-keeper', () => {
  // The documentation exemption applies to TOKENS only. Anchored patterns still
  // cover a doc that lives inside the surface it documents.
  for (const path of ['.github/PULL_REQUEST_TEMPLATE.md', 'src/ama/FREEZE.md', 'prompts/code-pr/README.md']) {
    assert.ok(gateKeeperCategoriesForPath(path).length > 0, path);
    assert.equal(decide([path]).slim, false, path);
  }
});

// ---------------------------------------------------------------------------
// Refused: auth, secrets, CI, launchd.
// ---------------------------------------------------------------------------

test('auth and secrets paths are refused via the security-surface classifier', () => {
  for (const path of [
    'platform/auth/session.py',
    'src/oauth-transport.mjs',
    'deploy/credentials.yaml',
    '.env.production',
    'infra/tls/server.pem',
    'etc/sudoers',
  ]) {
    const decision = decide([path]);
    assert.equal(decision.slim, false, path);
    assert.ok(
      refusalCodes(decision).has(SLIM_REVIEW_REFUSAL.SECURITY_SURFACE),
      `${path} should refuse on security-surface, got ${[...refusalCodes(decision)].join(',')}`
    );
  }
});

test('CI workflow changes are refused even when the diff is tiny', () => {
  const decision = decide([{ path: '.github/workflows/test.yml', added: 1, removed: 1 }]);
  assert.equal(decision.slim, false);
  const codes = refusalCodes(decision);
  assert.ok(codes.has(SLIM_REVIEW_REFUSAL.SECURITY_SURFACE));
  assert.ok(codes.has(SLIM_REVIEW_REFUSAL.GATE_KEEPER_PATH));
});

test('launchd service templates are refused', () => {
  const decision = decide(['launchd/ai.laceyenterprises.adversarial-watcher.airlock.plist']);
  assert.equal(decision.slim, false);
  const codes = refusalCodes(decision);
  assert.ok(codes.has(SLIM_REVIEW_REFUSAL.GATE_KEEPER_PATH));
  assert.ok(codes.has(SLIM_REVIEW_REFUSAL.SECURITY_SURFACE));
});

test('dependency manifests are refused however small the change', () => {
  for (const path of ['package.json', 'frontend/package-lock.json', 'requirements/base.txt', 'go.mod']) {
    const decision = decide([{ path, added: 1, removed: 1 }]);
    assert.equal(decision.slim, false, path);
    assert.ok(refusalCodes(decision).has(SLIM_REVIEW_REFUSAL.SECURITY_SURFACE), path);
  }
});

test('a dependency bot author is refused even on an otherwise low-risk path', () => {
  const decision = decide(['docs/GLOSSARY.md'], { author: 'app/dependabot' });
  assert.equal(decision.slim, false);
  assert.ok(refusalCodes(decision).has(SLIM_REVIEW_REFUSAL.SECURITY_SURFACE));
});

// ---------------------------------------------------------------------------
// Refused: generated churn.
// ---------------------------------------------------------------------------

test('generated and vendored churn is refused', () => {
  for (const path of [
    'dist/bundle.js',
    'frontend/build/index.html',
    'vendor/github.com/pkg/errors/errors.go',
    'coverage/lcov-report/index.html',
    'test/__snapshots__/render.test.mjs.snap',
    'src/api.generated.ts',
    'proto/service.pb.go',
    'web/app.min.js',
  ]) {
    assert.ok(generatedChurnMarkerForPath(path), `${path} should be generated churn`);
    const decision = decide([path]);
    assert.equal(decision.slim, false, path);
    assert.ok(refusalCodes(decision).has(SLIM_REVIEW_REFUSAL.GENERATED_CHURN), path);
  }
});

test('broad churn over low-risk files is refused on volume', () => {
  const manyFiles = Array.from({ length: 25 }, (_, index) => ({
    path: `docs/page-${index}.md`,
    added: 2,
    removed: 0,
  }));
  const wideDecision = decide(manyFiles);
  assert.equal(wideDecision.slim, false);
  assert.ok(refusalCodes(wideDecision).has(SLIM_REVIEW_REFUSAL.TOO_MANY_FILES));

  const deepDecision = decide([{ path: 'docs/manual.md', added: 5000, removed: 120 }]);
  assert.equal(deepDecision.slim, false);
  assert.ok(refusalCodes(deepDecision).has(SLIM_REVIEW_REFUSAL.TOO_MANY_CHANGED_LINES));
  assert.equal(deepDecision.stats.changedLines, 5120);
});

test('a binary change is refused', () => {
  const decision = decide([{ path: 'docs/diagram.png', added: 0, removed: 0, binary: true }]);
  assert.equal(decision.slim, false);
  assert.ok(refusalCodes(decision).has(SLIM_REVIEW_REFUSAL.BINARY_CHANGE));
});

// ---------------------------------------------------------------------------
// Refused: mixed-risk PRs.
// ---------------------------------------------------------------------------

test('one non-low-risk file in an otherwise low-risk PR refuses the whole PR', () => {
  const decision = decide(['docs/GLOSSARY.md', 'test/format.test.mjs', 'platform/api/handler.py']);
  assert.equal(decision.slim, false);
  const nonLowRisk = decision.refusals.filter((item) => item.code === SLIM_REVIEW_REFUSAL.NON_LOW_RISK_PATH);
  assert.deepEqual(nonLowRisk.map((item) => item.path), ['platform/api/handler.py']);
});

test('mixed docs plus a secrets path reports both refusals, not just the first', () => {
  const decision = decide(['docs/GLOSSARY.md', 'deploy/credentials.yaml']);
  assert.equal(decision.slim, false);
  const codes = refusalCodes(decision);
  assert.ok(codes.has(SLIM_REVIEW_REFUSAL.SECURITY_SURFACE));
  assert.ok(codes.has(SLIM_REVIEW_REFUSAL.NON_LOW_RISK_PATH));
});

// ---------------------------------------------------------------------------
// Refused: unknown / empty inputs. Deny by default.
// ---------------------------------------------------------------------------

test('an undeterminable changed-file list refuses rather than defaulting to slim', () => {
  for (const changedFiles of [null, undefined, 'docs/GLOSSARY.md']) {
    const decision = evaluateSlimReviewEligibility({ changedFiles, policy: POLICY });
    assert.equal(decision.slim, false);
    assert.ok(refusalCodes(decision).has(SLIM_REVIEW_REFUSAL.CHANGED_FILES_UNKNOWN));
  }
});

test('an empty change set refuses', () => {
  const decision = evaluateSlimReviewEligibility({ changedFiles: [], policy: POLICY });
  assert.equal(decision.slim, false);
  assert.ok(refusalCodes(decision).has(SLIM_REVIEW_REFUSAL.EMPTY_CHANGE_SET));
});

test('evaluateSlimReviewEligibility with no arguments refuses', () => {
  const decision = evaluateSlimReviewEligibility();
  assert.equal(decision.slim, false);
  assert.equal(decision.mode, REVIEW_MODE.FULL);
});

// ---------------------------------------------------------------------------
// Operator override.
// ---------------------------------------------------------------------------

test('the force-full label overrides an otherwise slim-eligible PR', () => {
  const decision = decide(['docs/GLOSSARY.md'], { labels: [{ name: FORCE_FULL_REVIEW_LABEL }] });
  assert.equal(decision.slim, false);
  assert.equal(decision.mode, REVIEW_MODE.FORCED_FULL);
  assert.equal(decision.forcedBy, `label:${FORCE_FULL_REVIEW_LABEL}`);
});

test('the force-full label is matched case-insensitively in both label shapes', () => {
  assert.equal(hasForceFullReviewLabel([FORCE_FULL_REVIEW_LABEL]), true);
  assert.equal(hasForceFullReviewLabel([{ name: FORCE_FULL_REVIEW_LABEL.toUpperCase() }]), true);
  assert.equal(hasForceFullReviewLabel(['operator-approved: scope-expand']), false);
  assert.equal(hasForceFullReviewLabel(null), false);
});

test('the force-full environment variable overrides every PR', () => {
  const policy = resolveSlimReviewPolicy({ [SLIM_REVIEW_FORCE_FULL_ENV]: '1' });
  const decision = decide(['docs/GLOSSARY.md'], { policy });
  assert.equal(decision.mode, REVIEW_MODE.FORCED_FULL);
  assert.equal(decision.forcedBy, `env:${SLIM_REVIEW_FORCE_FULL_ENV}`);
});

test('a forced-full PR still reports whether the classifier would have agreed', () => {
  // The override must not short-circuit the predicate: an operator reading the
  // report needs to see the difference between "forced full, and it was risky
  // anyway" and "forced full over a change the rules called low risk".
  const wouldHaveBeenSlim = decide(['docs/GLOSSARY.md'], { labels: [FORCE_FULL_REVIEW_LABEL] });
  assert.deepEqual(
    [...refusalCodes(wouldHaveBeenSlim)],
    [SLIM_REVIEW_REFUSAL.OPERATOR_FORCED_FULL],
  );

  const riskyAnyway = decide(['src/watcher.mjs'], { labels: [FORCE_FULL_REVIEW_LABEL] });
  assert.ok(refusalCodes(riskyAnyway).has(SLIM_REVIEW_REFUSAL.GATE_KEEPER_PATH));
});

test('a forced-full refusal is distinguishable from an ordinary full review', () => {
  assert.equal(decide(['src/watcher.mjs']).mode, REVIEW_MODE.FULL);
  assert.equal(decide(['docs/GLOSSARY.md'], { labels: [FORCE_FULL_REVIEW_LABEL] }).mode, REVIEW_MODE.FORCED_FULL);
});

test('the kill switch disables the lane without claiming the PR was risky', () => {
  const policy = resolveSlimReviewPolicy({ [SLIM_REVIEW_ENABLED_ENV]: 'false' });
  const decision = decide(['docs/GLOSSARY.md'], { policy });
  assert.equal(decision.slim, false);
  assert.equal(decision.mode, REVIEW_MODE.FULL);
  assert.deepEqual([...refusalCodes(decision)], [SLIM_REVIEW_REFUSAL.DISABLED]);
});

test('operator deny prefixes refuse matching paths and leave siblings alone', () => {
  const policy = resolveSlimReviewPolicy({ [SLIM_REVIEW_DENY_PREFIXES_ENV]: 'docs/legal, docs/security' });
  assert.deepEqual(policy.deniedPrefixes, ['docs/legal', 'docs/security']);
  assert.equal(decide(['docs/legal/terms.md'], { policy }).slim, false);
  assert.ok(refusalCodes(decide(['docs/security/notes.md'], { policy }))
    .has(SLIM_REVIEW_REFUSAL.OPERATOR_DENIED_PREFIX));
  // `docs/legalese.md` shares the prefix as a string but not as a path.
  assert.equal(decide(['docs/legalese.md'], { policy }).slim, true);
});

// ---------------------------------------------------------------------------
// Policy resolution.
// ---------------------------------------------------------------------------

test('policy defaults are conservative and overridable', () => {
  const defaults = resolveSlimReviewPolicy({});
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.forceFull, false);
  assert.equal(defaults.maxFiles, 20);
  assert.equal(defaults.maxChangedLines, 400);
  assert.deepEqual(defaults.deniedPrefixes, []);

  const tuned = resolveSlimReviewPolicy({
    ADVERSARIAL_REVIEW_SLIM_MAX_FILES: '3',
    ADVERSARIAL_REVIEW_SLIM_MAX_CHANGED_LINES: '10',
  });
  assert.equal(tuned.maxFiles, 3);
  assert.equal(tuned.maxChangedLines, 10);

  // Garbage must not silently widen the lane.
  const garbage = resolveSlimReviewPolicy({
    ADVERSARIAL_REVIEW_SLIM_MAX_FILES: 'lots',
    ADVERSARIAL_REVIEW_SLIM_MAX_CHANGED_LINES: '-5',
    [SLIM_REVIEW_ENABLED_ENV]: 'maybe',
  });
  assert.equal(garbage.maxFiles, 20);
  assert.equal(garbage.maxChangedLines, 400);
  assert.equal(garbage.enabled, true);
});

// ---------------------------------------------------------------------------
// Diff parsing.
// ---------------------------------------------------------------------------

const DOCS_DIFF = `diff --git a/docs/GLOSSARY.md b/docs/GLOSSARY.md
index 1111111..2222222 100644
--- a/docs/GLOSSARY.md
+++ b/docs/GLOSSARY.md
@@ -1,3 +1,4 @@
 # Glossary
+**Slim review** — the RPL-08 low-risk fast lane.
-**Stale term** — removed.
 End.
`;

test('changedFilesFromDiff extracts paths and line counts without counting headers', () => {
  const files = changedFilesFromDiff(DOCS_DIFF);
  assert.deepEqual(files, [{ path: 'docs/GLOSSARY.md', added: 1, removed: 1, binary: false }]);
});

test('changedFilesFromDiff marks binary patches and does not count their lines', () => {
  const diff = `diff --git a/docs/diagram.png b/docs/diagram.png
index 3333333..4444444 100644
Binary files a/docs/diagram.png and b/docs/diagram.png differ
`;
  assert.deepEqual(
    changedFilesFromDiff(diff),
    [{ path: 'docs/diagram.png', added: 0, removed: 0, binary: true }],
  );
});

test('changedFilesFromDiff resolves a deletion to the deleted path', () => {
  // git writes the real path on BOTH sides of the `diff --git` header for a
  // deletion; only the `+++` line becomes /dev/null.
  const diff = `diff --git a/docs/old.md b/docs/old.md
deleted file mode 100644
index 1111111..0000000
--- a/docs/old.md
+++ /dev/null
@@ -1,2 +0,0 @@
-gone
-also gone
`;
  assert.deepEqual(
    changedFilesFromDiff(diff),
    [{ path: 'docs/old.md', added: 0, removed: 2, binary: false }],
  );
  assert.equal(decide([{ path: 'docs/old.md', added: 0, removed: 2 }]).slim, true);
});

test('line counting ignores the diff preamble and content that mimics it', () => {
  // A content line beginning `+++` or `---` is real content, and undercounting
  // it is the dangerous direction: the totals are a ceiling check, so a low
  // count is what lets a diff into the fast lane.
  const diff = `diff --git a/docs/sample.md b/docs/sample.md
index 1111111..2222222 100644
--- a/docs/sample.md
+++ b/docs/sample.md
@@ -1,2 +1,3 @@
 intro
+++ added line that looks like a header
---
-removed line
`;
  assert.deepEqual(
    changedFilesFromDiff(diff),
    [{ path: 'docs/sample.md', added: 1, removed: 2, binary: false }],
  );
});

test('an empty or unparseable diff yields no files and therefore refuses', () => {
  assert.deepEqual(changedFilesFromDiff(''), []);
  const decision = evaluateSlimReviewEligibilityForDiff({ diff: 'not a diff', policy: POLICY });
  assert.equal(decision.slim, false);
  assert.ok(refusalCodes(decision).has(SLIM_REVIEW_REFUSAL.EMPTY_CHANGE_SET));
});

test('evaluateSlimReviewEligibilityForDiff accepts a real docs diff', () => {
  const decision = evaluateSlimReviewEligibilityForDiff({ diff: DOCS_DIFF, policy: POLICY });
  assert.equal(decision.slim, true, JSON.stringify(decision.refusals));
  assert.deepEqual(decision.stats, { files: 1, added: 1, removed: 1, changedLines: 2 });
});

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

test('the slim banner names the classification and preserves the verdict contract', () => {
  const banner = buildSlimReviewContextBanner(decide(['docs/GLOSSARY.md']));
  assert.match(banner, /RPL-08 low-risk fast lane/);
  assert.match(banner, /docs/);
  assert.match(banner, /verdict contract is unchanged/);
  // A misclassification must be reportable, not silently absorbed.
  assert.match(banner, /misclassification is itself a finding/);
});

test('the slim banner is empty for any non-slim decision', () => {
  assert.equal(buildSlimReviewContextBanner(decide(['src/watcher.mjs'])), '');
  assert.equal(buildSlimReviewContextBanner(null), '');
});

test('the audit block distinguishes the three modes on the posted review', () => {
  const slim = buildReviewModeAuditBlock(decide(['docs/GLOSSARY.md']));
  assert.match(slim, /^> Review mode: \*\*slim\*\*/);
  assert.match(slim, /required checks are unchanged/);

  const forced = buildReviewModeAuditBlock(decide(['docs/GLOSSARY.md'], { labels: [FORCE_FULL_REVIEW_LABEL] }));
  assert.match(forced, /^> Review mode: \*\*forced-full\*\*/);
  assert.match(forced, new RegExp(FORCE_FULL_REVIEW_LABEL));

  // An ordinary full review is today's behaviour and gets no extra block.
  assert.equal(buildReviewModeAuditBlock(decide(['src/watcher.mjs'])), '');
  assert.equal(buildReviewModeAuditBlock(null), '');
});

test('audit blocks are blockquotes so verdict and finding parsers are unaffected', () => {
  // adversarial-review#521: headings inserted above `## Verdict` broke the
  // verdict and blocking-finding parsers on live review bodies.
  for (const decision of [
    decide(['docs/GLOSSARY.md']),
    decide(['docs/GLOSSARY.md'], { labels: [FORCE_FULL_REVIEW_LABEL] }),
  ]) {
    const block = buildReviewModeAuditBlock(decision);
    for (const line of block.split('\n').filter(Boolean)) {
      assert.ok(line.startsWith('>'), `audit block line must be a blockquote: ${line}`);
    }
  }
});

test('audit blocks contain no follow-up criticality trigger word', () => {
  // `classifyFollowUpCriticality` scans the WHOLE posted body for
  // critical/vulnerability/security/injection. A mode banner that happened to
  // use one of those words would escalate every slim review in Linear.
  const criticalWords = ['critical', 'vulnerability', 'security', 'injection'];
  for (const decision of [
    decide(['docs/GLOSSARY.md']),
    decide(['docs/GLOSSARY.md'], { labels: [FORCE_FULL_REVIEW_LABEL] }),
  ]) {
    const block = buildReviewModeAuditBlock(decision).toLowerCase();
    for (const word of criticalWords) {
      assert.ok(!block.includes(word), `audit block must not contain "${word}": ${block}`);
    }
  }
});

test('summarizeReviewModeDecision is stable and dedupes refusal codes', () => {
  const summary = summarizeReviewModeDecision(decide(['src/watcher.mjs', 'src/reviewer.mjs']));
  assert.equal(summary.mode, REVIEW_MODE.FULL);
  assert.equal(summary.slim, false);
  assert.deepEqual(summary.refusalCodes, [
    SLIM_REVIEW_REFUSAL.GATE_KEEPER_PATH,
    SLIM_REVIEW_REFUSAL.NON_LOW_RISK_PATH,
  ]);
  assert.equal(summary.stats.files, 2);

  const empty = summarizeReviewModeDecision(null);
  assert.equal(empty.mode, REVIEW_MODE.FULL);
  assert.deepEqual(empty.refusalCodes, []);
});

test('isDocumentationPath does not treat a dotfile as an extension', () => {
  assert.equal(isDocumentationPath('.env'), false);
  assert.equal(isDocumentationPath('.md'), false);
  assert.equal(isDocumentationPath('docs/a.md'), true);
});

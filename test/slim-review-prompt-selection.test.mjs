// RPL-08 — prompt/context selection for the slim review lane.
//
// The classifier decides; this is the wiring that acts on the decision. Two
// properties matter more than the rest and are asserted directly:
//
//   1. A risky diff cannot reach the slim context path, no matter which entry
//      point is used. The refusal has to hold at the place the prompt is built,
//      not only inside the predicate's unit tests.
//   2. Slim mode is context-thinning, never contract-thinning. The reviewer
//      stage prompt — verdict vocabulary, blocking-issue sections, evidence
//      discipline — is byte-identical in slim and full mode.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { __test__ } from '../src/reviewer.mjs';
import { buildReviewerPrompt, buildReviewerPromptPrefix } from '../src/reviewer-prompt.mjs';
import { selectReviewMode } from '../src/review-mode-selection.mjs';
import {
  FORCE_FULL_REVIEW_LABEL,
  REVIEW_MODE,
  SLIM_REVIEW_ENABLED_ENV,
  evaluateSlimReviewEligibilityForDiff,
  resolveSlimReviewPolicy,
} from '../src/slim-review-eligibility.mjs';

const { buildReviewerExtraContext, buildReviewCommentBody } = __test__;

const POLICY = resolveSlimReviewPolicy({});

const DOCS_DIFF = `diff --git a/docs/GLOSSARY.md b/docs/GLOSSARY.md
--- a/docs/GLOSSARY.md
+++ b/docs/GLOSSARY.md
@@ -1 +1,2 @@
 # Glossary
+**Slim review** — the RPL-08 low-risk fast lane.
`;

const WATCHER_DIFF = `diff --git a/src/watcher.mjs b/src/watcher.mjs
--- a/src/watcher.mjs
+++ b/src/watcher.mjs
@@ -1 +1,2 @@
 const pollIntervalMs = 300000;
+const merged = true;
`;

const AUTH_DIFF = `diff --git a/platform/auth/session.py b/platform/auth/session.py
--- a/platform/auth/session.py
+++ b/platform/auth/session.py
@@ -1 +1,2 @@
 SESSION = None
+SESSION = "open"
`;

const LOCKFILE_DIFF = `diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -1 +1,2 @@
 {}
+{"name": "x"}
`;

const SILENT_LOG = { error() {}, warn() {}, log() {} };

function decide(diff, { labels = [], author = null } = {}) {
  return evaluateSlimReviewEligibilityForDiff({ diff, labels, author, policy: POLICY });
}

/**
 * Build extra context with both expensive builders instrumented, so a test can
 * assert they were *not* called rather than only that their output is absent.
 */
async function buildContext(reviewModeDecision, { diff = DOCS_DIFF } = {}) {
  const calls = { linkedSpec: 0, hardening: 0 };
  const extraContext = await buildReviewerExtraContext({
    repo: 'laceyenterprises/agent-os',
    prNumber: 4242,
    prContext: { body: 'See docs/SPEC.md', comments: [], headRefOid: 'deadbeef' },
    diff,
    reviewModeDecision,
    log: SILENT_LOG,
    fetchLinkedSpecContentsImpl: async () => {
      calls.linkedSpec += 1;
      return '\n\n### docs/SPEC.md\n\n```md\ngoverning spec body\n```';
    },
    buildHardeningReviewContextImpl: async () => {
      calls.hardening += 1;
      return '\n\n## Hardening Ledger Context\n\nscar projection';
    },
  });
  return { extraContext, calls };
}

// ---------------------------------------------------------------------------
// Slim mode thins context.
// ---------------------------------------------------------------------------

test('a slim decision skips the linked-spec and hardening-ledger builders entirely', async () => {
  const decision = decide(DOCS_DIFF);
  assert.equal(decision.mode, REVIEW_MODE.SLIM);

  const { extraContext, calls } = await buildContext(decision);
  assert.deepEqual(calls, { linkedSpec: 0, hardening: 0 });
  assert.doesNotMatch(extraContext, /governing spec body/);
  assert.doesNotMatch(extraContext, /Hardening Ledger Context/);
  assert.match(extraContext, /Review Scope — Slim Context \(RPL-08 low-risk fast lane\)/);
});

test('slim context is an order of magnitude smaller at realistic full-context size', async () => {
  // The stubs above are deliberately tiny, which is the wrong yardstick for
  // this property: the saving is not "a few hundred bytes of banner" but the
  // linked-spec bundle, which `fetchLinkedSpecContents` caps at 12 documents of
  // 12 000 characters each. Size the stub the way the real builder is bounded.
  const linkedSpecBundle = Array.from({ length: 12 }, (_, index) => (
    `\n\n### docs/doc-${index}.md\n\n\`\`\`md\n${'x'.repeat(12000)}\n\`\`\``
  )).join('');

  const buildWith = (reviewModeDecision) => buildReviewerExtraContext({
    repo: 'laceyenterprises/agent-os',
    prNumber: 4242,
    prContext: { body: 'See docs/SPEC.md', comments: [], headRefOid: 'deadbeef' },
    diff: DOCS_DIFF,
    reviewModeDecision,
    log: SILENT_LOG,
    fetchLinkedSpecContentsImpl: async () => linkedSpecBundle,
    buildHardeningReviewContextImpl: async () => '\n\n## Hardening Ledger Context\n\nscar projection',
  });

  const slim = await buildWith(decide(DOCS_DIFF));
  const full = await buildWith(null);
  assert.ok(full.length > 100_000, `full context fixture should be large, got ${full.length}`);
  assert.ok(
    slim.length * 10 < full.length,
    `slim (${slim.length}) should be an order of magnitude under full (${full.length})`
  );
});

test('slim mode still carries watcher advisory findings', async () => {
  // Advisory findings are already in memory and cost nothing to include. They
  // are also the watcher telling the reviewer something specific about THIS
  // PR, which is exactly the context a fast lane must not drop.
  const extraContext = await buildReviewerExtraContext({
    repo: 'laceyenterprises/agent-os',
    prNumber: 4242,
    diff: DOCS_DIFF,
    advisoryFindings: [{ kind: 'vocabulary-fatigue', detail: 'repeated phrasing' }],
    reviewModeDecision: decide(DOCS_DIFF),
    log: SILENT_LOG,
    fetchLinkedSpecContentsImpl: async () => '',
    buildHardeningReviewContextImpl: async () => '',
  });
  assert.match(extraContext, /Watcher Advisory Findings/);
  assert.match(extraContext, /vocabulary-fatigue/);
});

// ---------------------------------------------------------------------------
// Risky changes cannot reach the slim path.
// ---------------------------------------------------------------------------

test('risky diffs never produce a slim decision and always get full context', async () => {
  const riskyDiffs = [
    ['reviewer core', WATCHER_DIFF],
    ['auth', AUTH_DIFF],
    ['dependency manifest', LOCKFILE_DIFF],
  ];
  for (const [label, diff] of riskyDiffs) {
    const decision = decide(diff);
    assert.equal(decision.slim, false, `${label} must not be slim`);
    assert.equal(decision.mode, REVIEW_MODE.FULL, label);

    const { extraContext, calls } = await buildContext(decision, { diff });
    assert.equal(calls.linkedSpec, 1, `${label} must still fetch linked specs`);
    assert.equal(calls.hardening, 1, `${label} must still build hardening context`);
    assert.match(extraContext, /governing spec body/, label);
    assert.match(extraContext, /Hardening Ledger Context/, label);
    assert.doesNotMatch(extraContext, /Slim Context/, label);
  }
});

test('a low-risk file mixed with a risky one gets the full path', async () => {
  const decision = decide(`${DOCS_DIFF}${AUTH_DIFF}`);
  assert.equal(decision.slim, false);
  const { calls } = await buildContext(decision, { diff: `${DOCS_DIFF}${AUTH_DIFF}` });
  assert.deepEqual(calls, { linkedSpec: 1, hardening: 1 });
});

test('an operator-forced full review gets the full context path', async () => {
  const decision = decide(DOCS_DIFF, { labels: [FORCE_FULL_REVIEW_LABEL] });
  assert.equal(decision.mode, REVIEW_MODE.FORCED_FULL);
  const { extraContext, calls } = await buildContext(decision);
  assert.deepEqual(calls, { linkedSpec: 1, hardening: 1 });
  assert.doesNotMatch(extraContext, /Slim Context/);
});

test('a missing decision is treated as full, so an older caller loses nothing', async () => {
  for (const decision of [null, undefined, {}, { slim: false }]) {
    const { calls } = await buildContext(decision);
    assert.deepEqual(calls, { linkedSpec: 1, hardening: 1 }, JSON.stringify(decision));
  }
});

// ---------------------------------------------------------------------------
// selectReviewMode: the one call the reviewer makes.
// ---------------------------------------------------------------------------

function captureSelect({ diff = DOCS_DIFF, labels = [], env = {} } = {}) {
  const events = [];
  const records = [];
  const decision = selectReviewMode({
    rootDir: '/nonexistent-root',
    repo: 'laceyenterprises/agent-os',
    prNumber: 4242,
    diff,
    labels,
    author: { login: 'VirtualPaul' },
    headSha: 'abc123',
    attemptNumber: 2,
    reviewerModel: 'gemini',
    promptStage: 'first',
    env,
    logStructuredEventImpl: (_log, event) => events.push(event),
    recordReviewModeSelectedImpl: (args) => { records.push(args); return { recorded: true }; },
    log: SILENT_LOG,
  });
  return { decision, events, records };
}

test('selectReviewMode logs the decision and forwards it to the durable record', () => {
  const { decision, events, records } = captureSelect();
  assert.equal(decision.mode, REVIEW_MODE.SLIM);

  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'review-mode-selection');
  assert.equal(events[0].mode, REVIEW_MODE.SLIM);
  assert.equal(events[0].promptStage, 'first');
  assert.equal(events[0].changedFiles, 1);
  assert.deepEqual(events[0].lowRiskClasses, ['docs']);

  assert.equal(records.length, 1);
  assert.equal(records[0].headSha, 'abc123');
  assert.equal(records[0].attemptNumber, 2);
  assert.equal(records[0].reviewerModel, 'gemini');
  assert.equal(records[0].decision, decision);
});

test('selectReviewMode reports the refusal list for a risky diff', () => {
  const { decision, events } = captureSelect({ diff: WATCHER_DIFF });
  assert.equal(decision.mode, REVIEW_MODE.FULL);
  assert.ok(events[0].refusals.some((item) => item.startsWith('gate-keeper-path')));
});

test('selectReviewMode honours the kill switch from its own env argument', () => {
  const { decision } = captureSelect({ env: { [SLIM_REVIEW_ENABLED_ENV]: '0' } });
  assert.equal(decision.mode, REVIEW_MODE.FULL);
  assert.deepEqual(decision.refusals.map((item) => item.code), ['slim-mode-disabled']);
});

test('selectReviewMode works with no logger seam supplied', () => {
  // `reviewer.mjs` passes one, but a caller that does not must not crash: this
  // runs before the review and a throw here would cost the PR its gate.
  assert.doesNotThrow(() => selectReviewMode({
    rootDir: '/nonexistent-root',
    repo: 'laceyenterprises/agent-os',
    prNumber: 1,
    diff: DOCS_DIFF,
    env: {},
    recordReviewModeSelectedImpl: () => ({ recorded: false }),
    log: SILENT_LOG,
  }));
});

// ---------------------------------------------------------------------------
// Slim prompts stay policy-complete.
// ---------------------------------------------------------------------------

test('the reviewer stage prompt is byte-identical in slim and full mode', async () => {
  const promptPrefix = buildReviewerPromptPrefix({ stage: 'first' });
  const slim = await buildContext(decide(DOCS_DIFF));
  const full = await buildContext(null);

  const slimPrompt = buildReviewerPrompt({ promptPrefix, extraContext: slim.extraContext, diff: DOCS_DIFF });
  const fullPrompt = buildReviewerPrompt({ promptPrefix, extraContext: full.extraContext, diff: DOCS_DIFF });

  assert.ok(slimPrompt.startsWith(promptPrefix), 'slim prompt must open with the full stage prompt');
  assert.ok(fullPrompt.startsWith(promptPrefix), 'full prompt must open with the full stage prompt');
  assert.ok(promptPrefix.length > 0);
});

test('the slim prompt keeps the verdict contract and the diff', () => {
  const promptPrefix = buildReviewerPromptPrefix({ stage: 'first' });
  // Whatever the prompt set says about verdicts must survive slimming; assert
  // on the prompt's own vocabulary rather than a literal this test invents.
  for (const marker of ['Verdict', 'Blocking']) {
    assert.ok(promptPrefix.includes(marker), `stage prompt should mention ${marker}`);
  }
  const prompt = buildReviewerPrompt({
    promptPrefix,
    extraContext: '\n\n## Review Scope — Slim Context (RPL-08 low-risk fast lane)\n',
    diff: DOCS_DIFF,
  });
  for (const marker of ['Verdict', 'Blocking']) {
    assert.ok(prompt.includes(marker), `slim prompt should still mention ${marker}`);
  }
  assert.match(prompt, /Here is the PR diff to review/);
  assert.ok(prompt.includes('docs/GLOSSARY.md'));
});

// ---------------------------------------------------------------------------
// Posted review body.
// ---------------------------------------------------------------------------

const REVIEWER_METADATA = { displayName: 'Gemini', reviewerIdentity: 'gemini-reviewer-lacey' };

test('the mode block lands under the header without displacing the verdict', () => {
  const reviewText = [
    '## Adversarial Review — Gemini (gemini-reviewer-lacey)',
    '',
    '## Blocking issues',
    '',
    '- None.',
    '',
    '## Verdict',
    '',
    'Comment only',
    '',
  ].join('\n');

  const body = buildReviewCommentBody({
    reviewerMetadata: REVIEWER_METADATA,
    verdictMode: 'enforce',
    reviewModeAuditBlock: '> Review mode: **slim** (RPL-08 low-risk fast lane).\n\n',
    reviewText,
  });

  const lines = body.split('\n');
  assert.ok(lines[0].startsWith('## Adversarial Review'), 'header must stay on line 1');
  assert.ok(body.includes('> Review mode: **slim**'));
  // The parsers key on these headings; they must remain at `##` and in order.
  assert.ok(body.indexOf('## Blocking issues') < body.indexOf('## Verdict'));
  assert.ok(body.indexOf('> Review mode') < body.indexOf('## Blocking issues'));
});

test('waiver and mode blocks coexist without either being dropped', () => {
  const body = buildReviewCommentBody({
    reviewerMetadata: REVIEWER_METADATA,
    verdictMode: 'enforce',
    waiverAuditBlock: '> Cross-model review waiver: operator override.\n\n',
    reviewModeAuditBlock: '> Review mode: **slim** (RPL-08 low-risk fast lane).\n\n',
    reviewText: '## Verdict\n\nComment only\n',
  });
  assert.ok(body.includes('Cross-model review waiver'));
  assert.ok(body.includes('Review mode: **slim**'));
  assert.ok(body.indexOf('waiver') < body.indexOf('Review mode'));
});

test('an ordinary full review body is unchanged from before RPL-08', () => {
  const reviewText = '## Verdict\n\nComment only\n';
  const withEmptyMode = buildReviewCommentBody({
    reviewerMetadata: REVIEWER_METADATA,
    verdictMode: 'enforce',
    reviewModeAuditBlock: '',
    reviewText,
  });
  const withoutArgument = buildReviewCommentBody({
    reviewerMetadata: REVIEWER_METADATA,
    verdictMode: 'enforce',
    reviewText,
  });
  assert.equal(withEmptyMode, withoutArgument);
  assert.ok(withEmptyMode.startsWith('## Adversarial Review — Gemini (gemini-reviewer-lacey)'));
});

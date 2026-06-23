import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import classify, { parseReviewBody } from '../src/merge-agent-rescue-classifier.mjs';
import { createFollowUpJob, markFollowUpJobCompleted } from '../src/follow-up-jobs.mjs';
import {
  buildMergeAgentDispatchJob,
  pickMergeAgentDispatch,
} from '../src/follow-up-merge-agent.mjs';

const FIXTURE_DIR = new URL('./fixtures/review-bodies/', import.meta.url);
const HEAD_SHA = 'head-123';
const PASSING_CHECK = {
  name: 'unit-tests',
  conclusion: 'SUCCESS',
  commit: { oid: HEAD_SHA },
};

function fixture(name) {
  return readFileSync(new URL(name, FIXTURE_DIR), 'utf8');
}

function inputFor(name, overrides = {}) {
  return {
    reviewBody: fixture(name),
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    labels: [],
    statusCheckRollup: [PASSING_CHECK],
    headSha: HEAD_SHA,
    reviewHeadSha: HEAD_SHA,
    operatorApprovalHeadSha: null,
    operatorApprovalLabelEventId: null,
    operatorApprovalActor: null,
    operatorApprovalLabeledAt: null,
    ...overrides,
  };
}

function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value == null) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (previous == null) delete process.env[name];
    else process.env[name] = previous;
  }
}

const decisionFixtures = [
  ['comment-only-merge-eligible.md', 'merge-eligible'],
  ['approved-merge-eligible.md', 'merge-eligible'],
  ['approved-with-non-blocking-findings.md', 'merge-eligible'],
  ['formatted-verdict-and-none-variants.md', 'merge-eligible'],
  ['request-changes-non-blocking-only.md', 'remediation-eligible'],
  ['request-changes-with-blockers-addressable.md', 'remediation-eligible'],
  ['request-changes-with-blockers-auth.md', 'escalate-blockers'],
  ['request-changes-with-blockers-schema-migration.md', 'escalate-blockers'],
  ['comment-only-with-non-blocking-findings.md', 'inconclusive'],
  ['operator-approved-override.md', 'merge-eligible', {
    operatorApprovalHeadSha: HEAD_SHA,
    operatorApprovalLabelEventId: 'evt-operator-approved',
    operatorApprovalActor: 'VirtualPaul',
    operatorApprovalLabeledAt: '2026-06-23T12:00:00.000Z',
  }],
  ['stale-review.md', 'escalate-stale-review', { reviewHeadSha: 'older-head' }],
  ['malformed-no-verdict.md', 'inconclusive'],
  ['malformed-blocking-section-missing.md', 'inconclusive'],
  ['request-changes-blocker-missing-category.md', 'remediation-eligible'],
  ['none-with-trailing-prose.md', 'merge-eligible'],
];

for (const [name, expectedDecision, overrides] of decisionFixtures) {
  test(`classify fixture ${name} -> ${expectedDecision}`, () => {
    const result = classify(inputFor(name, overrides));
    assert.equal(result.decision, expectedDecision);
  });
}

test('operator-approved requires attributable current-head provenance', () => {
  const result = classify(inputFor('operator-approved-override.md', {
    operatorApprovalHeadSha: HEAD_SHA,
    operatorApprovalLabelEventId: 'evt-operator-approved',
    operatorApprovalActor: 'VirtualPaul',
    operatorApprovalLabeledAt: '2026-06-23T12:00:00.000Z',
  }));

  assert.equal(result.decision, 'merge-eligible');
  assert.equal(result.reason, 'operator-approved');
});

test('operator-approved persists across a same-head rereview', () => {
  const result = classify(inputFor('operator-approved-override.md', {
    reviewHeadSha: HEAD_SHA,
    operatorApprovalHeadSha: HEAD_SHA,
    operatorApprovalLabelEventId: 'evt-operator-approved',
    operatorApprovalActor: 'VirtualPaul',
    operatorApprovalLabeledAt: '2026-06-23T12:00:00.000Z',
  }));

  assert.equal(result.decision, 'merge-eligible');
});

test('operator-approved accepts explicit empty check rollup', () => {
  const result = classify(inputFor('operator-approved-override.md', {
    statusCheckRollup: [],
    operatorApprovalHeadSha: HEAD_SHA,
    operatorApprovalLabelEventId: 'evt-operator-approved',
    operatorApprovalActor: 'VirtualPaul',
    operatorApprovalLabeledAt: '2026-06-23T12:00:00.000Z',
  }));

  assert.equal(result.decision, 'merge-eligible');
  assert.equal(result.reason, 'operator-approved');
});

test('operator-approved stale-head approval is ignored', () => {
  const result = classify(inputFor('operator-approved-override.md', {
    operatorApprovalHeadSha: 'older-head',
    operatorApprovalLabelEventId: 'evt-operator-approved',
    operatorApprovalActor: 'VirtualPaul',
    operatorApprovalLabeledAt: '2026-06-23T12:00:00.000Z',
  }));

  assert.equal(result.decision, 'remediation-eligible');
});

test('stale review escalates before normal verdict routing', () => {
  const result = classify(inputFor('stale-review.md', { reviewHeadSha: 'older-head' }));

  assert.equal(result.decision, 'escalate-stale-review');
});

test('malformed reviews are inconclusive', () => {
  assert.equal(classify(inputFor('malformed-no-verdict.md')).decision, 'inconclusive');
  assert.equal(classify(inputFor('malformed-blocking-section-missing.md')).decision, 'inconclusive');
});

test('blocking finding without category remains remediation eligible', () => {
  const result = classify(inputFor('request-changes-blocker-missing-category.md'));

  assert.equal(result.decision, 'remediation-eligible');
  assert.equal(result.parsedFindings[0].category, null);
});

test('None sentinel tolerates trailing prose on the same line', () => {
  const result = classify(inputFor('none-with-trailing-prose.md'));

  assert.equal(result.decision, 'merge-eligible');
  assert.equal(result.blockingFindings, 0);
  assert.equal(result.nonBlockingFindings, 0);
});

test('Approved reviews ignore non-blocking findings for merge eligibility', () => {
  const result = classify(inputFor('approved-with-non-blocking-findings.md'));

  assert.equal(result.decision, 'merge-eligible');
  assert.equal(result.reason, 'clean-review');
  assert.equal(result.blockingFindings, 0);
  assert.equal(result.nonBlockingFindings, 1);
});

test('lowercase approved verdict is accepted for merge eligibility', () => {
  const reviewBody = fixture('approved-merge-eligible.md').replace('Approved', 'approved');
  const result = classify(inputFor('approved-merge-eligible.md', { reviewBody }));

  assert.equal(parseReviewBody(reviewBody).verdict, 'Approved');
  assert.equal(result.decision, 'merge-eligible');
  assert.equal(result.reason, 'clean-review');
});

test('formatted verdicts and none sentinel variants are accepted', () => {
  const result = classify(inputFor('formatted-verdict-and-none-variants.md'));

  assert.equal(result.decision, 'merge-eligible');
  assert.equal(result.blockingFindings, 0);
  assert.equal(result.nonBlockingFindings, 0);
});

test('check rollup ignores stale rows and the adversarial gate context', () => {
  const result = classify(inputFor('comment-only-merge-eligible.md', {
    statusCheckRollup: [
      { context: 'agent-os/adversarial-gate', state: 'FAILURE', commit: { oid: HEAD_SHA } },
      { name: 'old-tests', conclusion: 'FAILURE', commit: { oid: 'older-head' } },
      PASSING_CHECK,
    ],
  }));

  assert.equal(result.decision, 'merge-eligible');
});

test('check rollup ignores adversarial gate CheckRun names and custom gate contexts', () => {
  const withDefaultGateName = classify(inputFor('comment-only-merge-eligible.md', {
    statusCheckRollup: [
      { name: 'agent-os/adversarial-gate', status: 'IN_PROGRESS', commit: { oid: HEAD_SHA } },
    ],
  }));
  assert.equal(withDefaultGateName.decision, 'merge-eligible');

  const withCustomGateName = withEnv('ADV_GATE_STATUS_CONTEXT', 'agent-os/custom-gate', () => (
    classify(inputFor('comment-only-merge-eligible.md', {
      statusCheckRollup: [
        { name: 'agent-os/custom-gate', status: 'IN_PROGRESS', commit: { oid: HEAD_SHA } },
      ],
    }))
  ));
  assert.equal(withCustomGateName.decision, 'merge-eligible');
});

test('completed check-run status without success conclusion is not passing', () => {
  const result = classify(inputFor('comment-only-merge-eligible.md', {
    statusCheckRollup: [
      { name: 'unit-tests', status: 'COMPLETED', commit: { oid: HEAD_SHA } },
    ],
  }));

  assert.equal(result.decision, 'inconclusive');
});

test('explicit empty check rollup is merge eligible but missing rollup fails closed', () => {
  assert.equal(
    classify(inputFor('comment-only-merge-eligible.md', { statusCheckRollup: [] })).decision,
    'merge-eligible',
  );
  assert.equal(
    classify(inputFor('comment-only-merge-eligible.md', { statusCheckRollup: undefined })).decision,
    'inconclusive',
  );
});

test('raw GitHub label objects are normalized before hard-stop checks', () => {
  const result = classify(inputFor('comment-only-merge-eligible.md', {
    labels: [{ name: 'merge-agent-stuck' }],
  }));

  assert.equal(result.decision, 'inconclusive');
});

test('section extraction ignores headings inside fenced code blocks', () => {
  const reviewBody = `
## Blocking issues
- **Fence contains heading text**
  - **Category:** correctness
  - **File:** \`README.md\`
  - **Problem:** Example:
    \`\`\`
    ## Non-blocking issues
    not a real heading
    \`\`\`
  - **Recommended fix:** Keep reading the blocking section.

## Non-blocking issues
- None.

## Verdict
Request changes
`;
  const parsed = parseReviewBody(reviewBody);

  assert.equal(parsed.blocking.count, 1);
  assert.equal(parsed.nonBlocking.count, 0);
  assert.match(parsed.parsedFindings[0].problem, /not a real heading/);
});

test('verdict parser returns the first valid verdict line', () => {
  const reviewBody = `
## Blocking issues
- None.

## Non-blocking issues
- None.

## Verdict
Approved
Request changes
`;

  assert.equal(parseReviewBody(reviewBody).verdict, 'Approved');
});

test('parsed findings expose normalized category and structured fields', () => {
  const parsed = parseReviewBody(fixture('request-changes-with-blockers-addressable.md'));

  assert.equal(parsed.blocking.count, 2);
  assert.equal(parsed.parsedFindings[0].title, 'Normalize stale-review routing');
  assert.equal(parsed.parsedFindings[0].category, 'correctness');
  assert.equal(parsed.parsedFindings[0].file, '`src/merge-agent-rescue-classifier.mjs`');
  assert.equal(parsed.parsedFindings[0].whyItMatters, null);
  assert.equal(parsed.parsedFindings[0].recommendedFix, 'Check `reviewHeadSha` against `headSha` before any merge/remediation routing.');
});

test('nested field parser does not stop at unknown bold sub-bullets', () => {
  const parsed = parseReviewBody(`
## Blocking issues
- **Preserve diagnostic shape**
  - **Category:** correctness
  - **File:** \`src/merge-agent-rescue-classifier.mjs\`
  - **Problem:** The parser keeps the first line.
    - **Note:** This note should remain part of the problem field.
    The continuation should remain too.
  - **Recommended fix:** Restrict boundaries to known structured fields.

## Non-blocking issues
- None.

## Verdict
Request changes
`);

  assert.match(parsed.parsedFindings[0].problem, /Note:/);
  assert.match(parsed.parsedFindings[0].problem, /continuation should remain/);
  assert.equal(parsed.parsedFindings[0].recommendedFix, 'Restrict boundaries to known structured fields.');
});

test('parsed findings retain why-it-matters field when present', () => {
  const parsed = parseReviewBody(`
## Blocking issues
- **Preserve diagnostic shape**
  - **File:** \`src/merge-agent-rescue-classifier.mjs\`
  - **Problem:** The parser drops fields.
  - **Why it matters:** Downstream diagnostics lose reviewer context.
  - **Recommended fix:** Preserve the canonical fields.

## Non-blocking issues
- None.

## Verdict
Request changes
`);

  assert.equal(parsed.parsedFindings[0].title, 'Preserve diagnostic shape');
  assert.equal(parsed.parsedFindings[0].whyItMatters, 'Downstream diagnostics lose reviewer context.');
});

test('parsed findings retain multi-line nested fields', () => {
  const parsed = parseReviewBody(fixture('request-changes-multiline-field.md'));

  assert.equal(parsed.blocking.count, 1);
  assert.equal(
    parsed.parsedFindings[0].problem,
    'The first sentence is on the label line.\nThe second sentence is wrapped onto the next indented line.\n\nThe third sentence starts a new paragraph.',
  );
  assert.equal(
    parsed.parsedFindings[0].recommendedFix,
    'Accumulate indented continuation lines until the next nested field.',
  );
});

test('watcher smoke: merge-eligible fixture still dispatches', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  try {
    const { jobPath } = createFollowUpJob({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 2201,
      reviewerModel: 'codex',
      linearTicketId: null,
      revisionRef: HEAD_SHA,
      reviewBody: fixture('comment-only-merge-eligible.md'),
      reviewPostedAt: '2026-06-23T12:00:00.000Z',
      critical: false,
    });
    markFollowUpJobCompleted({
      rootDir,
      jobPath,
      completedAt: '2026-06-23T12:05:00.000Z',
      reReview: { requested: false, reason: 'Review settled.' },
    });

    const job = buildMergeAgentDispatchJob(rootDir, {
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 2201,
      branch: 'feature/mar-e2n-clean',
      baseBranch: 'main',
      headSha: HEAD_SHA,
      mergeable: 'MERGEABLE',
      checksConclusion: 'SUCCESS',
      statusCheckRollup: [PASSING_CHECK],
      labels: [],
      operatorNotes: null,
      prState: 'open',
      merged: false,
    });

    assert.equal(job.lastVerdict, 'Comment only');
    assert.equal(job.mergeAgentRescueDecision, 'merge-eligible');
    assert.equal(job.mergeAgentRescueReason, 'clean-review');
    assert.equal(job.blockingFindingCount, 0);
    assert.equal(job.blockingFindingState, 'known');
    assert.equal(job.nonBlockingFindingCount, 0);
    assert.equal(job.nonBlockingFindingState, 'known');
    assert.equal(pickMergeAgentDispatch(job), 'dispatch');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('watcher smoke: remediation-eligible fixture still waits while budget remains', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  try {
    const { jobPath } = createFollowUpJob({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 2202,
      reviewerModel: 'codex',
      linearTicketId: null,
      revisionRef: HEAD_SHA,
      reviewBody: fixture('request-changes-with-blockers-addressable.md'),
      reviewPostedAt: '2026-06-23T12:00:00.000Z',
      critical: false,
    });
    markFollowUpJobCompleted({
      rootDir,
      jobPath,
      completedAt: '2026-06-23T12:05:00.000Z',
      reReview: { requested: true, reason: 'Ready for re-review.' },
    });

    const job = buildMergeAgentDispatchJob(rootDir, {
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 2202,
      branch: 'feature/mar-e2n-remediate',
      baseBranch: 'main',
      headSha: HEAD_SHA,
      mergeable: 'MERGEABLE',
      checksConclusion: 'SUCCESS',
      statusCheckRollup: [PASSING_CHECK],
      labels: [],
      operatorNotes: null,
      prState: 'open',
      merged: false,
    });

    assert.equal(job.lastVerdict, 'Request changes');
    assert.equal(job.mergeAgentRescueDecision, 'remediation-eligible');
    assert.equal(job.mergeAgentRescueReason, 'addressable-findings');
    assert.equal(job.blockingFindingCount, 2);
    assert.equal(job.blockingFindingState, 'known');
    assert.equal(job.nonBlockingFindingCount, 0);
    assert.equal(job.nonBlockingFindingState, 'known');
    assert.equal(pickMergeAgentDispatch(job), 'skip-remediation-claimable');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

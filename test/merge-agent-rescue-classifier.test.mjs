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
  ['approved-with-non-blocking-findings.md', 'remediation-eligible'],
  ['formatted-verdict-and-none-variants.md', 'merge-eligible'],
  ['request-changes-non-blocking-only.md', 'remediation-eligible'],
  ['request-changes-with-blockers-addressable.md', 'remediation-eligible'],
  ['request-changes-with-blockers-auth.md', 'escalate-blockers'],
  ['request-changes-with-blockers-schema-migration.md', 'escalate-blockers'],
  ['comment-only-with-non-blocking-findings.md', 'remediation-eligible'],
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


test('parsed review body exposes the reconciled effective verdict', () => {
  const reviewBody = `
## Blocking issues
- None.

## Non-blocking issues
- None.

## Verdict
Approved
Request changes
`;

  assert.equal(parseReviewBody(reviewBody).verdict, 'Comment only');
});

test('parsed findings expose normalized category and structured fields', () => {
  const parsed = parseReviewBody(fixture('request-changes-with-blockers-addressable.md'));

  assert.equal(parsed.blocking.count, 2);
  assert.equal(parsed.parsedFindings[0].title, undefined);
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

  assert.equal(parsed.parsedFindings[0].title, undefined);
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
    const { jobPath } = createFollowUpJob({ branch: 'fixture/remediation',
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
    assert.equal(job.mergeAgentRescueDecision, 'wait-closer');
    assert.equal(job.mergeAgentRescueReason, 'ownership-unreadable');
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
    const { jobPath } = createFollowUpJob({ branch: 'fixture/remediation',
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
    assert.equal(job.mergeAgentRescueDecision, 'wait-closer');
    assert.equal(job.mergeAgentRescueReason, 'ownership-unreadable');
    assert.equal(job.blockingFindingCount, 2);
    assert.equal(job.blockingFindingState, 'known');
    assert.equal(job.nonBlockingFindingCount, 0);
    assert.equal(job.nonBlockingFindingState, 'known');
    assert.equal(pickMergeAgentDispatch(job), 'skip-remediation-claimable');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

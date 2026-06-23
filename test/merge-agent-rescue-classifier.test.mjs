import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import classify from '../src/merge-agent-rescue-classifier.mjs';
import {
  FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER,
  buildMergeAgentDispatchJob,
  pickMergeAgentDispatchDetail,
} from '../src/follow-up-merge-agent.mjs';
import { createFollowUpJob, markFollowUpJobCompleted } from '../src/follow-up-jobs.mjs';

const FIXTURE_DIR = path.join(import.meta.dirname, 'fixtures', 'review-bodies');
const HEAD_SHA = 'head-current';
const PASSING_CHECKS = [
  { name: 'agent-os/adversarial-gate', conclusion: 'FAILURE' },
  { name: 'unit-tests', conclusion: 'SUCCESS' },
];

function fixture(name) {
  return readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

function baseInput(name, overrides = {}) {
  return {
    reviewBody: fixture(name),
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    labels: [],
    statusCheckRollup: PASSING_CHECKS,
    headSha: HEAD_SHA,
    reviewHeadSha: HEAD_SHA,
    operatorApprovalHeadSha: null,
    operatorApprovalLabelEventId: null,
    operatorApprovalActor: null,
    operatorApprovalLabeledAt: null,
    ...overrides,
  };
}

const fixtureCases = [
  ['comment-only-merge-eligible.md', 'merge-eligible'],
  ['approved-merge-eligible.md', 'merge-eligible'],
  ['request-changes-non-blocking-only.md', 'remediation-eligible'],
  ['request-changes-with-blockers-addressable.md', 'remediation-eligible'],
  ['request-changes-with-blockers-auth.md', 'escalate-blockers'],
  ['request-changes-with-blockers-schema-migration.md', 'escalate-blockers'],
  ['comment-only-with-non-blocking-findings.md', 'inconclusive'],
  ['operator-approved-override.md', 'merge-eligible', {
    operatorApprovalHeadSha: HEAD_SHA,
    operatorApprovalLabelEventId: 'LE_operator_approval',
    operatorApprovalActor: 'VirtualPaul',
    operatorApprovalLabeledAt: '2026-06-23T12:00:00.000Z',
  }],
  ['stale-review.md', 'escalate-stale-review', { reviewHeadSha: 'old-reviewed-head' }],
  ['malformed-no-verdict.md', 'inconclusive'],
  ['malformed-blocking-section-missing.md', 'inconclusive'],
  ['request-changes-blocker-missing-category.md', 'remediation-eligible'],
  ['none-with-trailing-prose.md', 'merge-eligible'],
];

for (const [name, expectedDecision, overrides = {}] of fixtureCases) {
  test(`classify fixture ${name} as ${expectedDecision}`, () => {
    assert.equal(classify(baseInput(name, overrides)).decision, expectedDecision);
  });
}

test('operator-approved requires attributable current-head provenance', () => {
  const result = classify(baseInput('operator-approved-override.md', {
    operatorApprovalHeadSha: HEAD_SHA,
    operatorApprovalLabelEventId: 'LE_operator_approval',
    operatorApprovalActor: 'VirtualPaul',
    operatorApprovalLabeledAt: '2026-06-23T12:00:00.000Z',
  }));

  assert.equal(result.decision, 'merge-eligible');
  assert.equal(result.reason, 'operator-approved-current-head');
});

test('operator-approved persists across same-head re-review', () => {
  const result = classify(baseInput('request-changes-with-blockers-auth.md', {
    reviewHeadSha: HEAD_SHA,
    operatorApprovalHeadSha: HEAD_SHA,
    operatorApprovalLabelEventId: 'LE_operator_approval',
    operatorApprovalActor: 'VirtualPaul',
    operatorApprovalLabeledAt: '2026-06-23T12:00:00.000Z',
  }));

  assert.equal(result.decision, 'merge-eligible');
});

test('operator-approved stale-head approval is ignored', () => {
  const result = classify(baseInput('operator-approved-override.md', {
    operatorApprovalHeadSha: 'old-approved-head',
    operatorApprovalLabelEventId: 'LE_operator_approval',
    operatorApprovalActor: 'VirtualPaul',
    operatorApprovalLabeledAt: '2026-06-23T12:00:00.000Z',
  }));

  assert.equal(result.decision, 'remediation-eligible');
});

test('stale review escalates before clean merge eligibility', () => {
  assert.equal(
    classify(baseInput('stale-review.md', { reviewHeadSha: 'old-reviewed-head' })).decision,
    'escalate-stale-review',
  );
});

test('malformed review bodies fail closed as inconclusive', () => {
  assert.equal(classify(baseInput('malformed-no-verdict.md')).decision, 'inconclusive');
  assert.equal(classify(baseInput('malformed-blocking-section-missing.md')).decision, 'inconclusive');
});

test('blocking finding without category remains remediation-eligible', () => {
  const result = classify(baseInput('request-changes-blocker-missing-category.md'));

  assert.equal(result.decision, 'remediation-eligible');
  assert.equal(result.parsedFindings[0].category, null);
});

test('None sentinel tolerates trailing prose on the same bullet line', () => {
  const result = classify(baseInput('none-with-trailing-prose.md'));

  assert.equal(result.blockingFindings, 0);
  assert.equal(result.nonBlockingFindings, 0);
  assert.equal(result.decision, 'merge-eligible');
});

test('verdict parser accepts common markdown bullets, bolding, and casing', () => {
  const result = classify({
    ...baseInput('comment-only-merge-eligible.md'),
    reviewBody: [
      '## Summary',
      'Clean.',
      '',
      '## Blocking issues',
      '- None',
      '',
      '## Non-blocking issues',
      '- none.',
      '',
      '## Verdict',
      '- **comment only**',
    ].join('\n'),
  });

  assert.equal(result.verdict, 'Comment only');
  assert.equal(result.blockingFindings, 0);
  assert.equal(result.nonBlockingFindings, 0);
  assert.equal(result.decision, 'merge-eligible');
});

test('None sentinel accepts missing period and lowercase variants', () => {
  const result = classify({
    ...baseInput('comment-only-merge-eligible.md'),
    reviewBody: [
      '## Summary',
      'Clean.',
      '',
      '## Blocking issues',
      '- None',
      '',
      '## Non-blocking issues',
      '- none',
      '',
      '## Verdict',
      'Comment only',
    ].join('\n'),
  });

  assert.equal(result.blockingFindings, 0);
  assert.equal(result.nonBlockingFindings, 0);
  assert.equal(result.decision, 'merge-eligible');
});

test('status check evaluation trusts current-head rollup rows without commit OIDs', () => {
  const result = classify(baseInput('comment-only-merge-eligible.md', {
    statusCheckRollup: [
      { name: 'agent-os/adversarial-gate', conclusion: 'FAILURE' },
      { name: 'unit-tests', conclusion: 'SUCCESS' },
    ],
  }));

  assert.equal(result.decision, 'merge-eligible');
});

test('status check evaluation does not silently drop rows with mismatched commit OIDs', () => {
  const result = classify(baseInput('comment-only-merge-eligible.md', {
    statusCheckRollup: [
      { name: 'unit-tests', conclusion: 'SUCCESS', commit: { oid: HEAD_SHA } },
      { name: 'integration-tests', conclusion: 'FAILURE', commit: { oid: 'old-head' } },
    ],
  }));

  assert.equal(result.decision, 'inconclusive');
  assert.equal(result.reason, 'no-decision-rule-matched');
});

test('watcher smoke: merge-eligible fixture routes to dispatch with clean parsed counts', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-classifier-'));
  const created = createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 7001,
    reviewerModel: 'codex',
    linearTicketId: null,
    revisionRef: HEAD_SHA,
    reviewBody: fixture('comment-only-merge-eligible.md'),
    reviewPostedAt: '2026-06-23T12:00:00.000Z',
    critical: false,
  });
  markFollowUpJobCompleted({
    rootDir,
    jobPath: created.jobPath,
    completedAt: '2026-06-23T12:01:00.000Z',
    completion: { preview: 'done' },
  });
  const job = buildMergeAgentDispatchJob(rootDir, {
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 7001,
    branch: 'codex/mar-e2n',
    baseBranch: 'main',
    headSha: HEAD_SHA,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    checksConclusion: 'SUCCESS',
    statusCheckRollup: PASSING_CHECKS,
    labels: [],
    operatorNotes: null,
    prState: 'open',
    merged: false,
  });

  assert.equal(job.lastVerdict, 'Comment only');
  assert.equal(job.blockingFindingCount, 0);
  assert.equal(job.mergeAgentRescueDecision, 'merge-eligible');
  assert.equal(job.mergeAgentRescueReason, 'clean-review-and-passing-gates');
  assert.equal(pickMergeAgentDispatchDetail(job).decision, 'dispatch');
});

test('watcher smoke: classifier stale-review decision blocks dispatch', () => {
  const detail = pickMergeAgentDispatchDetail({
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 7003,
    headSha: HEAD_SHA,
    lastVerdict: 'Comment only',
    mergeable: 'MERGEABLE',
    checksConclusion: 'SUCCESS',
    labels: [],
    prState: 'open',
    merged: false,
    latestFollowUpJobStatus: 'completed',
    remediationCurrentRound: 2,
    remediationMaxRounds: 2,
    blockingFindingCount: 0,
    blockingFindingState: 'known',
    operatorApproval: null,
    mergeAgentRescueDecision: 'escalate-stale-review',
    mergeAgentRescueReason: 'review-head-sha-does-not-match-head-sha',
  });

  assert.equal(detail.decision, 'skip-stale-review');
  assert.equal(detail.classifierReason, 'review-head-sha-does-not-match-head-sha');
});

test('watcher smoke: classifier unaddressable-blocker decision blocks dispatch', () => {
  const detail = pickMergeAgentDispatchDetail({
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 7004,
    headSha: HEAD_SHA,
    lastVerdict: 'Request changes',
    mergeable: 'MERGEABLE',
    checksConclusion: 'SUCCESS',
    labels: [],
    prState: 'open',
    merged: false,
    latestFollowUpJobStatus: 'completed',
    remediationCurrentRound: 2,
    remediationMaxRounds: 2,
    blockingFindingCount: 1,
    blockingFindingState: 'known',
    operatorApproval: null,
    mergeAgentRescueDecision: 'escalate-blockers',
    mergeAgentRescueReason: 'unaddressable-blocking-finding',
  }, {
    finalPassOnRequestChangesEnabled: true,
  });

  assert.equal(detail.decision, 'skip-blockers-present');
  assert.equal(detail.handoffRequired, true);
  assert.equal(detail.classifierReason, 'unaddressable-blocking-finding');
});

test('watcher smoke: remediation-eligible fixture routes through budget-exhausted request-changes dispatch', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-classifier-'));
  const created = createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 7002,
    reviewerModel: 'codex',
    linearTicketId: null,
    revisionRef: HEAD_SHA,
    reviewBody: fixture('request-changes-non-blocking-only.md'),
    reviewPostedAt: '2026-06-23T12:00:00.000Z',
    critical: false,
    priorCompletedRounds: 2,
  });
  markFollowUpJobCompleted({
    rootDir,
    jobPath: created.jobPath,
    completedAt: '2026-06-23T12:01:00.000Z',
    completion: { preview: 'done' },
  });
  const job = buildMergeAgentDispatchJob(rootDir, {
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 7002,
    branch: 'codex/mar-e2n',
    baseBranch: 'main',
    headSha: HEAD_SHA,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    checksConclusion: 'SUCCESS',
    statusCheckRollup: PASSING_CHECKS,
    labels: [],
    operatorNotes: null,
    prState: 'open',
    merged: false,
  });
  const decision = pickMergeAgentDispatchDetail(job, { finalPassOnRequestChangesEnabled: true });

  assert.equal(job.lastVerdict, 'Request changes');
  assert.equal(job.blockingFindingCount, 0);
  assert.equal(decision.decision, 'dispatch');
  assert.equal(decision.trigger, FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER);
});

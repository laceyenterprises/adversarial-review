import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveDomainPipeline } from '../src/domain-pipeline.mjs';
import { runReviewPipeline } from '../src/review-pipeline-driver.mjs';
import { createGitHubPRCommentsAdapter } from '../src/adapters/comms/github-pr-comments/index.mjs';

// e2e: drive the two-stage pipeline and deliver the Win 2 rollup through the
// REAL github-pr-comments adapter (with a stub octokit), then assert the posted
// comment body and the persisted delivery record — proving the rollup travels
// the same comms path + dedupe machinery as a v1 review comment.

const REGISTRY = {
  roles: {
    'code-quality-reviewer': { id: 'code-quality-reviewer', promptSet: 'code-pr', workerClass: 'codex', taskKind: 'review', completionShape: 'decision-only' },
    'security-reviewer': { id: 'security-reviewer', promptSet: 'code-pr-security', workerClass: 'codex', taskKind: 'review', completionShape: 'decision-only' },
  },
  routing: { neverReviewOwnBuilderClass: true },
};

const CONFIG = {
  id: 'code-pr',
  riskClasses: { low: { maxRemediationRounds: 1 }, medium: { maxRemediationRounds: 2 }, high: { maxRemediationRounds: 3 }, critical: { maxRemediationRounds: 4 } },
  pipeline: {
    enabled: true,
    stages: [
      { id: 'code-quality', panel: ['code-quality-reviewer'], aggregation: { kind: 'unanimous-clean' } },
      { id: 'security', panel: ['security-reviewer'], aggregation: { kind: 'unanimous-clean' } },
    ],
  },
};

const REPO = 'laceyenterprises/demo';
const PR = 42;
const SUBJECT = `${REPO}#${PR}`;
const REV = 'abc1234def';

function makeCommentsOctokit(calls) {
  return {
    rest: {
      issues: {
        async createComment(payload) {
          calls.push(payload);
          return { data: { id: calls.length, html_url: `https://github.test/c/${calls.length}` } };
        },
      },
    },
  };
}

test('two-stage pipeline posts the rollup through the github-pr-comments adapter and records the delivery', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'arc13-rollup-e2e-'));
  const calls = [];
  const comms = createGitHubPRCommentsAdapter({ rootDir, octokit: makeCommentsOctokit(calls), now: () => new Date('2026-07-17T00:00:00.000Z') });

  const resolved = resolveDomainPipeline(CONFIG, { roleRegistry: REGISTRY });
  const rollupKey = { domainId: 'code-pr', subjectExternalId: SUBJECT, revisionRef: REV, round: 1, kind: 'pipeline-rollup' };

  const res = await runReviewPipeline({
    resolvedPipeline: resolved,
    currentRevisionRef: REV,
    riskClass: 'high',
    observedAt: '2026-07-17T00:00:00.000Z',
    runStageReview: async ({ stage }) => (stage.id === 'code-quality'
      ? { kind: 'comment-only', body: 'cq clean' }
      : { kind: 'request-changes', body: 'sec bad', blockingFindings: [{ problem: 'a' }, { problem: 'b' }] }),
    postRollup: async ({ body }) => comms.postPipelineRollup({ body }, rollupKey),
  });

  // Delivered exactly one comment: the aggregate rollup.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].issue_number, PR);
  assert.match(calls[0].body, /## Adversarial review — pipeline rollup \(rev abc1234\)/);
  assert.match(calls[0].body, /pipeline: BLOCKED at security — 2 blocking findings routed to remediation/);
  assert.equal(res.disposition, 'blocking');

  // The delivery is persisted under the review kind, keyed per revision + round.
  const deliveries = await comms.loadPriorDeliveriesForSubject(rollupKey);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].delivered, true);

  // Re-posting the same rollup dedupes to the recorded delivery (no 2nd comment).
  await comms.postPipelineRollup({ body: res.rollupBody }, rollupKey);
  assert.equal(calls.length, 1, 'rollup delivery is idempotent per revision + round');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePostedReviewRow } from '../src/watcher.mjs';

test('posted scope-violation finding suppresses automated merge-agent dispatch', async () => {
  let projected = false;
  let fetchedCandidate = false;
  let dispatched = false;
  const logs = [];

  await handlePostedReviewRow({
    rootDir: '/tmp/adversarial-review-test',
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber: 57,
    existing: { repo: 'laceyenterprises/adversarial-review', pr_number: 57, review_status: 'posted' },
    currentRevisionRef: 'head-57',
    labelNames: [],
    projectGateStatusSafe: async () => {
      projected = true;
    },
    latestFollowUpJobFinder: () => ({
      job: {
        reviewBody: [
          '## Scope Violation Finding',
          '```json',
          '{"kind":"scope-violation","severity":"high"}',
          '```',
        ].join('\n'),
      },
    }),
    fetchMergeAgentCandidateImpl: async () => {
      fetchedCandidate = true;
      return null;
    },
    dispatchMergeAgentForPRImpl: async () => {
      dispatched = true;
      return { decision: 'dispatch' };
    },
    logger: {
      log: (message) => logs.push(message),
      error: (message) => logs.push(message),
    },
  });

  assert.equal(projected, true);
  assert.equal(fetchedCandidate, false);
  assert.equal(dispatched, false);
  assert.match(logs.join('\n'), /scope-violation finding present/);
});

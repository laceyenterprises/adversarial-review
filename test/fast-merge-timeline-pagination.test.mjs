import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchFastMergeAuthorizationFromTimeline } from '../src/adapters/subject/github-pr/fast-merge.mjs';

test('fast-merge timeline authorization fails closed when the bounded final page is full', async () => {
  const calls = [];
  const octokit = {
    rest: {
      issues: {
        listEventsForTimeline: async ({ page }) => {
          calls.push(page);
          return {
            data: Array.from({ length: 100 }, (_, index) => ({
              id: `${page}-${index}`,
              event: page === 1 && index === 0 ? 'labeled' : 'commented',
              label: page === 1 && index === 0 ? { name: 'fast-merge' } : undefined,
            })),
          };
        },
      },
    },
  };
  const warnings = [];

  const authorization = await fetchFastMergeAuthorizationFromTimeline(octokit, {
    owner: 'acme',
    repo: 'repo',
    prNumber: 987654321,
    allowedLabelNames: ['fast-merge'],
    liveHeadSha: 'live-head',
    logger: { warn: (message) => warnings.push(message) },
  });

  assert.equal(authorization, null);
  assert.deepEqual(calls, [1, 2, 3]);
  assert.match(warnings.at(-1), /timeline truncated/);
});

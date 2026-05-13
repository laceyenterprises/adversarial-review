import test from 'node:test';
import assert from 'node:assert/strict';

import { createCompositeOperatorSurface } from '../../src/adapters/operator/index.mjs';

<<<<<<< HEAD
=======
<<<<<<< HEAD
test('composite operator surface exposes controls and triage sync methods', () => {
  const surface = createCompositeOperatorSurface({
    controls: {
      fetchLatestLabelEventImpl: async () => null,
      execFileImpl: async () => ({ stdout: '{}' }),
    },
    triage: {
      linearClientProvider: async () => null,
=======
>>>>>>> 1fc0304a213929e5aba65ec63b39fbf38a0d62aa
test('composite operator surface forwards controls and triage calls through the right adapters', async () => {
  const labelCalls = [];
  const linearCalls = [];
  const surface = createCompositeOperatorSurface({
    controls: {
      fetchLatestLabelEventImpl: async (repo, prNumber, labelName, { execFileImpl }) => {
        labelCalls.push({ repo, prNumber, labelName, execFileImpl });
        return labelName === 'operator-approved'
          ? {
              id: `${labelName}-1`,
              label: labelName,
              actor: 'paul',
              createdAt: '2026-05-11T12:00:00.000Z',
              headSha: 'sha-1',
            }
          : null;
      },
      execFileImpl: async () => ({ stdout: '{}' }),
    },
    triage: {
      linearClientProvider: async () => ({
        issue: async (ticketId) => {
          linearCalls.push({ type: 'issue', ticketId });
          return {
            id: 'issue-1',
            team: Promise.resolve({
              states: async () => ({ nodes: [{ id: 'state-done', name: 'Done' }] }),
            }),
            state: Promise.resolve({ name: 'Todo' }),
          };
        },
        updateIssue: async (issueId, payload) => {
          linearCalls.push({ type: 'updateIssue', issueId, payload });
        },
        createComment: async (payload) => {
          linearCalls.push({ type: 'createComment', payload });
        },
      }),
<<<<<<< HEAD
=======
>>>>>>> 986782eb62007568c81e2e2b6f40d86a55492f85
>>>>>>> 1fc0304a213929e5aba65ec63b39fbf38a0d62aa
      logger: {},
    },
  });

<<<<<<< HEAD
=======
<<<<<<< HEAD
  assert.equal(typeof surface.observeOverrides, 'function');
  assert.equal(typeof surface.observeOperatorApproved, 'function');
  assert.equal(typeof surface.observeMergeAgentOverride, 'function');
  assert.equal(typeof surface.syncTriageStatus, 'function');
  assert.equal(typeof surface.recordReviewerEngagement, 'function');
  assert.equal(typeof surface.recordReviewCompleted, 'function');
  assert.equal(typeof surface.routePR, 'function');
=======
>>>>>>> 1fc0304a213929e5aba65ec63b39fbf38a0d62aa
  const subjectRef = {
    domainId: 'code-pr',
    subjectExternalId: 'laceyenterprises/adversarial-review#486',
    revisionRef: 'sha-1',
    linearTicketId: 'LAC-486',
  };

  const overrides = await surface.observeOverrides(subjectRef, 'sha-1');
  await surface.recordReviewCompleted(subjectRef, {
    critical: false,
    reviewSummary: 'review complete',
  });

  assert.equal(overrides.operatorApproved, true);
  assert.equal(overrides.forceRereview, false);
  assert.equal(overrides.halted, false);
  assert.equal(labelCalls.length, 4);
  assert.equal(labelCalls.every((call) => call.repo === 'laceyenterprises/adversarial-review'), true);
  assert.equal(labelCalls.every((call) => call.prNumber === 486), true);
  assert.equal(linearCalls.some((call) => call.type === 'issue' && call.ticketId === 'LAC-486'), true);
  assert.deepEqual(
    linearCalls.find((call) => call.type === 'updateIssue'),
    { type: 'updateIssue', issueId: 'issue-1', payload: { stateId: 'state-done' } }
  );
  assert.deepEqual(surface.routePR('[codex] LAC-486: tighten watcher'), {
    builderClass: 'codex',
    tag: 'codex',
    reviewerModel: 'claude',
    botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
    linearTicketId: 'LAC-486',
  });
<<<<<<< HEAD
=======
>>>>>>> 986782eb62007568c81e2e2b6f40d86a55492f85
>>>>>>> 1fc0304a213929e5aba65ec63b39fbf38a0d62aa
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCriticalFlagComment,
  createLinearTriageAdapter,
  extractLinearTicketId,
  routePR,
} from '../../src/adapters/operator/linear-triage/index.mjs';

function makeLinearFixture({ currentState = 'Todo' } = {}) {
  const updates = [];
  const comments = [];
  const states = [
    { id: 'state-review', name: 'In Review' },
    { id: 'state-progress', name: 'In Progress' },
    { id: 'state-done', name: 'Done' },
  ];
  const issue = {
    id: 'issue-1',
    team: Promise.resolve({
      states: async () => ({ nodes: states }),
    }),
    state: Promise.resolve({ name: currentState }),
  };
  const linear = {
    issue: async (ticketId) => {
      assert.equal(ticketId, 'LAC-486');
      return issue;
    },
    updateIssue: async (issueId, payload) => updates.push({ issueId, payload }),
    createComment: async (payload) => comments.push(payload),
  };
  return { linear, updates, comments };
}

function subjectRef() {
  return {
    domainId: 'code-pr',
    subjectExternalId: 'laceyenterprises/adversarial-review#486',
    revisionRef: 'sha-1',
    linearTicketId: 'LAC-486',
  };
}

test('routePR returns builder class and Linear ticket id for representative titles', () => {
  assert.deepEqual(routePR('[codex] LAC-181: tighten watcher'), {
    builderClass: 'codex',
    tag: 'codex',
    reviewerModel: 'claude',
    botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
    linearTicketId: 'LAC-181',
  });
  assert.deepEqual(routePR('[claude-code] lac-486: carve operator adapter'), {
    builderClass: 'claude-code',
    tag: 'claude-code',
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
    linearTicketId: 'LAC-486',
  });
  assert.equal(routePR('LAC-181: missing builder tag'), null);
  assert.equal(extractLinearTicketId('[codex] no ticket'), null);
});

test('syncTriageStatus moves Linear to In Review on first review post', async () => {
  const { linear, updates } = makeLinearFixture();
  const adapter = createLinearTriageAdapter({
    linearClientProvider: async () => linear,
    logger: {},
  });

  await adapter.syncTriageStatus(subjectRef(), 'in-review');

  assert.deepEqual(updates, [
    { issueId: 'issue-1', payload: { stateId: 'state-review' } },
  ]);
});

test('recordReviewCompleted moves Linear to Done on review completion', async () => {
  const { linear, updates } = makeLinearFixture();
  const adapter = createLinearTriageAdapter({
    linearClientProvider: async () => linear,
    logger: {},
  });

  await adapter.recordReviewCompleted(subjectRef(), {
    critical: false,
    reviewSummary: 'Looks good.',
  });

  assert.deepEqual(updates, [
    { issueId: 'issue-1', payload: { stateId: 'state-done' } },
  ]);
});

test('recordReviewCompleted posts critical flag comments for critical reviews', async () => {
  const { linear, updates, comments } = makeLinearFixture();
  const adapter = createLinearTriageAdapter({
    linearClientProvider: async () => linear,
    logger: {},
  });

  await adapter.recordReviewCompleted(subjectRef(), {
    critical: true,
    reviewSummary: 'Critical security vulnerability in request handling.',
  });

  assert.deepEqual(updates, [
    { issueId: 'issue-1', payload: { stateId: 'state-done' } },
  ]);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].issueId, 'issue-1');
  assert.match(comments[0].body, /Adversarial review flagged critical issues/);
  assert.match(comments[0].body, /critical, vulnerability, security/);
});

<<<<<<< HEAD
=======
test('adapter memoizes the Linear client across triage calls', async () => {
  const { linear, updates, comments } = makeLinearFixture();
  let providerCalls = 0;
  const adapter = createLinearTriageAdapter({
    linearClientProvider: async () => {
      providerCalls += 1;
      return linear;
    },
    logger: {},
  });

  await adapter.syncTriageStatus(subjectRef(), 'in-review');
  await adapter.recordReviewCompleted(subjectRef(), {
    critical: true,
    reviewSummary: 'Critical security vulnerability in request handling.',
  });

  assert.equal(providerCalls, 1);
  assert.equal(updates.length, 2);
  assert.equal(comments.length, 1);
});

>>>>>>> 986782eb62007568c81e2e2b6f40d86a55492f85
test('buildCriticalFlagComment includes matching critical words', () => {
  const body = buildCriticalFlagComment('Possible injection vulnerability.');

  assert.match(body, /vulnerability, injection/);
});

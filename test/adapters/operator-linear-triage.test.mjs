import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildCriticalFlagComment,
  createLinearTriageAdapter,
  extractLinearTicketId,
  isTicketPipelinePaused,
  repoPausePath,
  routePR,
  TICKET_PIPELINE_PAUSED_LABEL,
} from '../../src/adapters/operator/linear-triage/index.mjs';
import { setRepoTicketPipelinePause } from '../../src/ticket-pipeline-pause.mjs';

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

test('ticket-pipeline-paused PR label suppresses Linear updates and comments', async () => {
  const { linear, updates, comments } = makeLinearFixture();
  let providerCalls = 0;
  const logs = [];
  const adapter = createLinearTriageAdapter({
    linearClientProvider: async () => {
      providerCalls += 1;
      return linear;
    },
    logger: { log: (message) => logs.push(message) },
  });
  const pausedRef = {
    ...subjectRef(),
    labels: [{ name: TICKET_PIPELINE_PAUSED_LABEL }],
  };

  await adapter.syncTriageStatus(pausedRef, 'in-review');
  await adapter.recordReviewCompleted(pausedRef, {
    critical: true,
    reviewSummary: 'Critical security vulnerability in request handling.',
  });

  assert.equal(providerCalls, 0);
  assert.deepEqual(updates, []);
  assert.deepEqual(comments, []);
  assert.equal(logs.length, 2);
});

test('repo-level ticket pipeline pause suppresses Linear updates', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  setRepoTicketPipelinePause({
    rootDir,
    repo: 'laceyenterprises/adversarial-review',
    paused: true,
    reason: 'Linear outage',
    requestedAt: '2026-05-24T15:30:00.000Z',
    requestedBy: 'placey',
  });
  const { linear, updates } = makeLinearFixture();
  let providerCalls = 0;
  const adapter = createLinearTriageAdapter({
    rootDir,
    linearClientProvider: async () => {
      providerCalls += 1;
      return linear;
    },
    logger: {},
  });

  assert.equal(isTicketPipelinePaused(subjectRef(), { rootDir }), true);
  assert.match(repoPausePath(rootDir, 'laceyenterprises/adversarial-review'), /ticket-pipeline-pauses/);
  await adapter.syncTriageStatus(subjectRef(), 'in-review');

  assert.equal(providerCalls, 0);
  assert.deepEqual(updates, []);
});

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

test('adapter retries after a transient Linear client provider failure', async () => {
  const { linear, updates } = makeLinearFixture();
  let providerCalls = 0;
  const adapter = createLinearTriageAdapter({
    linearClientProvider: async () => {
      providerCalls += 1;
      if (providerCalls === 1) {
        throw new Error('transient import failure');
      }
      return linear;
    },
    logger: {},
  });

  await assert.rejects(
    adapter.syncTriageStatus(subjectRef(), 'in-review'),
    /transient import failure/
  );
  await adapter.syncTriageStatus(subjectRef(), 'in-review');

  assert.equal(providerCalls, 2);
  assert.deepEqual(updates, [
    { issueId: 'issue-1', payload: { stateId: 'state-review' } },
  ]);
});

test('adapter does not memoize a null Linear client result', async () => {
  const { linear, updates } = makeLinearFixture();
  let providerCalls = 0;
  const adapter = createLinearTriageAdapter({
    linearClientProvider: async () => {
      providerCalls += 1;
      return providerCalls === 1 ? null : linear;
    },
    logger: {},
  });

  await adapter.syncTriageStatus(subjectRef(), 'in-review');
  await adapter.syncTriageStatus(subjectRef(), 'in-review');

  assert.equal(providerCalls, 2);
  assert.deepEqual(updates, [
    { issueId: 'issue-1', payload: { stateId: 'state-review' } },
  ]);
});

test('buildCriticalFlagComment includes matching critical words', () => {
  const body = buildCriticalFlagComment('Possible injection vulnerability.');

  assert.match(body, /vulnerability, injection/);
});

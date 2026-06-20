import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildCriticalFlagComment,
  createLinearTriageAdapter,
  extractLinearTicketId,
  isTicketPipelinePaused,
  repoPausePath,
  resolveTicketPipelinePauseRoot,
  routePR,
  TICKET_PIPELINE_PAUSED_LABEL,
} from '../../src/adapters/operator/linear-triage/index.mjs';
import { setRepoTicketPipelinePause } from '../../src/ticket-pipeline-pause.mjs';

const ALWAYS_ON_ROUTE_OPTIONS = {
  env: {},
  topPath: '/dev/null',
  geminiReviewerMode: 'always-on',
};

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
  assert.deepEqual(routePR('[codex] LAC-181: tighten watcher', null, ALWAYS_ON_ROUTE_OPTIONS), {
    builderClass: 'codex',
    tag: 'codex',
    reviewerModel: 'gemini',
    botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
    geminiReviewerSelection: {
      mode: 'always-on',
      replacedReviewerModel: 'claude',
      reason: 'always-on-third-reviewer',
    },
    linearTicketId: 'LAC-181',
  });
  assert.deepEqual(routePR('[claude-code] lac-486: carve operator adapter', null, ALWAYS_ON_ROUTE_OPTIONS), {
    builderClass: 'claude-code',
    tag: 'claude-code',
    reviewerModel: 'gemini',
    botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
    geminiReviewerSelection: {
      mode: 'always-on',
      replacedReviewerModel: 'codex',
      reason: 'always-on-third-reviewer',
    },
    linearTicketId: 'LAC-486',
  });
  assert.equal(routePR('LAC-181: missing builder tag', null, ALWAYS_ON_ROUTE_OPTIONS), null);
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
  const previous = process.env.ADVERSARIAL_TICKET_PIPELINE_ROOT;
  process.env.ADVERSARIAL_TICKET_PIPELINE_ROOT = rootDir;
  try {
    const pauseRootDir = resolveTicketPipelinePauseRoot(rootDir);
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
    assert.match(repoPausePath(pauseRootDir, 'laceyenterprises/adversarial-review'), /ticket-pipeline-pauses/);
    await adapter.syncTriageStatus(subjectRef(), 'in-review');

    assert.equal(providerCalls, 0);
    assert.deepEqual(updates, []);
  } finally {
    if (previous === undefined) delete process.env.ADVERSARIAL_TICKET_PIPELINE_ROOT;
    else process.env.ADVERSARIAL_TICKET_PIPELINE_ROOT = previous;
  }
});

test('corrupt repo-level pause records fail closed loudly', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const pauseRootDir = resolveTicketPipelinePauseRoot(rootDir, {});
  mkdirSync(path.dirname(repoPausePath(pauseRootDir, 'laceyenterprises/adversarial-review')), { recursive: true });
  writeFileSync(repoPausePath(pauseRootDir, 'laceyenterprises/adversarial-review'), '{not json\n', 'utf8');
  const errors = [];

  assert.equal(isTicketPipelinePaused(subjectRef(), {
    rootDir,
    logger: { error: (message) => errors.push(message) },
    env: {},
  }), true);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /invalid repo pause record/);
  const alertDir = path.join(rootDir, 'data', 'ticket-pipeline-pauses', 'alerts');
  const alerts = readdirSync(alertDir);
  assert.equal(alerts.length, 1);
  const alert = JSON.parse(readFileSync(path.join(alertDir, alerts[0]), 'utf8'));
  assert.equal(alert.alert, 'corrupt-repo-pause-record');
  assert.equal(alert.repo, 'laceyenterprises/adversarial-review');
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
    rootDir: mkdtempSync(path.join(tmpdir(), 'adversarial-review-')),
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

test('adapter persists the resolved daemon pause root for operator CLI comparison', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  createLinearTriageAdapter({
    rootDir,
    env: { HQ_ROOT: hqRoot },
    logger: {},
  });

  const statusPath = path.join(rootDir, 'data', 'ticket-pipeline-pauses', 'daemon-root-status.json');
  assert.equal(existsSync(statusPath), true);
  const status = JSON.parse(readFileSync(statusPath, 'utf8'));
  assert.equal(status.pauseRootDir, resolveTicketPipelinePauseRoot(rootDir, { HQ_ROOT: hqRoot }));
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
    rootDir: mkdtempSync(path.join(tmpdir(), 'adversarial-review-')),
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
    rootDir: mkdtempSync(path.join(tmpdir(), 'adversarial-review-')),
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

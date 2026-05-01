import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WORKER_CLASS_TO_BOT_TOKEN_ENV,
  buildRemediationOutcomeCommentBody,
  postRemediationOutcomeComment,
  resolveCommentBotTokenEnv,
} from '../src/pr-comments.mjs';

function makeJob(overrides = {}) {
  return {
    jobId: 'lac__demo-pr-7-2026-05-01T20-00-00-000Z',
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    builderTag: 'claude-code',
    reviewerModel: 'codex',
    remediationPlan: {
      currentRound: 2,
      maxRounds: 6,
    },
    ...overrides,
  };
}

test('resolveCommentBotTokenEnv maps known worker classes to their bot env vars', () => {
  assert.equal(resolveCommentBotTokenEnv('codex'), 'GH_CODEX_REVIEWER_TOKEN');
  assert.equal(resolveCommentBotTokenEnv('claude-code'), 'GH_CLAUDE_REVIEWER_TOKEN');
});

test('resolveCommentBotTokenEnv returns null for unknown worker classes', () => {
  assert.equal(resolveCommentBotTokenEnv('not-a-class'), null);
  assert.equal(resolveCommentBotTokenEnv(undefined), null);
});

test('WORKER_CLASS_TO_BOT_TOKEN_ENV covers every known remediation worker class', () => {
  // Tripwire: keep this in lockstep with REMEDIATION_WORKER_IDENTITY_DEFAULTS
  // in src/follow-up-remediation.mjs. If a new class lands there but no
  // bot-token mapping exists here, comment posting will silently skip for
  // that class — which the test surfaces immediately.
  const knownClasses = new Set(['codex', 'claude-code']);
  for (const cls of knownClasses) {
    assert.ok(
      WORKER_CLASS_TO_BOT_TOKEN_ENV[cls],
      `worker class "${cls}" must have a bot-token env mapping`
    );
  }
});

test('buildRemediationOutcomeCommentBody on completed includes summary, validation, and re-review yes', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'claude-code',
    action: 'completed',
    job: makeJob(),
    reply: {
      outcome: 'completed',
      summary: 'Tightened null handling in the API layer.',
      validation: ['npm test', 'manual smoke of /v1/users'],
      blockers: [],
    },
    reReview: { requested: true, reason: 'Want adversarial confirmation.' },
  });
  assert.match(body, /Remediation Worker \(claude-code\) — round 2 of 6/);
  assert.match(body, /Outcome:.*completed.*re-review queued/);
  assert.match(body, /Tightened null handling in the API layer/);
  assert.match(body, /- npm test/);
  assert.match(body, /- manual smoke of \/v1\/users/);
  assert.match(body, /Re-review requested:\*\*\s*yes — Want adversarial confirmation\./);
  assert.match(body, /Job: `lac__demo-pr-7-2026-05-01T20-00-00-000Z`/);
});

test('buildRemediationOutcomeCommentBody on stopped (max-rounds-reached) flags human intervention', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'stopped',
    job: {
      ...makeJob({ builderTag: 'codex', reviewerModel: 'claude' }),
      remediationPlan: {
        currentRound: 6,
        maxRounds: 6,
        stop: { code: 'max-rounds-reached' },
      },
    },
    reply: {
      outcome: 'partial',
      summary: 'Addressed two of three findings; the third needs schema migration.',
      validation: [],
      blockers: ['Schema migration requires DBA review'],
    },
  });
  assert.match(body, /round 6 of 6/);
  assert.match(body, /Outcome:.*stopped.*max-rounds-reached/);
  assert.match(body, /Human intervention required/);
  assert.match(body, /exhausted its bounded round cap/);
  assert.match(body, /Blockers/);
  assert.match(body, /- Schema migration requires DBA review/);
  // No re-review requested in this state.
  assert.match(body, /Re-review requested:\*\*\s*no/);
});

test('buildRemediationOutcomeCommentBody on stopped (worker chose blocked) flags human intervention', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'stopped',
    job: {
      ...makeJob(),
      remediationPlan: { currentRound: 1, maxRounds: 6, stop: { code: 'no-progress' } },
    },
    reply: {
      outcome: 'blocked',
      summary: 'Cannot proceed without secrets the worker does not have.',
      validation: [],
      blockers: ['Missing OP_SERVICE_ACCOUNT_TOKEN'],
    },
  });
  assert.match(body, /Human intervention required/);
  assert.match(body, /worker reported blockers it could not resolve/);
});

test('buildRemediationOutcomeCommentBody on failed surfaces the failure code and message', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'failed',
    job: makeJob(),
    failure: { code: 'invalid-remediation-reply', message: 'Remediation reply summary is required' },
  });
  assert.match(body, /Outcome:.*failed/);
  assert.match(body, /Reason: `Remediation reply summary is required`/);
  assert.match(body, /Human intervention required/);
});

test('postRemediationOutcomeComment posts via gh pr comment with the bot token in env', async () => {
  const calls = [];
  const result = await postRemediationOutcomeComment({
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    workerClass: 'claude-code',
    body: '### Remediation Worker (claude-code) — round 1\n\nSummary',
    env: { GH_CLAUDE_REVIEWER_TOKEN: 'test-pat-claude', PATH: '/usr/bin' },
    execFileImpl: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { stdout: '', stderr: '' };
    },
  });

  assert.equal(result.posted, true);
  assert.equal(result.workerClass, 'claude-code');
  assert.equal(result.tokenEnvName, 'GH_CLAUDE_REVIEWER_TOKEN');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'gh');
  assert.deepEqual(calls[0].args, [
    'pr', 'comment', '7', '--repo', 'laceyenterprises/demo', '--body',
    '### Remediation Worker (claude-code) — round 1\n\nSummary',
  ]);
  // The bot PAT is exposed to the gh CLI via GH_TOKEN, scoped to this exec.
  assert.equal(calls[0].options.env.GH_TOKEN, 'test-pat-claude');
});

test('postRemediationOutcomeComment skips with token-env-missing when the env var is absent', async () => {
  // Capture the log call so we know we surfaced it instead of silently swallowing.
  const errors = [];
  const result = await postRemediationOutcomeComment({
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    workerClass: 'claude-code',
    body: 'whatever',
    env: { PATH: '/usr/bin' }, // no GH_CLAUDE_REVIEWER_TOKEN
    execFileImpl: async () => {
      throw new Error('execFile must not be called when token env is missing');
    },
    log: { error: (msg) => errors.push(msg) },
  });
  assert.equal(result.posted, false);
  assert.equal(result.reason, 'token-env-missing');
  assert.equal(result.tokenEnvName, 'GH_CLAUDE_REVIEWER_TOKEN');
  assert.ok(errors.length > 0, 'missing token env should be logged');
});

test('postRemediationOutcomeComment skips with no-token-mapping for unknown worker class', async () => {
  const result = await postRemediationOutcomeComment({
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    workerClass: 'gemini', // not in WORKER_CLASS_TO_BOT_TOKEN_ENV today
    body: 'whatever',
    env: {},
    execFileImpl: async () => {
      throw new Error('execFile must not be called when no token mapping exists');
    },
    log: { error: () => {} },
  });
  assert.equal(result.posted, false);
  assert.equal(result.reason, 'no-token-mapping');
  assert.equal(result.workerClass, 'gemini');
});

test('postRemediationOutcomeComment swallows gh-cli failures and reports them in the result', async () => {
  const result = await postRemediationOutcomeComment({
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    workerClass: 'codex',
    body: 'whatever',
    env: { GH_CODEX_REVIEWER_TOKEN: 'test-pat-codex' },
    execFileImpl: async () => {
      const err = new Error('HTTP 502: bad gateway');
      throw err;
    },
    log: { error: () => {} },
  });
  assert.equal(result.posted, false);
  assert.equal(result.reason, 'gh-cli-failure');
  assert.match(result.error, /HTTP 502/);
});

test('postRemediationOutcomeComment skips when repo or prNumber is missing', async () => {
  const result = await postRemediationOutcomeComment({
    repo: null,
    prNumber: 7,
    workerClass: 'codex',
    body: 'x',
    log: { error: () => {} },
  });
  assert.equal(result.posted, false);
  assert.equal(result.reason, 'missing-pr-coordinates');
});

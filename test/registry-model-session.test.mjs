import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchReadTransport, prepareWorkerObservationSession } from '../src/dispatch-read-client.mjs';
import { prefetchWorkerRegistry, resolveRemediationModel } from '../src/adapters/agent-runtime/local/remediation.mjs';
import { prepareClaudeOAuthEnv, resolveReviewerExecution, resolveReviewerExecutionAsync } from '../src/reviewer-harness.mjs';
import { classifyReviewerFailure } from '../src/adapters/reviewer-runtime/cli-direct/classification.mjs';
import { infraRecoverableFailureClass, reviewerFailureClassFromStoredRow } from '../src/reviewer-failure-classification.mjs';
import { recordCascadeFailure } from '../src/reviewer-cascade.mjs';
import { settleReviewerAttempt } from '../src/reviewer-spawn-settle.mjs';
import { consumeNextFollowUpJob } from '../src/follow-up-remediation.mjs';
import { createFollowUpJob, getFollowUpJobDir } from '../src/follow-up-jobs.mjs';

const quiet = {info() {}, warn() {}};
const reply = model => ({schema_version: 1, status: 'found', data: {classes: {
  'claude-reviewer': {defaultModel: model},
  'codex-reviewer': {defaultModel: 'governed-codex'},
  'gemini-reviewer': {defaultModel: 'governed-gemini'},
  hammer: {defaultModel: 'governed-closer'},
}}});

function fixture(t, name) {
  const env = {APP_CONTRACT_ENDPOINT_URL: `https://example.invalid/${name}`};
  let connects = 0, reads = 0, result = reply('governed-claude');
  t.mock.method(dispatchReadTransport, 'sdk', () => ({
    async connect(config) {
      connects++;
      return {sessionToken: 'fixture-session', endpoint_url: config.endpoint_url};
    },
    async readSessionHostServices(request, options) {
      reads++;
      assert.equal(request.action, 'worker_registry');
      assert.equal(options.session_token, 'fixture-session');
      assert.equal(options.endpoint_url, env.APP_CONTRACT_ENDPOINT_URL);
      assert.ok(options.request_timeout_ms > 0);
      if (result instanceof Error) throw result;
      return result;
    },
    readHostServicesSync() { assert.fail('synchronous registry resolution issued a physical request'); },
  }));
  return {env, set(value) {result = value;}, counts: () => ({connects, reads})};
}

test('cold sync resolution refuses, async prefetch registers once and shares cache across env copies', async t => {
  const f = fixture(t, 'cold');
  assert.throws(() => resolveReviewerExecution('claude', {env: f.env, log: quiet}), {code: 'registry-unavailable'});
  assert.deepEqual(f.counts(), {connects: 0, reads: 0});
  await Promise.all([prefetchWorkerRegistry({env: f.env}), prefetchWorkerRegistry({env: {...f.env}})]);
  for (const harness of ['claude', 'codex', 'gemini']) {
    const execution = resolveReviewerExecution(harness, {env: {...f.env}, fallbackModel: 'forbidden-fallback', log: quiet});
    assert.equal(execution.model, `governed-${harness}`);
    assert.equal(execution.modelSource, 'producer');
  }
  assert.equal(resolveRemediationModel('hammer', {env: f.env}).resolvedModel, 'governed-closer');
  assert.deepEqual(f.counts(), {connects: 1, reads: 1});
  assert.throws(() => resolveReviewerExecution('claude', {env: {APP_CONTRACT_ENDPOINT_URL: 'https://example.invalid/foreign'}, log: quiet}), {code: 'registry-unavailable'});
});

test('a valid snapshot missing the reviewer class cannot select a host fallback', async t => {
  const f = fixture(t, 'missing-class');
  f.set({schema_version: 1, status: 'found', data: {classes: {}}});
  await prefetchWorkerRegistry({env: f.env});
  assert.throws(() => resolveReviewerExecution('codex', {
    env: f.env, fallbackModel: 'host-model', log: quiet,
  }), {code: 'registry-unavailable', failureClass: 'reviewer-model-unresolved'});
});

test('concurrent prefetches for different endpoints each populate their own sync cache', async t => {
  const first = {APP_CONTRACT_ENDPOINT_URL: 'https://example.invalid/concurrent-first'};
  const second = {APP_CONTRACT_ENDPOINT_URL: 'https://example.invalid/concurrent-second'};
  const finish = new Map();
  t.mock.method(dispatchReadTransport, 'sdk', () => ({
    async connect(config) { return {sessionToken: config.endpoint_url, endpoint_url: config.endpoint_url}; },
    readSessionHostServices(_request, options) {
      return new Promise(resolve => finish.set(options.endpoint_url, resolve));
    },
    readHostServicesSync() { assert.fail('sync registry read issued a physical request'); },
  }));
  const a = prefetchWorkerRegistry({env: first});
  const b = prefetchWorkerRegistry({env: second});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finish.size, 2);
  finish.get(second.APP_CONTRACT_ENDPOINT_URL)(reply('second-model'));
  await b;
  finish.get(first.APP_CONTRACT_ENDPOINT_URL)(reply('first-model'));
  await a;
  assert.equal(resolveReviewerExecution('claude', {env: first, log: quiet}).model, 'first-model');
  assert.equal(resolveReviewerExecution('claude', {env: second, log: quiet}).model, 'second-model');
});

test('registry outage defers remediation before claiming a pending job', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'registry-claim-'));
  const previousEndpoint = process.env.APP_CONTRACT_ENDPOINT_URL;
  process.env.APP_CONTRACT_ENDPOINT_URL = 'https://example.invalid/claim-outage';
  t.mock.method(dispatchReadTransport, 'sdk', () => ({
    async connect() { throw new Error('fixture registry endpoint down'); },
  }));
  try {
    createFollowUpJob({rootDir, branch: 'fixture/remediation', repo: 'example/fixture',
      prNumber: 7, reviewerModel: 'codex', builderTag: 'claude-code',
      reviewBody: '## Summary\nFix it.\n\n## Verdict\nComment only',
      reviewPostedAt: '2026-10-28T10:00:00.000Z', critical: false});
    const result = await consumeNextFollowUpJob({rootDir, promptTemplate: 'fixture prompt', log: quiet});
    assert.deepEqual(result, {consumed: false, reason: 'registry-unavailable'});
    assert.equal(readdirSync(getFollowUpJobDir(rootDir, 'pending')).filter(name => name.endsWith('.json')).length, 1);
    assert.equal(existsSync(getFollowUpJobDir(rootDir, 'inProgress')), false);
  } finally {
    if (previousEndpoint === undefined) delete process.env.APP_CONTRACT_ENDPOINT_URL;
    else process.env.APP_CONTRACT_ENDPOINT_URL = previousEndpoint;
    rmSync(rootDir, {recursive: true, force: true});
  }
});

test('expired cache refuses sync use and async resolution refreshes without a new session', async t => {
  const f = fixture(t, 'expiry');
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await prefetchWorkerRegistry({env: f.env});
  now += 60_000;
  assert.throws(() => resolveReviewerExecution('claude', {env: f.env, log: quiet}), {code: 'registry-unavailable'});
  f.set(reply('refreshed-claude'));
  assert.equal((await resolveReviewerExecutionAsync('claude', {env: {...f.env}, log: quiet})).model, 'refreshed-claude');
  assert.deepEqual(f.counts(), {connects: 1, reads: 2});
  now -= 120_000;
  assert.throws(() => resolveReviewerExecution('claude', {env: f.env, log: quiet}), {code: 'registry-unavailable'});
});

test('prefetch reuses an already established observation session', async t => {
  const f = fixture(t, 'existing-session');
  f.env.ADVERSARIAL_WORKER_OBSERVATIONS_ENABLED = '1';
  assert.equal((await prepareWorkerObservationSession({env: f.env})).ok, true);
  await prefetchWorkerRegistry({env: {...f.env}});
  assert.equal(resolveReviewerExecution('claude', {env: f.env, log: quiet}).model, 'governed-claude');
  assert.deepEqual(f.counts(), {connects: 1, reads: 1});
});

test('registration failure is retryable and does not poison the next registration', async t => {
  const f = fixture(t, 'registration');
  const sdk = dispatchReadTransport.sdk();
  let attempts = 0;
  t.mock.method(dispatchReadTransport, 'sdk', () => ({...sdk, connect: async config => {
    if (++attempts === 1) throw new Error('fixture registration down');
    return sdk.connect(config);
  }}));
  await assert.rejects(prefetchWorkerRegistry({env: f.env}), {code: 'registry-unavailable'});
  assert.equal((await resolveReviewerExecutionAsync('claude', {env: f.env, log: quiet})).model, 'governed-claude');
  assert.equal(attempts, 2);
});

test('a timed-out prefetch cannot populate the cache when the transport settles late', async t => {
  const env = {APP_CONTRACT_ENDPOINT_URL: 'https://example.invalid/late'};
  let finish;
  const pending = new Promise(resolve => {finish = resolve;});
  t.mock.method(dispatchReadTransport, 'sdk', () => ({
    connect: async () => ({sessionToken: 'fixture-session'}),
    readSessionHostServices: () => pending,
    readHostServicesSync: () => assert.fail('no synchronous transport'),
  }));
  await assert.rejects(prefetchWorkerRegistry({env, timeoutMs: 10}), {code: 'registry-unavailable'});
  finish(reply('too-late'));
  await pending;
  assert.throws(() => resolveReviewerExecution('claude', {env, log: quiet}), {code: 'registry-unavailable'});
});

test('transport and malformed registry outages remain infrastructure and recover on the next prefetch', async t => {
  const f = fixture(t, 'outage');
  for (const result of [new Error('fixture down'), {schema_version: 1, status: 'unavailable'},
    {schema_version: 1, status: 'found', data: {classes: []}}]) {
    f.set(result);
    await assert.rejects(resolveReviewerExecutionAsync('claude', {env: f.env, log: quiet}), error => {
      assert.equal(error.failureClass, 'reviewer-model-unresolved');
      assert.equal(error.code, 'registry-unavailable');
      assert.equal(error.retryable, true);
      assert.ok(!error.isOAuthError);
      assert.doesNotMatch(error.message, /re-authenticate|OAuth credentials unavailable/);
      assert.equal(classifyReviewerFailure(error.message, 2), 'reviewer-model-unresolved');
      const row = {failure_message: error.message};
      assert.equal(reviewerFailureClassFromStoredRow(row), 'reviewer-model-unresolved');
      assert.equal(infraRecoverableFailureClass(row), 'reviewer-model-unresolved');
      return true;
    });
  }
  f.set(reply('recovered-claude'));
  assert.equal((await resolveReviewerExecutionAsync('claude', {env: f.env, log: quiet})).model, 'recovered-claude');
});

test('corporate Claude obtains the governed model before broker minting; an outage never mints', async t => {
  const f = fixture(t, 'corporate');
  const sourceEnv = {...f.env, CLAUDE_BROKER_PROVIDER: 'claude-code-corp',
    ADVERSARIAL_REVIEW_CLAUDE_CODE_OAUTH_TRANSPORT: 'broker'};
  let mints = 0;
  const args = {sourceEnv, logger: quiet, nowMs: Date.parse('2026-01-01T00:00:00Z'),
    mintClaudeCodeBrokerTokenImpl: async request => {
      mints++;
      assert.equal(request.model, 'governed-claude');
      assert.equal(request.provider, 'claude-code-corp');
      return {injected: true, token: 'synthetic-bearer', expiresAt: '2026-01-02T00:00:00Z'};
    }};
  f.set(new Error('fixture down'));
  await assert.rejects(prepareClaudeOAuthEnv(args), {failureClass: 'reviewer-model-unresolved', retryable: true});
  assert.equal(mints, 0);
  f.set(reply('governed-claude'));
  const auth = await prepareClaudeOAuthEnv(args);
  assert.equal(auth.transport, 'broker');
  assert.equal(auth.env.ANTHROPIC_AUTH_TOKEN, 'synthetic-bearer');
  assert.equal(mints, 1);
});

test('registry failure uses existing bounded infrastructure backoff with its own breakdown', () => {
  const root = mkdtempSync(join(tmpdir(), 'registry-backoff-'));
  try {
    const state = recordCascadeFailure(root, {repo: 'example/fixture', prNumber: 1,
      failureClass: 'reviewer-model-unresolved', failedAt: '2026-01-01T00:00:00Z'});
    assert.equal(state.transientFailureBreakdown['reviewer-model-unresolved'], 1);
    assert.equal(state.backoffMinutes, 1);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('reviewer settlement retries registry faults without using auth tracking or charging normal attempts', () => {
  const root = mkdtempSync(join(tmpdir(), 'registry-settlement-'));
  try {
    for (const exhausted of [false, true]) {
      const calls = [];
      settleReviewerAttempt({rootDir: root, repoPath: 'example/fixture', prNumber: 1,
        reviewerModel: 'claude', failureAt: '2026-01-01T00:00:00Z', log: quiet,
        result: {ok: false, failureClass: 'reviewer-model-unresolved'},
        statements: {
          getReviewRow: {get: () => ({infra_auto_recover_attempts: exhausted ? 999 : 0, review_attempts: 0})},
          markFailed: {run: () => assert.fail('normal attempt must not be charged')},
          markReviewerCredentialOutage: {run: () => assert.fail('registry fault must not enter OAuth outage tracking')},
          markPendingUpstream: {run: (_at, message) => calls.push(['retry', message])},
          markCascadeFailed: {run: (_at, message) => calls.push(['exhausted', message])},
        }});
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], exhausted ? 'exhausted' : 'retry');
      assert.match(calls[0][1], /^\[reviewer-model-unresolved\]/);
      assert.doesNotMatch(calls[0][1], /re-authenticate|OAuth credentials unavailable/);
    }
  } finally { rmSync(root, {recursive: true, force: true}); }
});

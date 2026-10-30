import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {dispatchReadTransport} from '../src/dispatch-read-client.mjs';
import {readDispatchFilesSync, readHostObservationSync, readWorkerDispatchFiles, readWorkerDispatchFilesSync} from '../src/dispatch-files-client.mjs';

const absent = {schema_version: 1, status: 'not_found', metadata: null, log: null,
  scope_complete: false, mutation_authority: false};
test('public file and host reads retain custody on outage, foreign scope and malformed evidence', () => {
  const lookup = dispatchReadTransport.observationSync;
  const host = dispatchReadTransport.hostServicesSync;
  try {
    dispatchReadTransport.observationSync = selector => {
      assert.equal(selector.observation, 'dispatch_files');
      throw new Error('transport unavailable');
    };
    // An explicit legacy root never authorizes reading its local sidecars.
    assert.equal(readDispatchFilesSync({launch_request_id: 'launch-one'}, {hqRoot: '/missing-fixture'}).ok, false);
    dispatchReadTransport.observationSync = () => absent;
    assert.equal(readDispatchFilesSync({launch_request_id: 'foreign'}).ok, false);
    dispatchReadTransport.observationSync = () => ({schema_version: 1, status: 'found'});
    assert.equal(readDispatchFilesSync({launch_request_id: 'launch-one'}).ok, false);
    dispatchReadTransport.hostServicesSync = () => {throw new Error('owner unavailable');};
    assert.equal(readHostObservationSync('deploy_status').ok, false);
  } finally {
    dispatchReadTransport.observationSync = lookup;
    dispatchReadTransport.hostServicesSync = host;
  }
});

test('synchronous host observations never borrow a session from another endpoint', async () => {
  const original = dispatchReadTransport.sdk;
  const sdk = original();
  const calls = [];
  dispatchReadTransport.sdk = () => ({...sdk,
    connect: async config => ({sessionToken: 'synthetic-session', endpoint_url: config.endpoint_url}),
    readSessionDispatchLookup: async () => absent,
    readHostServicesSync: (_request, options) => {calls.push(options); return {schema_version: 1, status: 'found', data: {}};},
  });
  try {
    const args = {env: {ADVERSARIAL_WORKER_OBSERVATIONS_ENABLED: '1'},
      connectOptions: {endpoint_url: 'https://example.invalid/one'}};
    await dispatchReadTransport.lookup({observation: 'workers'}, args);
    dispatchReadTransport.hostServicesSync({action: 'deploy_status'}, args);
    assert.equal(calls[0].session_token, 'synthetic-session');
    dispatchReadTransport.hostServicesSync({action: 'deploy_status'},
      {...args, connectOptions: {endpoint_url: 'https://example.invalid/two'}});
    assert.equal(calls[1].session_token, undefined);
  } finally { dispatchReadTransport.sdk = original; }
});

test('reviewer quota reads public CLI rows and keeps account identity', async () => {
  const {readReviewerQuotaDecision} = await import('../src/reviewer-spawn-settle.mjs');
  const args = {reviewerModel: 'claude-code', env: {}, execFileImpl: async (_command, argv) => {
    assert.deepEqual(argv, ['fleet', 'quota', 'status', '--json']);
    return {stdout: JSON.stringify({providerStatuses: [
      {provider: 'anthropic', authPath: 'oauth', state: 'ok'},
      {provider: 'anthropic', authPath: 'oauth-corp', state: 'exhausted'},
    ]})};
  }};
  assert.equal((await readReviewerQuotaDecision(args)).capped, false);
  assert.equal((await readReviewerQuotaDecision({...args, claudeBrokerProvider: 'claude-code-corp'})).capped, true);
});

test('a physically absent workspace still requires canonical terminal evidence', async t => {
  const {prepareOriginalWorkerForMergeAgent} = await import('../src/merge-agent-original-worker-teardown.mjs');
  t.mock.method(dispatchReadTransport, 'lookup', async selector => selector.observation === 'workers'
    ? {schema_version: 1, observation: 'workers', status: 'found', complete: true, next_offset: null,
      scope_complete: false, mutation_authority: false,
      items: [{worker_id: 'codex-example', run_id: 'run-one', launch_request_id: 'launch-one'}]}
    : {schema_version: 1, status: 'found', launchRequestId: 'launch-one', runId: 'run-one',
      scope_complete: false, mutation_authority: false,
      metadata: {status: 'found', launchRequestId: 'launch-one', runId: 'run-one',
        fileStates: {run: 'missing', workspace: 'missing'}, run: {}, workspace: {present: false}},
      log: {status: 'missing', redacted: true, text: ''}});
  for (const status of ['starting', 'future-status', 'succeeded']) {
    const result = await prepareOriginalWorkerForMergeAgent({job: {branch: 'codex-example/feature'},
      env: {HQ_ROOT: '/missing-fixture'}, lookupRunStatusImpl: async () => ({found: true, status}),
      execFileImpl: async () => assert.fail('absence is never a teardown command')});
    assert.equal(result.decision, status === 'succeeded' ? 'ready' : 'deferred');
  }
});


test('reused worker slots with multiple runs retain custody independent of order', async t => {
  const rows = [
    {worker_id: 'hammer-ama-pr-1', run_id: 'old', launch_request_id: 'old'},
    {worker_id: 'hammer-ama-pr-1', run_id: 'new', launch_request_id: 'new'},
  ];
  const reply = () => ({schema_version: 1, observation: 'workers', status: 'found', complete: true,
    next_offset: null, items: rows, scope_complete: false, mutation_authority: false});
  t.mock.method(dispatchReadTransport, 'lookup', async selector => {
    assert.equal(selector.observation, 'workers'); return reply();
  });
  t.mock.method(dispatchReadTransport, 'observationSync', selector => {
    assert.equal(selector.observation, 'workers'); return reply();
  });
  for (let order = 0; order < 2; order++) {
    const unresolved = await readWorkerDispatchFiles('hammer-ama-pr-1', {env: {ADVERSARIAL_WORKER_OBSERVATIONS_ENABLED: '1'}});
    assert.equal(unresolved.ok, false);
    assert.equal(unresolved.workerRunCount, 2, 'closer fallback must preserve known slot ambiguity');
    const syncUnresolved = readWorkerDispatchFilesSync('hammer-ama-pr-1', {env: {ADVERSARIAL_WORKER_OBSERVATIONS_ENABLED: '1'}});
    assert.deepEqual(syncUnresolved, unresolved, 'sync readers must preserve the same ambiguity evidence');
    rows.reverse();
  }
});

test('an unscoped dispatch read never borrows the caller HCP token', t => {
  let reads = 0;
  t.mock.method(dispatchReadTransport, 'observationSync', () => {reads++; return absent;});
  t.mock.method(dispatchReadTransport, 'sdk', () => ({
    readDispatchFiles: () => ({available: false}),
    readHcpDispatchLookupSync: () => assert.fail('unscoped own-token read'),
  }));
  for (const launch_request_id of [undefined, '', ' ']) {
    assert.equal(readDispatchFilesSync({launch_request_id}, {env: {HCP_TOKEN: 'synthetic'}}).ok, false);
  }
  assert.equal(reads, 3);
});

test('quota snapshots coalesce preflights and warn on retired directory config', async t => {
  const {readReviewerQuotaDecision} = await import('../src/reviewer-spawn-settle.mjs');
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));
  let calls = 0;
  const args = {reviewerModel: 'claude-code', env: {AGENT_OS_REVIEWER_QUOTA_STATUS_DIR: '/ignored'},
    execFileImpl: async () => {calls++; return {stdout: JSON.stringify({providerStatuses: [{provider: 'anthropic', authPath: 'oauth', state: 'ok'}]})};}};
  await Promise.all([readReviewerQuotaDecision(args), readReviewerQuotaDecision(args)]);
  assert.equal(calls, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /quota_status_dir is ignored/);
});

test('unavailable deploy observations do not excuse deterministic reviewer failures', async t => {
  const {resolveReviewerOutageSignal} = await import('../src/reviewer-spawn-settle.mjs');
  let reply = {schema_version: 1, status: 'unavailable'};
  t.mock.method(dispatchReadTransport, 'hostServicesSync', () => reply);
  const args = {failureClass: 'bug', fullOutput: 'deterministic crash', env: {}};
  assert.equal(resolveReviewerOutageSignal(args).active, false);
  reply = {schema_version: 1, status: 'found', data: {availability: 'unknown'}};
  assert.equal(resolveReviewerOutageSignal(args).active, false);
  reply.data = {availability: 'unreadable'};
  assert.equal(resolveReviewerOutageSignal(args).reason, 'deploy-wedge');
  reply.data = {availability: 'available', freezeClass: 'deploy-freeze'};
  assert.equal(resolveReviewerOutageSignal(args).reason, 'deploy-wedge');
});

test('production spawnReviewer honors the public quota gate directly', async t => {
  const {spawnReviewer} = await import('../src/reviewer-spawn-settle.mjs');
  // The source export is exercised without the raw-file translation wrapper.
  // Quota decision delegates to the real parser with a synthetic CLI boundary.
  const {readReviewerQuotaDecision} = await import('../src/reviewer-spawn-settle.mjs');
  let calls = 0;
  const rootDir = mkdtempSync(join(tmpdir(), 'reviewer-quota-fence-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const result = await spawnReviewer({rootDir, repo: 'acme/fixture', prNumber: 1,
    reviewerModel: 'claude-code', reviewerHeadSha: 'a'.repeat(40), reviewerSessionUuid: 'direct-quota',
    quotaCheckEnv: {}, beginReviewerPassImpl() {}, completeReviewerPassImpl() {},
    readReviewerQuotaDecisionImpl: args => readReviewerQuotaDecision({...args, execFileImpl: async () => {
      calls++; return {stdout: JSON.stringify({providerStatuses: [{provider: 'anthropic', authPath: 'oauth', state: 'exhausted'}]})};
    }}),
    reviewerRuntimeAdapterOverride: {spawnReviewer: () => assert.fail('quota must hold spawn')},
  });
  assert.equal(calls, 1);
  assert.equal(result.reason, 'primary-reviewer-quota-capped');
});

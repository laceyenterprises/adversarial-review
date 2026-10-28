import test from 'node:test';
import assert from 'node:assert/strict';
import {dispatchReadTransport} from '../src/dispatch-read-client.mjs';
import {readDispatchFilesSync, readHostObservationSync} from '../src/dispatch-files-client.mjs';

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

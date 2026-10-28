import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchReadTransport } from '../src/dispatch-read-client.mjs';
import { readHostObservation, readHostObservationSync } from '../src/dispatch-files-client.mjs';
import { ensureWorkerRegistryReady, resolveRemediationModel } from '../src/adapters/agent-runtime/local/remediation.mjs';
import { classifyReviewerFailure } from '../src/adapters/reviewer-runtime/cli-direct/classification.mjs';
import { infraRecoverableFailureClass, reviewerFailureClassFromStoredRow } from '../src/reviewer-failure-classification.mjs';
import { settleReviewerAttempt } from '../src/reviewer-spawn-settle.mjs';
import { resolveMergeAgentDispatchHarness } from '../src/merge-agent-harness.mjs';

const secret = 'synthetic-secret-must-never-escape';
const denied = () => new Error(`app-contract entitlement_denied: app is not entitled to host.observations.read; bearer ${secret}`);
const found = {schema_version: 1, status: 'found', data: {classes: {fixture: {defaultModel: 'governed-fixture'}}}};

for (const [name, read, method] of [
  ['async', readHostObservation, 'hostServices'],
  ['sync', readHostObservationSync, 'hostServicesSync'],
]) {
  test(`${name} host reads preserve safe refusal classes and discard producer secrets`, async t => {
    const cases = [
      [denied(), 'entitlement-denied', false],
      [new Error(`403 entitlement_denied: app is not entitled to host.observations.read ${secret}`), 'entitlement-denied', false],
      [Object.assign(new Error(secret), {code: 'entitlement_denied', capability: `host.observations.read ${secret}`}), 'entitlement-denied', false],
      [Object.assign(denied(), {retryable: true}), 'entitlement-denied', false],
      [Object.assign(new Error(secret), {code: 'not_entitled'}), 'entitlement-denied', false],
      [{schema_version: 1, status: 'not-entitled'}, 'entitlement-denied', false],
      [Object.assign(new Error(secret), {statusCode: 401}), 'entitlement-denied', false],
      [Object.assign(new Error(secret), {response: {status: 403}}), 'entitlement-denied', false],
      [new Error(`app-contract 401: ${secret}`), 'entitlement-denied', false],
      [new Error(`app-contract 403: ${secret}`), 'entitlement-denied', false],
      [{schema_version: 1, status: 'entitlement_denied', capability: 'host.observations.read', body: secret}, 'entitlement-denied', false],
      [new Error(`app-contract request timed out after 10ms ${secret}`), 'timeout', true],
      [Object.assign(new Error(secret), {code: 'ETIMEDOUT'}), 'timeout', true],
      [{schema_version: 1, status: 'timeout', reason: secret}, 'timeout', true],
      [Object.assign(new Error(secret), {code: 'ECONNREFUSED'}), 'unavailable', true],
      [{schema_version: 1, status: 'unavailable', reason: secret}, 'unavailable', true],
      [{schema_version: 1, status: 'not_found', body: secret}, 'not-found', false],
      [new Error(`app-contract not_found: ${secret}`), 'not-found', false],
      [undefined, 'unavailable', true],
      [{schema_version: 2, status: 'found', data: found.data}, 'unavailable', true],
    ];
    let value;
    t.mock.method(dispatchReadTransport, method, () => {
      if (value instanceof Error) throw value;
      return value;
    });
    for (const [reply, reason, retryable] of cases) {
      value = reply;
      const result = await read('worker_registry');
      assert.equal(result.ok, false);
      assert.equal(result.reason, reason);
      assert.equal(result.retryable, retryable);
      if (reason === 'entitlement-denied') assert.equal(result.detail, 'host.observations.read');
      assert.ok(!JSON.stringify(result).includes(secret));
    }
    value = found;
    assert.deepEqual(await read('worker_registry'), {ok: true, data: found.data});
  });
}

test('a bounded host read reports a timeout without waiting for the producer', async () => {
  const result = await readHostObservation('deploy_status', {timeoutMs: 10,
    dispatchSession: {hostServices: () => new Promise(() => {})}});
  assert.equal(result.reason, 'timeout');
  assert.equal(result.retryable, true);
  assert.match(result.detail, /timed out/);
});

for (const [reason, producer, retryable] of [
  ['entitlement-denied', denied(), false],
  ['timeout', Object.assign(new Error(secret), {code: 'ETIMEDOUT'}), true],
  ['unavailable', {schema_version: 1, status: 'unavailable', reason: secret}, true],
  ['not-found', {schema_version: 1, status: 'not_found'}, false],
]) {
  test(`registry ${reason} retains refusal evidence and permits seed fallback only for retryable outages`, async t => {
    const env = {APP_CONTRACT_ENDPOINT_URL: `https://example.invalid/refusal-${reason}`};
    let value = producer, reads = 0;
    t.mock.method(dispatchReadTransport, 'sdk', () => ({
      connect: async config => ({sessionToken: 'fixture-session', endpoint_url: config.endpoint_url}),
      readSessionHostServices: async () => {
        reads++;
        if (value instanceof Error) throw value;
        return value;
      },
      readHostServicesSync: () => assert.fail('sync resolution must not issue a request'),
    }));
    const failureClass = retryable ? 'reviewer-model-unresolved' : 'reviewer-configuration-error';
    const check = error => {
      assert.equal(error.code, 'registry-unavailable');
      assert.equal(error.reason, reason);
      assert.equal(error.retryable, retryable);
      assert.equal(error.failureClass, failureClass);
      assert.match(error.message, new RegExp(reason));
      assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes(secret));
      if (reason === 'entitlement-denied') {
        assert.equal(error.detail, 'host.observations.read');
        assert.equal(error.category, 'configuration');
      }
      return true;
    };
    if (retryable) assert.equal(await ensureWorkerRegistryReady({env}), false);
    else await assert.rejects(ensureWorkerRegistryReady({env}), check);
    assert.throws(() => dispatchReadTransport.hostServicesSync({action: 'worker_registry'}, {env}), error => {
      assert.equal(error.code, 'registry-unavailable');
      assert.equal(error.reason, reason);
      assert.equal(error.retryable, retryable);
      assert.equal(error.failureClass, failureClass);
      assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes(secret));
      return true;
    });
    assert.throws(() => resolveRemediationModel('fixture', {env, fallbackModel: 'forbidden-fixture'}), check);
    if (retryable) {
      const selected = resolveRemediationModel('remediator-codex', {env, log: {warn() {}, info() {}}});
      assert.equal(selected.modelSource, 'committed-seed');
      assert.ok(selected.resolvedModel);
    } else {
      assert.throws(() => resolveRemediationModel('remediator-codex', {env}), check);
    }
    assert.equal(reads, 1);
    const foreign = readHostObservationSync('worker_registry', {env: {APP_CONTRACT_ENDPOINT_URL: 'https://example.invalid/other-refusal'}});
    assert.equal(foreign.reason, 'unavailable');
    value = found;
    await ensureWorkerRegistryReady({env});
    assert.equal(resolveRemediationModel('fixture', {env}).resolvedModel, 'governed-fixture');
    assert.equal(reads, 2, 'failure diagnostics must not prevent a new async read');
  });
}

test('entitlement refusal stays terminal through subprocess classification, settlement and stored recovery', async t => {
  t.mock.method(dispatchReadTransport, 'hostServices', async () => {throw denied();});
  let refusal;
  await assert.rejects(ensureWorkerRegistryReady(), error => {refusal = error; return true;});
  const failureClass = classifyReviewerFailure(refusal.message, 1);
  assert.equal(failureClass, 'reviewer-configuration-error');
  for (const failure_message of [refusal.message, `[${failureClass}] ${refusal.message}`, `[${failureClass}]`]) {
    assert.equal(reviewerFailureClassFromStoredRow({failure_message}), failureClass);
    assert.equal(infraRecoverableFailureClass({failure_message}), null);
  }
  const metadataRow = {metadata_json: JSON.stringify({failureClass})};
  assert.equal(reviewerFailureClassFromStoredRow(metadataRow), failureClass);
  assert.equal(infraRecoverableFailureClass(metadataRow), null);
  const calls = [];
  settleReviewerAttempt({repoPath: 'example/fixture', prNumber: 1,
    failureAt: '2026-01-01T00:00:00Z', log: {warn() {}},
    result: {ok: false, failureClass, error: refusal.message},
    statements: {
      markFailed: {run: (...args) => calls.push(args)},
      markPendingUpstream: {run: () => assert.fail('configuration faults must not retry')},
      markCascadeFailed: {run: () => assert.fail('configuration faults must not spend infra recovery')},
    }});
  assert.equal(calls.length, 1);
  assert.match(calls[0][1], /entitlement-denied \(host\.observations\.read\)/);
  const harness = await resolveMergeAgentDispatchHarness({workerClass: 'hammer', fallbackWorkerClasses: [],
    resolveHarnessImpl: async () => {throw refusal;}, logger: {warn() {}}});
  assert.equal(harness.deferred, true);
  assert.equal(harness.retryable, false);
  assert.equal(harness.detail, 'host.observations.read');
});


test('stored recovery preserves the base allowlist and terminal configuration refusals', () => {
  for (const [failureClass, expected] of [
    ['reviewer-configuration-error', null],
    ['reviewer-model-unavailable', null],
    ['reviewer-output', 'reviewer-output'],
    ['reviewer-model-unresolved', 'reviewer-model-unresolved'],
    ['reviewer-empty-output', 'reviewer-empty-output'],
  ]) {
    const row = {failure_message: `[${failureClass}]`};
    assert.equal(reviewerFailureClassFromStoredRow(row), failureClass);
    assert.equal(infraRecoverableFailureClass(row), expected);
  }
});

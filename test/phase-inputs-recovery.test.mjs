import test from 'node:test';
import assert from 'node:assert/strict';
import { missingPhaseInputsOutcome, PHASE_INPUTS_MISSING, QUOTA_PHASE_INPUTS_MISSING } from '../src/ama/phase-inputs-recovery.mjs';
import { launchRequestQuotaResumePending, launchRequestInFlight, launchRequestOwned } from '../src/ama/launch-request-status.mjs';

const killed = launch_request_id => ({ launch_request_id, status: 'failed',
  failure_class: 'worker_killed', worker_killed_cause: 'provider_quota_exhausted' });
const record = { launchRequestId: 'root' };
const audit = { status: 'failed-without-merge', attempts: [{
  outcome: 'failed-without-merge', reason: PHASE_INPUTS_MISSING, launchRequestId: 'root',
}] };

test('single-attempt recovery accepts omitted, null and empty retry chains', () => {
  for (const retryChain of [undefined, null, []]) {
    const probe = { ok: true, row: { launch_request_id: 'root', status: 'failed' }, retryChain };
    assert.equal(missingPhaseInputsOutcome(probe, record, audit), PHASE_INPUTS_MISSING);
    assert.equal(missingPhaseInputsOutcome({ ...probe, retryChainUnreadable: true }, record, audit), null);
    assert.equal(missingPhaseInputsOutcome(probe, record, { ...audit, status: 'succeeded' }), null);
    assert.equal(missingPhaseInputsOutcome(probe, { launchRequestId: 'foreign' }, audit), null);
    assert.equal(missingPhaseInputsOutcome(probe, record, { ...audit, attempts: [{
      ...audit.attempts[0], launchRequestId: 'foreign',
    }] }), null);
  }
});

test('published retries settle ancestor quota intent without an enqueued marker', () => {
  for (const status of ['succeeded', 'failed', 'canceled', 'running', 'waiting_input']) {
    const probe = { ok: true, row: killed('root'),
      retryChain: [{ launch_request_id: 'retry', status }] };
    assert.equal(launchRequestQuotaResumePending(probe), false);
    assert.equal(launchRequestInFlight(probe), status === 'running');
    assert.equal(launchRequestOwned(probe), ['running', 'waiting_input'].includes(status));
  }
});

test('retry edges settle nested historical kills while an unresolved quota leaf retains ownership', () => {
  const leaf = { launch_request_id: 'leaf', status: 'succeeded' };
  const probe = { ok: true, row: killed('root'), retryChain: [leaf, killed('retry')],
    retryEdges: [{ parent: 'root', child: 'retry' }, { parent: 'retry', child: 'leaf' }] };
  assert.equal(launchRequestQuotaResumePending(probe), false, 'producer order need not be chronological');
  assert.equal(launchRequestInFlight(probe), false);
  assert.equal(launchRequestQuotaResumePending({ ...probe, retryChain: [killed('leaf'), killed('retry')] }), true);
  assert.equal(launchRequestQuotaResumePending({ ...probe, retryChain: [
    leaf, killed('retry'), killed('unresolved-branch'),
  ], retryEdges: [...probe.retryEdges, { parent: 'root', child: 'unresolved-branch' }] }), true);
});

test('an unpublished quota resume holds until dismissed or canceled', () => {
  for (const last_admit_refusal_reason of [null, 'quota_resume_retry_enqueued']) {
    const probe = { ok: true, row: { ...killed('root'), last_admit_refusal_reason }, retryChain: [] };
    assert.equal(launchRequestQuotaResumePending(probe), true);
    assert.equal(missingPhaseInputsOutcome(probe, record, audit), null);
    for (const reason of ['quota_operator_dismissed', 'origin_owned_retry_policy']) {
      assert.equal(launchRequestQuotaResumePending({ ...probe, row: {
        ...probe.row, last_admit_refusal_reason: reason,
      } }), false);
    }
    assert.equal(launchRequestQuotaResumePending({ ...probe, row: { ...probe.row, status: 'canceled' } }), false);
  }
});

test('named missing-input failures recover with retained quota cause and enqueue marker', () => {
  for (const status of ['failed', 'canceled']) {
    const probe = { ok: true, row: { ...killed('root'), status,
      failure_class: QUOTA_PHASE_INPUTS_MISSING, last_admit_refusal_reason: 'quota_resume_retry_enqueued' },
    retryChain: [] };
    assert.equal(launchRequestQuotaResumePending(probe), false);
    assert.equal(missingPhaseInputsOutcome(probe, record, null), QUOTA_PHASE_INPUTS_MISSING);
    assert.equal(missingPhaseInputsOutcome({ ok: true, row: killed('root'),
      retryChain: [{ ...probe.row, launch_request_id: 'retry' }],
    }, record, null), QUOTA_PHASE_INPUTS_MISSING, 'terminal refusal settles an ancestor quota kill');
    assert.equal(missingPhaseInputsOutcome({ ...probe, retryChain: [{
      launch_request_id: 'retry', status: 'running',
    }] }, record, null), null, 'live retries still prevent replacement');
  }
});

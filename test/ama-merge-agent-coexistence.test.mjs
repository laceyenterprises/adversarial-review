import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COEXISTENCE_ACTION,
  MERGE_AGENT_OPERATOR_FALLBACK_ENV,
  MERGE_AGENT_OPERATOR_FALLBACK_ENV_VALUE,
  decideMergeAgentCoexistence,
  isMergeAgentRequestedScoped,
  mergeAgentDispatchEnvForAction,
} from '../src/ama/coexistence.mjs';

// ---------------------------------------------------------------------------
// AMA-06N env-var contract pin — AMA-06A on the agent-os side accepts
// ONLY the exact lowercase string "true". Drift here breaks the bypass.
// ---------------------------------------------------------------------------

test('env-var name + value match the AMA-06A admit-gate contract byte-for-byte', () => {
  assert.equal(MERGE_AGENT_OPERATOR_FALLBACK_ENV, 'AMA_OPERATOR_MERGE_AGENT_OVERRIDE');
  assert.equal(MERGE_AGENT_OPERATOR_FALLBACK_ENV_VALUE, 'true');
});

// ---------------------------------------------------------------------------
// isMergeAgentRequestedScoped — head-scope + attribution + freshness.
// ---------------------------------------------------------------------------

test('isMergeAgentRequestedScoped: absent event → false', () => {
  assert.equal(isMergeAgentRequestedScoped(null, { headSha: 'abc', author: 'alice' }), false);
  assert.equal(isMergeAgentRequestedScoped(undefined, { headSha: 'abc', author: 'alice' }), false);
});

test('isMergeAgentRequestedScoped: current-head + fresh attributable event → true', () => {
  const event = {
    id: 'evt-1',
    headSha: 'abc',
    actor: 'bob',
    createdAt: '2026-05-07T12:05:00.000Z',
  };
  assert.equal(
    isMergeAgentRequestedScoped(event, { headSha: 'abc', prUpdatedAt: '2026-05-07T12:05:00.000Z' }),
    true,
  );
});

test('isMergeAgentRequestedScoped: stale head → false', () => {
  const event = {
    id: 'evt-1',
    headSha: 'OLD-head',
    actor: 'bob',
    createdAt: '2026-05-07T12:05:00.000Z',
  };
  assert.equal(
    isMergeAgentRequestedScoped(event, { headSha: 'NEW-head', prUpdatedAt: '2026-05-07T12:05:00.000Z' }),
    false,
  );
});

test('isMergeAgentRequestedScoped: missing actor → false', () => {
  const event = { id: 'evt-1', headSha: 'abc', actor: '', createdAt: '2026-05-07T12:05:00.000Z' };
  assert.equal(
    isMergeAgentRequestedScoped(event, { headSha: 'abc', prUpdatedAt: '2026-05-07T12:05:00.000Z' }),
    false,
  );
});

test('isMergeAgentRequestedScoped: unknown actor → false', () => {
  const event = { id: 'evt-1', headSha: 'abc', actor: 'unknown', createdAt: '2026-05-07T12:05:00.000Z' };
  assert.equal(
    isMergeAgentRequestedScoped(event, { headSha: 'abc', prUpdatedAt: '2026-05-07T12:05:00.000Z' }),
    false,
  );
});

test('isMergeAgentRequestedScoped: missing event id → false', () => {
  const event = { headSha: 'abc', actor: 'alice', createdAt: '2026-05-07T12:05:00.000Z' };
  assert.equal(
    isMergeAgentRequestedScoped(event, { headSha: 'abc', prUpdatedAt: '2026-05-07T12:05:00.000Z' }),
    false,
  );
});

test('isMergeAgentRequestedScoped: stale versus latest PR update → false', () => {
  const event = {
    id: 'evt-1',
    headSha: 'abc',
    actor: 'alice',
    createdAt: '2026-05-07T12:04:59.000Z',
  };
  assert.equal(
    isMergeAgentRequestedScoped(event, { headSha: 'abc', prUpdatedAt: '2026-05-07T12:05:00.000Z' }),
    false,
  );
});

test('isMergeAgentRequestedScoped: same-login application stays valid when fresh and attributable', () => {
  const event = {
    id: 'evt-1',
    headSha: 'abc',
    actor: 'alice',
    createdAt: '2026-05-07T12:05:00.000Z',
  };
  assert.equal(
    isMergeAgentRequestedScoped(event, { headSha: 'abc', prUpdatedAt: '2026-05-07T12:05:00.000Z' }),
    true,
  );
});

test('isMergeAgentRequestedScoped: tolerates alternate field names', () => {
  const event = {
    labelEventId: 'evt-1',
    head_sha: 'abc',
    actor: 'bob',
    createdAt: '2026-05-07T12:05:00.000Z',
  };
  assert.equal(
    isMergeAgentRequestedScoped(event, { headSha: 'abc', prUpdatedAt: '2026-05-07T12:05:00.000Z' }),
    true,
  );
});

// ---------------------------------------------------------------------------
// SPEC §4.8 decision matrix — the 7 cases the prompt requires.
// ---------------------------------------------------------------------------

test('case 1: cfg.enabled=false, no operator label → merge-agent-default (current behavior)', () => {
  const r = decideMergeAgentCoexistence({
    amaEnabled: false,
    amaClosureDispatched: false,
    mergeAgentRequestedScoped: false,
  });
  assert.equal(r.action, COEXISTENCE_ACTION.MERGE_AGENT_DEFAULT);
  assert.equal(mergeAgentDispatchEnvForAction(r.action), null);
});

test('case 2: cfg.enabled=false, operator label present → merge-agent-default (label is no-op when AMA off)', () => {
  const r = decideMergeAgentCoexistence({
    amaEnabled: false,
    amaClosureDispatched: false,
    mergeAgentRequestedScoped: true,
  });
  assert.equal(r.action, COEXISTENCE_ACTION.MERGE_AGENT_DEFAULT);
  assert.equal(mergeAgentDispatchEnvForAction(r.action), null);
});

test('case 3: cfg.enabled=true + AMA eligible + no operator label → AMA closer', () => {
  // The AMA closer fires upstream; this surface is `amaClosureDispatched=true`.
  const r = decideMergeAgentCoexistence({
    amaEnabled: true,
    amaClosureDispatched: true,
    mergeAgentRequestedScoped: false,
  });
  assert.equal(r.action, COEXISTENCE_ACTION.AMA_CLOSER);
  assert.equal(mergeAgentDispatchEnvForAction(r.action), null);
});

test('case 4: cfg.enabled=true + AMA NOT eligible + no operator label → await-operator-action', () => {
  // SPEC §4.8 — watcher must NOT silently fall through to merge-agent
  // when AMA is enabled but not eligible.
  const r = decideMergeAgentCoexistence({
    amaEnabled: true,
    amaClosureDispatched: false,
    mergeAgentRequestedScoped: false,
  });
  assert.equal(r.action, COEXISTENCE_ACTION.AWAIT_OPERATOR_ACTION);
  assert.equal(mergeAgentDispatchEnvForAction(r.action), null);
});

test('case 5: cfg.enabled=true + operator label on current head → operator-fallback + override env', () => {
  const r = decideMergeAgentCoexistence({
    amaEnabled: true,
    amaClosureDispatched: false,
    amaClosureEligibilityMiss: true,
    mergeAgentRequestedScoped: true,
  });
  assert.equal(r.action, COEXISTENCE_ACTION.MERGE_AGENT_OPERATOR_FALLBACK);
  const env = mergeAgentDispatchEnvForAction(r.action);
  assert.deepEqual(env, { [MERGE_AGENT_OPERATOR_FALLBACK_ENV]: MERGE_AGENT_OPERATOR_FALLBACK_ENV_VALUE });
});

test('case 5b: cfg.enabled=true + AMA dispatch failure + no operator label → merge-agent-recovery-fallback', () => {
  const r = decideMergeAgentCoexistence({
    amaEnabled: true,
    amaClosureDispatched: false,
    amaClosureRecoverableFailure: true,
    mergeAgentRequestedScoped: false,
  });
  assert.equal(r.action, COEXISTENCE_ACTION.MERGE_AGENT_RECOVERY_FALLBACK);
  const env = mergeAgentDispatchEnvForAction(r.action);
  assert.deepEqual(env, { [MERGE_AGENT_OPERATOR_FALLBACK_ENV]: MERGE_AGENT_OPERATOR_FALLBACK_ENV_VALUE });
});

test('case 6: cfg.enabled=true + stale-head operator label → await-operator-action', () => {
  // The caller (the watcher) computes `mergeAgentRequestedScoped` via
  // `isMergeAgentRequestedScoped` which already rejects stale heads.
  // Confirmed by the head-scope unit tests above; here we verify the
  // downstream cell of the decision matrix.
  const staleScoped = isMergeAgentRequestedScoped(
    { headSha: 'OLD', actor: 'bob' },
    { headSha: 'NEW', author: 'alice' },
  );
  assert.equal(staleScoped, false);
  const r = decideMergeAgentCoexistence({
    amaEnabled: true,
    amaClosureDispatched: false,
    amaClosureEligibilityMiss: true,
    mergeAgentRequestedScoped: staleScoped,
  });
  assert.equal(r.action, COEXISTENCE_ACTION.AWAIT_OPERATOR_ACTION);
});

test('case 7: cfg.enabled=true + same-login current-head operator label → operator-fallback', () => {
  const selfScoped = isMergeAgentRequestedScoped(
    {
      id: 'evt-1',
      headSha: 'abc',
      actor: 'alice',
      createdAt: '2026-05-07T12:05:00.000Z',
    },
    { headSha: 'abc', prUpdatedAt: '2026-05-07T12:05:00.000Z' },
  );
  assert.equal(selfScoped, true);
  const r = decideMergeAgentCoexistence({
    amaEnabled: true,
    amaClosureDispatched: false,
    amaClosureEligibilityMiss: true,
    mergeAgentRequestedScoped: selfScoped,
  });
  assert.equal(r.action, COEXISTENCE_ACTION.MERGE_AGENT_OPERATOR_FALLBACK);
});

// ---------------------------------------------------------------------------
// AMA-CLOSER-PENDING precedence — when the lease is held or the AMA
// dispatch is in-flight, the watcher must NOT also dispatch merge-agent.
// ---------------------------------------------------------------------------

test('amaClosurePending=true takes precedence over operator-fallback (no double dispatch)', () => {
  const r = decideMergeAgentCoexistence({
    amaEnabled: true,
    amaClosureDispatched: false,
    amaClosurePending: true,
    mergeAgentRequestedScoped: true,
  });
  assert.equal(r.action, COEXISTENCE_ACTION.AMA_CLOSER_PENDING);
  assert.equal(mergeAgentDispatchEnvForAction(r.action), null);
});

// ---------------------------------------------------------------------------
// Defensive: dispatch-env helper only emits for the operator-fallback.
// ---------------------------------------------------------------------------

test('mergeAgentDispatchEnvForAction returns null for every non-fallback action', () => {
  for (const action of [
    COEXISTENCE_ACTION.MERGE_AGENT_DEFAULT,
    COEXISTENCE_ACTION.AMA_CLOSER,
    COEXISTENCE_ACTION.AMA_CLOSER_PENDING,
    COEXISTENCE_ACTION.AWAIT_OPERATOR_ACTION,
  ]) {
    assert.equal(mergeAgentDispatchEnvForAction(action), null, `expected null for action=${action}`);
  }
});

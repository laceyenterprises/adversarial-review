import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveFloorWeeklyMeasurement } from '../src/fleet-quota-status.mjs';
import { selectCodexWorkerAccount, selectCodexReviewerAccount } from '../src/codex-account-routing.mjs';
import { selectClaudeAccountLaneFromSnapshot } from '../src/claude-account-routing.mjs';

// The shape `hq fleet quota status --json` emits today: each reserve floor carries
// `measurement` with `confidence`, not the legacy `weeklyMeasurement.status`.
function floor(percentRemaining, { confidence = 'measured', inferred = false } = {}) {
  return {
    active: false, paused: false, nearCap: false,
    measurement: { capSource: 'provider-rate-limits', confidence, inferred, percentRemaining },
  };
}

function row(provider, authPath) {
  return { provider, authPath, state: 'ok', cachedEvidenceStale: false, models: [], afhGrounding: { grounded: false } };
}

function snapshot() {
  return {
    providerStatuses: [
      row('openai', 'oauth'), row('openai', 'oauth-corp'),
      row('anthropic', 'oauth'), row('anthropic', 'oauth-corp'),
    ],
    reserveFloors: {
      'openai-oauth': floor(40), 'openai-oauth-corp': floor(80),
      'anthropic-oauth': floor(60), 'anthropic-oauth-corp': floor(70),
    },
    brokerAuth: { provider_states: {
      codex: { ready: true, can_serve: true }, 'codex-corp': { ready: true, can_serve: true },
      'claude-code': { ready: true, can_serve: true }, 'claude-code-corp': { ready: true, can_serve: true },
    } },
  };
}

test('current measurement shape is read as measured', () => {
  assert.deepEqual(reserveFloorWeeklyMeasurement(floor(12)), { status: 'measured', percentRemaining: 12 });
});

test('inferred or low-confidence measurement is not measured', () => {
  assert.equal(reserveFloorWeeklyMeasurement(floor(12, { inferred: true })).status, 'inferred');
  assert.notEqual(reserveFloorWeeklyMeasurement(floor(12, { confidence: 'low' })).status, 'measured');
});

test('legacy weeklyMeasurement shape is still honoured', () => {
  const legacy = { weeklyMeasurement: { status: 'measured', percentRemaining: 5 } };
  assert.deepEqual(reserveFloorWeeklyMeasurement(legacy), { status: 'measured', percentRemaining: 5 });
  assert.equal(reserveFloorWeeklyMeasurement(null), null);
  assert.equal(reserveFloorWeeklyMeasurement({}), null);
});

test('healthy accounts in the current shape are ready, not unknown', () => {
  assert.equal(selectCodexWorkerAccount(snapshot()).reason, 'codex-account-ready');
  assert.equal(selectCodexWorkerAccount(snapshot()).provider, 'codex');
  assert.equal(selectCodexReviewerAccount(snapshot()).provider, 'codex-corp');
  const claude = selectClaudeAccountLaneFromSnapshot(snapshot(), { workerClass: 'hammer-claude' });
  assert.equal(claude.hold, false);
});

test('Anthropic floors carry the current shape under weeklyMeasurement', () => {
  const anthropic = { weeklyMeasurement: { confidence: 'measured', inferred: false, percentRemaining: 68 },
    measurement: { confidence: 'measured', inferred: false, percentRemaining: 68 } };
  assert.deepEqual(reserveFloorWeeklyMeasurement(anthropic), { status: 'measured', percentRemaining: 68 });
  const stale = { weeklyMeasurement: { confidence: 'stale', inferred: false, percentRemaining: 0 } };
  assert.equal(reserveFloorWeeklyMeasurement(stale).status, 'stale');
});

test('OpenAI floors carry a null weeklyMeasurement and the reading under measurement', () => {
  const openai = { weeklyMeasurement: null, measurement: { confidence: 'measured', inferred: false, percentRemaining: 10 } };
  assert.deepEqual(reserveFloorWeeklyMeasurement(openai), { status: 'measured', percentRemaining: 10 });
});

test('a measured zero in the current shape still counts as exhausted', () => {
  const s = snapshot();
  s.reserveFloors['openai-oauth'] = floor(0);
  assert.equal(selectCodexWorkerAccount(s).provider, 'codex-corp');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveFloorWeeklyMeasurement } from '../src/fleet-quota-status.mjs';
import { selectCodexWorkerAccount, selectCodexReviewerAccount } from '../src/codex-account-routing.mjs';
import { selectClaudeAccountLaneFromSnapshot } from '../src/claude-account-routing.mjs';

// Legacy compatibility scenarios, not current producer captures. Current
// producer parity is exercised in producer-contract-readers.test.mjs.
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

test('legacy confidence measurement shape is read as measured', () => {
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

test('healthy accounts in the legacy shape remain ready', () => {
  assert.equal(selectCodexWorkerAccount(snapshot()).reason, 'codex-account-ready');
  assert.equal(selectCodexWorkerAccount(snapshot()).provider, 'codex-corp');
  assert.equal(selectCodexReviewerAccount(snapshot()).provider, 'codex-corp');
  const claude = selectClaudeAccountLaneFromSnapshot(snapshot(), { workerClass: 'hammer-claude' });
  assert.equal(claude.hold, false);
});

test('legacy Anthropic confidence shape under weeklyMeasurement remains readable', () => {
  const anthropic = { weeklyMeasurement: { confidence: 'measured', inferred: false, percentRemaining: 68 },
    measurement: { confidence: 'measured', inferred: false, percentRemaining: 68 } };
  assert.deepEqual(reserveFloorWeeklyMeasurement(anthropic), { status: 'measured', percentRemaining: 68 });
  const stale = { weeklyMeasurement: { confidence: 'stale', inferred: false, percentRemaining: 0 } };
  assert.equal(reserveFloorWeeklyMeasurement(stale).status, 'stale');
});

test('legacy OpenAI null weeklyMeasurement falls back to measurement', () => {
  const openai = { weeklyMeasurement: null, measurement: { confidence: 'measured', inferred: false, percentRemaining: 10 } };
  assert.deepEqual(reserveFloorWeeklyMeasurement(openai), { status: 'measured', percentRemaining: 10 });
});

test('a measured zero in the legacy shape still counts as exhausted', () => {
  const s = snapshot();
  s.reserveFloors['openai-oauth'] = floor(0);
  assert.equal(selectCodexWorkerAccount(s).provider, 'codex-corp');
});

for (const legacy of [false, true]) {
  const shape = legacy ? 'legacy status' : 'provider confidence';
  const reading = percentRemaining => legacy
    ? { status: 'measured', percentRemaining }
    : { confidence: 'measured', inferred: false, percentRemaining };

  test(`${shape}: missing and invalid percentages hold instead of exhausting or admitting accounts`, () => {
    for (const value of [null, undefined, false, true, '', '  ', 'invalid', Infinity, NaN, [], {}]) {
      assert.ok(Number.isNaN(reserveFloorWeeklyMeasurement({ weeklyMeasurement: reading(value) }).percentRemaining));
      const s = snapshot();
      s.reserveFloors['openai-oauth'] = { weeklyMeasurement: reading(value) };
      s.reserveFloors['openai-oauth-corp'] = { weeklyMeasurement: reading(value) };
      s.reserveFloors['anthropic-oauth-corp'] = { weeklyMeasurement: reading(value) };
      assert.equal(selectCodexWorkerAccount(s).reason, 'codex-account-evidence-unknown');
      assert.equal(selectCodexReviewerAccount(s).reason, 'codex-account-evidence-unknown');
      assert.equal(selectClaudeAccountLaneFromSnapshot(s, { workerClass: 'hammer-claude' }).reason,
        'claude-account-evidence-unknown');
    }
  });

  test(`${shape}: numeric strings admit accounts and string zero still proves exhaustion`, () => {
    for (const [value, expected] of [['50', 50], [' 50 ', 50], ['0', 0]]) {
      assert.equal(reserveFloorWeeklyMeasurement({ weeklyMeasurement: reading(value) }).percentRemaining, expected);
      const s = snapshot();
      s.reserveFloors['openai-oauth'] = { weeklyMeasurement: reading(value) };
      s.reserveFloors['openai-oauth-corp'] = { weeklyMeasurement: reading(value) };
      s.reserveFloors['anthropic-oauth-corp'] = { weeklyMeasurement: reading(value) };
      assert.equal(selectCodexWorkerAccount(s).hold, expected === 0);
      assert.equal(selectCodexReviewerAccount(s).hold, expected === 0);
      assert.equal(selectClaudeAccountLaneFromSnapshot(s, { workerClass: 'hammer-claude' }).provider,
        expected === 0 ? 'claude-code' : 'claude-code-corp');
    }
  });
}

test('unusable weekly readings fall back to the measured provider reading', () => {
  for (const weeklyMeasurement of [{}, { confidence: 'unknown' }, { status: 'stale' },
    { confidence: 'measured', percentRemaining: null }, { status: 'measured', percentRemaining: 'invalid' }]) {
    const s = snapshot();
    for (const policy of Object.values(s.reserveFloors)) policy.weeklyMeasurement = weeklyMeasurement;
    assert.deepEqual(reserveFloorWeeklyMeasurement(s.reserveFloors['openai-oauth']),
      { status: 'measured', percentRemaining: 40 });
    assert.equal(selectCodexWorkerAccount(s).provider, 'codex-corp');
    assert.equal(selectCodexReviewerAccount(s).provider, 'codex-corp');
    assert.equal(selectClaudeAccountLaneFromSnapshot(s, { workerClass: 'hammer-claude' }).provider, 'claude-code-corp');
  }
});

test('usable weekly readings retain precedence, including measured zero', () => {
  for (const percentRemaining of [0, 25]) {
    assert.deepEqual(reserveFloorWeeklyMeasurement({
      weeklyMeasurement: { confidence: 'measured', inferred: false, percentRemaining },
      measurement: { confidence: 'measured', percentRemaining: 90 },
    }), { status: 'measured', percentRemaining });
  }
  assert.deepEqual(reserveFloorWeeklyMeasurement({ weeklyMeasurement: { status: 'unknown' } }),
    { status: 'unknown', percentRemaining: NaN });
});

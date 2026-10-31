import './helpers/registry-session-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportedReserveFloors } from './helpers/reserve-floor-fixture.mjs';
import { personalClaudeReviewerFloor } from '../src/reviewer-reserve-floor.mjs';
import { afhGroundingSnapshotFromStdout, applyAfhReviewerFallback } from '../src/afh-reviewer-fallback.mjs';
import { createReviewerQuotaBlockLogger, REVIEWER_FLOOR_HOLD_SIGNAL_MS } from '../src/reviewer-quota-block-log.mjs';

const snapshot = scenario => ({
  providerStatuses: [{ provider: 'anthropic', authPath: 'oauth', state: 'ok' }],
  reserveFloors: exportedReserveFloors(scenario),
});

test('sustained floor holds emit one bounded health signal and recovery re-arms it', () => {
  let observedAt = 0;
  const signals = [];
  const log = createReviewerQuotaBlockLogger({ now: () => observedAt });
  const route = { quotaBlocked: true, quotaGrounding: {
    reviewer: 'claude', reason: 'primary-personal-anthropic-reserve-floor:no-eligible-reviewer',
  } };
  const observe = (prNumber = 1, selectedRoute = route) => log({
    repoPath: 'owner/repo', prNumber, route: selectedRoute,
    logger: { warn() {}, error: message => signals.push(message) },
  });
  observe();
  observedAt = REVIEWER_FLOOR_HOLD_SIGNAL_MS - 1;
  observe();
  assert.equal(signals.length, 0);
  observedAt++;
  observe();
  assert.equal(signals.length, 1);
  assert.match(signals[0], /SUSTAINED_HOLD.*pr=1.*heldMs=900000/);
  observedAt += REVIEWER_FLOOR_HOLD_SIGNAL_MS;
  observe();
  observe(2);
  assert.equal(signals.length, 1, 'deduplicated and each PR has its own hold clock');
  observe(1, { quotaBlocked: false });
  observe();
  observedAt += REVIEWER_FLOOR_HOLD_SIGNAL_MS;
  observe();
  observe(2);
  assert.equal(signals.length, 3, 'recovery and a distinct PR each permit a new signal');
  observe(1, { quotaBlocked: true, quotaGrounding: { reason: 'other-quota-hold' } });
  observedAt += REVIEWER_FLOOR_HOLD_SIGNAL_MS;
  observe(1, { quotaBlocked: true, quotaGrounding: { reason: 'other-quota-hold' } });
  assert.equal(signals.length, 3, 'unrelated quota holds do not emit floor signals');
});

test('public producer examples distinguish weekly reviewer policy from short-window dispatch holds', () => {
  const payload = snapshot('repaired-measured');
  const floor = payload.reserveFloors['anthropic-oauth'];
  assert.equal(floor.remainingPct, 10, 'projected threshold');
  assert.equal(floor.measurement.percentRemaining, 5, 'most constrained window');
  assert.equal(floor.weeklyMeasurement.percentRemaining, 75, 'independent weekly window');
  assert.equal(floor.active, true, 'producer holds dispatch on short-window evidence');
  assert.equal(personalClaudeReviewerFloor(payload), null, 'weekly reviewer policy is above its floor');
  for (const scenario of ['repaired-absent', 'repaired-disabled', 'repaired-expired',
    'repaired-five-hour-only', 'repaired-stale', 'repaired-unavailable']) {
    assert.equal(personalClaudeReviewerFloor(snapshot(scenario)), null, scenario);
  }
  // Mutations pin our additional weekly boundary; these are not producer verdicts.
  floor.remainingPct = 75;
  floor.protectedClasses = ['*reviewer*', 'hammer*'];
  assert.equal(personalClaudeReviewerFloor(payload).floorPct, 75);
  floor.weeklyMeasurement.percentRemaining = 74.99;
  assert.equal(personalClaudeReviewerFloor(payload).remainingPct, 74.99);
  floor.weeklyMeasurement.percentRemaining = 75.01;
  assert.equal(personalClaudeReviewerFloor(payload), null);
  assert.equal(personalClaudeReviewerFloor(payload, { workerClass: 'hammer-claude' }), null);
});

test('floor percentage changes preserve one quota deferral until recovery or another transition', () => {
  const payload = snapshot('repaired-measured');
  const floor = payload.reserveFloors['anthropic-oauth'];
  floor.remainingPct = 80;
  const messages = [];
  const log = createReviewerQuotaBlockLogger();
  const observe = remaining => {
    floor.weeklyMeasurement.percentRemaining = remaining;
    const route = applyAfhReviewerFallback({ builderClass: 'codex',
      baseRoute: { reviewerModel: 'claude' }, geminiReviewerMode: 'off',
      grounding: afhGroundingSnapshotFromStdout(JSON.stringify(payload)) });
    log({ repoPath: 'example/repo', prNumber: 1, route,
      logger: { warn: text => messages.push(text) } });
    return route;
  };
  assert.equal(observe(80).quotaBlocked, true);
  assert.equal(observe(79).quotaBlocked, true);
  assert.equal(observe(78).quotaGrounding.reason,
    'primary-personal-anthropic-reserve-floor:no-eligible-reviewer');
  assert.equal(messages.length, 1);
  assert.match(messages[0], /reserveFloor.remainingPct=80/);
  assert.match(messages[0], /reserveFloor.floorPct=80/);
  assert.notEqual(observe(81).quotaBlocked, true);
  assert.equal(observe(80).quotaBlocked, true);
  assert.equal(messages.length, 2, 'recovery re-arms transition logging');
});

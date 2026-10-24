import test from 'node:test';
import assert from 'node:assert/strict';
import { readFleetQuota } from '@agent-os/app-sdk';
import { readWeeklyOnlyReserveFloorEvidence } from '../src/fleet-quota-status.mjs';
import { selectCodexWorkerAccount, selectCodexReviewerAccount } from '../src/codex-account-routing.mjs';
import { selectClaudeAccountLaneFromSnapshot } from '../src/claude-account-routing.mjs';
import { codexAccountFixture } from './helpers/codex-account-fixture.mjs';
import { claudeAccountFixture } from './helpers/claude-account-fixture.mjs';
import { exportedReserveFloors } from './helpers/reserve-floor-fixture.mjs';

const cases = [
  ['measured', 'measured', null, 'weeklyMeasurement', true],
  ['disabled', 'disabled', null, 'weeklyMeasurement', true],
  ['absent', 'absent', null, null, false],
  ['short-only', 'five-hour-only', null, 'measurement', false],
  ['expired', 'expired', null, 'measurement', false],
  ['stale', 'stale', null, 'weeklyMeasurement', false],
  ['unavailable', 'unavailable', null, null, false],
  // Explicit negative/legacy mutations of public producer examples.
  ...[null, 'no-weekly-window', 'measurement-unavailable'].flatMap(reason => [
    [`negative null weekly, reason ${reason}`, 'disabled', f => { f.weeklyMeasurement = null; f.weeklyMeasurementReason = reason; }, 'measurement', false],
    [`negative missing weekly, reason ${reason}`, 'disabled', f => { delete f.weeklyMeasurement; f.weeklyMeasurementReason = reason; }, 'measurement', false],
  ]),
  ['legacy absent reason fallback', 'five-hour-only', f => { delete f.weeklyMeasurementReason; }, 'measurement', true],
  ['negative malformed weekly object', 'disabled', f => { f.weeklyMeasurement = []; }, 'weeklyMeasurement', false],
  ['negative wrong weekly type', 'disabled', f => { f.weeklyMeasurement = 'invalid'; }, null, false],
  ['negative unknown status', 'disabled', f => { f.weeklyMeasurement.status = 'future'; }, 'weeklyMeasurement', false],
  ['negative invalid percentage', 'disabled', f => { f.weeklyMeasurement.percentRemaining = false; }, 'weeklyMeasurement', false],
  ['negative missing percentage', 'disabled', f => { delete f.weeklyMeasurement.percentRemaining; }, 'weeklyMeasurement', false],
  ['negative out of range', 'disabled', f => { f.weeklyMeasurement.percentRemaining = 101; }, 'weeklyMeasurement', false],
  ['negative zero', 'disabled', f => { f.weeklyMeasurement.percentRemaining = 0; }, 'weeklyMeasurement', false],
  ['negative missing floor', 'disabled', null, null, false],
];

function snapshotFor(credential) {
  const codex = codexAccountFixture();
  const claude = claudeAccountFixture();
  const payload = { providerStatuses: [...codex.providerStatuses.filter(r => r.provider === 'openai'),
    ...claude.providerStatuses.filter(r => r.provider === 'anthropic')],
  reserveFloors: { ...codex.reserveFloors, ...claude.reserveFloors },
  brokerAuth: { provider_states: { ...codex.brokerAuth.provider_states, ...claude.brokerAuth.provider_states } } };
  const [provider, ...account] = credential.split('-');
  for (const row of payload.providerStatuses) {
    if (row.provider === provider && row.authPath !== account.join('-')) row.state = 'exhausted';
  }
  return payload;
}

function routes(payload, credential) {
  if (credential.startsWith('openai-')) return [selectCodexWorkerAccount(payload), selectCodexReviewerAccount(payload)];
  return [selectClaudeAccountLaneFromSnapshot(payload, { workerClass: 'hammer-claude' })];
}

for (const credential of Object.keys(exportedReserveFloors())) {
  for (const [label, scenario, mutate, source, admitted] of cases) {
    test(`${credential}: ${label} keeps SDK evidence separate from weekly admission`, () => {
      const payload = snapshotFor(credential);
      let floor = exportedReserveFloors(`repaired-${scenario}`)[credential];
      mutate?.(floor);
      if (label === 'negative missing floor') floor = undefined;
      if (floor === undefined) delete payload.reserveFloors[credential];
      else payload.reserveFloors[credential] = floor;
      const sdk = readFleetQuota(payload);
      assert.equal(sdk.reserveFloors[credential]?.source ?? null, source);
      assert.equal(sdk.payload.reserveFloors[credential], floor);
      assert.equal(Object.hasOwn(sdk.payload.reserveFloors[credential] || {}, 'weeklyMeasurementReason'),
        Object.hasOwn(floor || {}, 'weeklyMeasurementReason'));
      assert.equal(sdk.payload.reserveFloors[credential]?.weeklyMeasurementReason, floor?.weeklyMeasurementReason);
      const weekly = readWeeklyOnlyReserveFloorEvidence(floor, credential);
      assert.equal(weekly.weeklyMeasurementReason, floor?.weeklyMeasurementReason);
      assert.equal(weekly.source, weekly.measurement === null ? null : source);
      if (!admitted) assert.ok(weekly.diagnostics.some(d => d.includes('quota_reserve.snapshot') && d.includes(`reserveFloors.${credential}`)));
      const reserveHeld = credential === 'anthropic-oauth'
        && ['active', 'paused', 'nearCap'].some(key => floor?.[key] !== false);
      for (const route of routes(payload, credential)) {
        assert.equal(route.hold, !admitted || reserveHeld, JSON.stringify(route));
        if (!admitted || reserveHeld) assert.ok(route.diagnostics.some(d => d.includes('quota_reserve.snapshot') && d.includes(`reserveFloors.${credential}`)));
        else assert.equal(route.authPath, credential.slice(credential.indexOf('-') + 1));
      }
    });
  }
  test(`${credential}: healthy weekly evidence cannot bypass a stale account probe`, () => {
    const payload = snapshotFor(credential);
    const [provider, ...account] = credential.split('-');
    payload.providerStatuses.find(r => r.provider === provider && r.authPath === account.join('-')).cachedEvidenceStale = true;
    for (const route of routes(payload, credential)) {
      assert.equal(route.hold, true);
      assert.ok(route.diagnostics.some(d => d.includes('cwp_dispatch.cli_fleet') && d.includes('cachedEvidenceStale')));
    }
  });
}

test('shared account positives retain the exported floor exactly and isolate mutations', () => {
  const floors = exportedReserveFloors();
  assert.deepEqual(codexAccountFixture().reserveFloors, Object.fromEntries(Object.entries(floors).filter(([key]) => key.startsWith('openai-'))));
  assert.deepEqual(claudeAccountFixture().reserveFloors, Object.fromEntries(Object.entries(floors).filter(([key]) => key.startsWith('anthropic-'))));
  const mutated = codexAccountFixture();
  mutated.reserveFloors['openai-oauth'].weeklyMeasurement.percentRemaining = 0;
  assert.deepEqual(codexAccountFixture().reserveFloors['openai-oauth'], floors['openai-oauth']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  quotaStatusesFromSnapshot, harnessCapFromStatuses,
  providerAvailabilityFromStatuses, quotaAccountDiagnostics,
} from '../src/fleet-quota-status.mjs';
import { exhaustedCodexPlanRow } from './helpers/codex-plan-meter-fixture.mjs';

for (const [name, mutate, state] of [
  ['fresh future reset', () => {}, 'exhausted'],
  ['elapsed reset', row => { row.providerRateLimits[0].resetsAt = new Date(Date.now() - 1000).toISOString(); }, 'ok'],
  ['reset at observation time', row => { row.providerRateLimits[0].resetsAt = new Date(Date.now()).toISOString(); }, 'ok'],
  ['stale meter', row => { row.providerRateLimits[0].fresh = false; }, 'ok'],
  ['stale provider evidence', row => { row.cachedEvidenceStale = true; }, 'ok'],
  ['unknown reset', row => { row.providerRateLimits[0].resetsAt = 'unknown'; }, 'exhausted'],
  ['no reset', row => { delete row.providerRateLimits[0].resetsAt; }, 'exhausted'],
  ['below limit', row => { row.providerRateLimits[0].usedPercent = 99; }, 'ok'],
  ['invalid usage', row => { row.providerRateLimits[0].usedPercent = Infinity; }, 'ok'],
  ['other provider', row => { row.provider = 'anthropic'; }, 'ok'],
  ['other auth path', row => { row.authPath = 'api-key'; }, 'ok'],
]) {
  test(`Codex plan evidence: ${name}`, t => {
    const now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const row = exhaustedCodexPlanRow();
    mutate(row);
    const [status] = quotaStatusesFromSnapshot({ providerStatuses: [row] });
    assert.equal(status.state, state);
    assert.equal(row.state, 'ok', 'raw producer evidence stays intact');
  });
}

for (const [confidence, inferred, state] of [
  ['measured', false, 'exhausted'],
  ['measured', undefined, 'exhausted'],
  ['measured', true, 'ok'],
  ['estimated', false, 'ok'],
  [undefined, false, 'ok'],
]) {
  test(`Codex projected evidence confidence=${confidence}, inferred=${inferred}`, () => {
    const row = exhaustedCodexPlanRow('oauth-corp');
    row.estRemaining = { confidence, inferred, rateLimits: row.providerRateLimits };
    delete row.providerRateLimits;
    assert.equal(quotaStatusesFromSnapshot({ providerStatuses: [row] })[0].state, state);
  });
}

test('meter cap retains the latest exhausting reset and explains the override to every diagnostic reader', () => {
  const row = exhaustedCodexPlanRow();
  const resetAt = new Date(Date.now() + 172_800_000).toISOString();
  row.estRemaining = { confidence: 'measured', inferred: false, rateLimits: [
    { ...row.providerRateLimits[0], resetsAt: resetAt },
    { ...row.providerRateLimits[0], usedPercent: 10, resetsAt: new Date(Date.now() + 259_200_000).toISOString() },
  ] };
  row.models = [{ model: 'test-model', state: 'ok', resetAtUtc: new Date(Date.now() + 3600_000).toISOString() }];
  const payload = { providerStatuses: [row] };
  const statuses = quotaStatusesFromSnapshot(payload);
  assert.equal(statuses[0].stateSource, 'codex-plan-meter');
  assert.equal(statuses[0].resetAtUtc, resetAt);
  const cap = harnessCapFromStatuses(statuses, { harness: 'codex', model: 'test-model' });
  assert.equal(cap.capped, true);
  assert.equal(cap.resetAt, resetAt, 'model reset cannot shorten the account meter hold');
  assert.match(cap.diagnostic, /stateSource=codex-plan-meter/);
  assert.match(providerAvailabilityFromStatuses(statuses, { provider: 'openai' }).diagnostic, /stateSource=codex-plan-meter/);
  assert.ok(quotaAccountDiagnostics(payload, { provider: 'openai', authPath: 'oauth', cap })
    .some(message => message.includes('stateSource=codex-plan-meter')));
});

test('stale meter does not erase an authoritative exhausted producer state', () => {
  const row = exhaustedCodexPlanRow();
  row.state = 'exhausted';
  row.providerRateLimits[0].fresh = false;
  assert.equal(quotaStatusesFromSnapshot({ providerStatuses: [row] })[0].state, 'exhausted');
});

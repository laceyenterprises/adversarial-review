import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { generate } from './generate.mjs';
import { Clock, loadModel } from './clock.mjs';
import { invariants, violations } from './oracle.mjs';
import { healthyObservation, badPolicies } from './bad-policies.mjs';
import { library, report } from './report.mjs';
import { profiles, rowRecipes } from './recipes.mjs';
import { simulate } from './simulator.mjs';
import { fold, foldFrom } from '../../src/finalization/ledger-fold.mjs';

for (const invariant of invariants) {
  test(`known-bad policy is rejected: ${invariant}`, async () => {
    const clock = new Clock();
    const view = healthyObservation();
    assert.deepEqual(violations(view), []);
    clock.at(1, 'bad-policy', () => badPolicies[invariant](view));
    await clock.run(() => assert.deepEqual(violations(view), [invariant]));
  });
}
test('oracle rejects expired/multiple/wrong-head owners, missing pages and transient refusals', () => {
  for (const corrupt of [s => { s.deadline = 9; }, s => { s.owners.push(s.owners[0]); }, s => { s.owners[0].head = 'obsolete'; }]) {
    const view = healthyObservation(); corrupt(view); assert.ok(violations(view).includes('owner-deadline'));
  }
  const view = healthyObservation();
  view.terminal = 'escalated'; view.causes = ['cause-A'];
  assert.ok(violations(view).includes('page-once'));
  assert.ok(violations(view).includes('bounded-terminal'));
  view.pages = ['cause-A'];
  assert.deepEqual(violations(view), []);
  view.transientRefusals = 1;
  assert.deepEqual(violations(view), ['transient-retry']);
});
test('one page per cause, finalized requires authoritative effect and activation, comments need coverage', () => {
  const view = healthyObservation();
  view.causes = ['cause-A', 'cause-B']; view.pages = ['cause-A', 'cause-B'];
  assert.deepEqual(violations(view), []);
  view.terminal = 'finalized';
  assert.deepEqual(violations(view), ['bounded-terminal']);
  view.merges = [{ revision: view.head, liveHead: view.head, blocking: 0, comments: 1 }];
  assert.deepEqual(violations(view), ['addressed-findings']);
  view.merges[0].comments = 0; view.activation = false;
  assert.deepEqual(violations(view), ['bounded-terminal']);
});
test('load primitive scales deadlines once with a finite ceiling and deterministic inputs', () => {
  for (const factor of [1, 3, 6]) assert.equal(loadModel(factor).timeout(1000), factor * 1000);
  assert.throws(() => loadModel(7));
});
test('seeded event ordering is stable, latency and deadlines scale together', async () => {
  const scenario = { id: 'determinism', profile: 'slow-snapshot' };
  const first = await simulate(scenario, { seed: 92, load: 3 });
  assert.deepEqual(first, await simulate(scenario, { seed: 92, load: 3 }));
  assert.notDeepEqual(first.trace, (await simulate(scenario, { seed: 93, load: 3 })).trace);
  const at1 = (await simulate(scenario)).trace.find(t => t.label === 'snapshot:completed').at;
  const at6 = (await simulate(scenario, { load: 6 })).trace.find(t => t.label === 'snapshot:completed').at;
  assert.ok(Math.abs(at6 - at1 * 6) < 6);
});
test('generated library covers every row, nine named parked subjects, and all fault recipes', () => {
  assert.deepEqual(library.requirementIds.sort(), Object.keys(rowRecipes).sort());
  assert.equal(library.scenarios.filter(s => s.id.startsWith('SEV0-')).length, 9);
  assert.equal(new Set(library.scenarios.map(s => s.id)).size, library.scenarios.length);
  for (const id of library.requirementIds) assert.ok(library.scenarios.some(s => s.requirements.includes(id)));
  for (const profile of Object.keys(profiles).filter(p => p !== 'clean')) assert.ok(library.scenarios.some(s => s.profile === profile), profile);
  const source = JSON.stringify({ specRef: library.specRef,
    requirements: library.requirementIds.map(id => ({ id, scenarioId: id.replace('R-', 'S-') })), parkedPRs: [] });
  assert.deepEqual(generate(source).scenarios, library.scenarios.filter(s => !s.id.startsWith('SEV0-')));
  assert.throws(() => generate(JSON.stringify({ requirements: [{ id: 'R-999', scenarioId: 'S-999' }] })), /unmapped/);
});
test('parked PR generation requires a non-empty array of known requirement IDs', () => {
  const input = {
    requirements: [{ id: 'R-01', scenarioId: 'S-01' }],
    parkedPRs: [{ repo: 'adversarial-review', pr: 1774, requirementIds: ['R-01'] }],
  };
  assert.deepEqual(generate(JSON.stringify(input)).scenarios.at(-1), {
    id: 'SEV0-2026-11-02-adversarial-review-PR-1774', requirements: ['R-01'], profile: rowRecipes['R-01'][0],
  });
  for (const requirementIds of [[], undefined, null, 'R-01', {}]) {
    input.parkedPRs[0].requirementIds = requirementIds;
    assert.throws(() => generate(JSON.stringify(input)), {
      name: 'Error', message: 'parked PR 1774 requires a non-empty requirementIds array',
    });
  }
  input.parkedPRs[0].requirementIds = ['R-999'];
  assert.throws(() => generate(JSON.stringify(input)), /unknown parked requirement R-999/);
});
test('admission refusal does not spend work; read failures recover', async () => {
  const refusal = await simulate({ id: 'refusal', profile: 'clone-reserve' });
  assert.equal(refusal.transientCharges, 0);
  assert.deepEqual(refusal.failed, []);
  const read = await simulate({ id: 'read', profile: 'ledger-failure' });
  assert.ok(read.readFailed);
  assert.equal(read.transientCharges, 0);
  assert.equal(read.terminal, 'finalized');
});
test('crash after effect replays without a second merge; fold resume is byte-equivalent', async () => {
  const result = await simulate({ id: 'crash', profile: 'merge-crash' });
  assert.equal(result.merges.length, 1);
  assert.equal(result.terminal, 'finalized');
  for (let split = 0; split <= result.events.length; split++) {
    assert.deepEqual(foldFrom(fold(result.events.slice(0, split)), result.events.slice(split)), fold(result.events));
  }
});
test('stale review never merges, exhausted head move retains budget, live-owner race has one effect', async () => {
  const stale = await simulate({ id: 'stale', profile: 'stale-review' });
  assert.equal(stale.merges.length, 0);
  const moved = await simulate({ id: 'moved', profile: 'exhausted-head-move' });
  assert.equal(fold(moved.events).stages.review.budgetExhausted, true);
  assert.equal(moved.merges[0].revision, 'revision-B');
  const race = await simulate({ id: 'race', profile: 'racing-owners' });
  assert.equal(race.merges.length, 1);
  assert.ok(race.trace.some(t => t.label.includes('lease-contended')));
  const headRace = await simulate({ id: 'head-race', profile: 'decision-head-race' });
  assert.equal(headRace.merges.length, 1);
  assert.equal(headRace.merges[0].revision, 'revision-B');
  assert.ok(headRace.trace.some(t => t.label.includes('world-moved-before-merge')));
});
test('rollback transfers the same ledger and queue without losing budget or duplicating effects', async () => {
  const result = await simulate({ id: 'rollback', profile: 'rollback' });
  assert.deepEqual(result.rollbackReceipt.state, fold(result.rollbackReceipt.events));
  assert.equal(result.rollbackReceipt.state.stages.review.budgetExhausted, true);
  assert.equal(result.rollbackReceipt.state.finalized, null, 'adopt before finalization');
  assert.equal(result.rollbackReceipt.pending.kind, 'wait', 'adopt with remediation in flight');
  assert.equal(result.rollbackReceipt.queue.entries['synthetic-entry'].budget.spent, 1);
  assert.equal(result.merges.length, 1);
  assert.equal(result.terminal, 'finalized');
});
test('label presence alone never creates an operator override and explicit hold prevents effects', async () => {
  const label = await simulate({ id: 'label', profile: 'unobserved-waiver' });
  assert.equal(label.events.some(e => e.type === 'operator_override'), false);
  assert.ok(label.events.some(e => e.type === 'remediation_dispatched'));
  const hold = await simulate({ id: 'hold', profile: 'operator-hold' });
  assert.equal(hold.merges.length, 0);
  assert.equal(hold.launches.length, 0);
});
test('the full MLR-05 library passes at load x1, x3 and x6; retain the original baseline', async () => {
  const baseline = JSON.parse(readFileSync(new URL('./baseline.json', import.meta.url), 'utf8'));
  assert.ok(baseline.rows.some(row => row.failed.length));
  const current = await report();
  assert.equal(current.requirementsSha256, baseline.requirementsSha256);
  assert.deepEqual(current.rows.map(r => [r.id, r.load]), baseline.rows.map(r => [r.id, r.load]));
  assert.deepEqual(current.rows.filter(row => row.failed.length || row.unmet.length), []);
});

test('all generated scenarios retain the invariants across twenty scheduling seeds at each load', async () => {
  for (const scenario of library.scenarios) for (const load of [1, 3, 6]) for (let seed = 1; seed <= 20; seed++) {
    const result = await simulate(scenario, { load, seed });
    assert.deepEqual(result.failed, [], `${scenario.id} load=${load} seed=${seed}`);
    assert.deepEqual(result.unmet, [], `${scenario.id} load=${load} seed=${seed}`);
  }
});

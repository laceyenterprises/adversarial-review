import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { checkMap, diagrams, stateProjection } from './helpers/smv-contracts.mjs';
const root = new URL('../', import.meta.url);
const read = file => readFileSync(new URL(file, root), 'utf8');
const map = JSON.parse(read('state-machines.json'));
const GRAPH_HASH = '6acff15affebff43e8aba6e5e55a0f8f7a344dc52e2faf020c87f4bb925835a7'; // Independent reviewed snapshot; not generated at test time.
test('SMV independent graph, producer state and transition drift', () => {
  checkMap(map, read, GRAPH_HASH);
  assert.equal(read('README.md').split('<!-- smv:diagrams:start -->\n')[1].split('\n<!-- smv:diagrams:end -->')[0], diagrams(map));
});
for (const [name, before, after] of [
  ['state', "SET review_status = 'reviewing'", "SET review_status = 'invented'"],
  ['edge', "review_status IN ('pending', 'pending-upstream')", "review_status IN ('posted', 'pending-upstream')"],
]) test(`SMV mutation proves ${name} drift detection on production source`, () => {
  assert.ok(read('src/review-state-statements.mjs').includes(before));
  assert.throws(() => checkMap(map, file => file === 'src/review-state-statements.mjs' ? read(file).replace(before, after) : read(file), GRAPH_HASH), /source drift/);
  const mutated = structuredClone(map);
  if (name === 'state') mutated.objects[0].states[0].terminal = true;
  else mutated.objects[0].transitions[0].to = 'posted';
  assert.throws(() => checkMap(mutated, read, GRAPH_HASH), /graph changed/);
});
test('SMV detects imported state constant drift', () => {
  assert.throws(() => checkMap(map, file => file === 'src/review-statuses.mjs' ? read(file).replace('ci-blocked', 'invented') : read(file), GRAPH_HASH), /source drift/);
});
test('SMV transition projection distinguishes opposite guard branches', () => {
  assert.notEqual(stateProjection("if (ready) { row.status = 'dispatched'; }"), stateProjection("if (ready) {} else { row.status = 'dispatched'; }"));
});
test('SMV ignores unrelated source comments', () => {
  checkMap(map, file => read(file) + '\n// unrelated documentation edit\n', GRAPH_HASH);
});
test('SMV refuses host mode inside a worker even with approval', () => {
  const result = spawnSync(process.execPath, [new URL('../bin/smv-smoke.mjs', import.meta.url).pathname], {
    env: { ...process.env, SMV_COMMIT: 'synthetic-test', SMV_MODE: 'host', SMV_HOST_CANARY_APPROVED: '1', HQ_WORKER_ID: 'synthetic-worker' },
    encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(report.verdict, 'fail');
  assert.ok(report.steps.every(s => /SRE approval/.test(s.evidence.error)));
});
test('SMV declaration references README promises and exact graph edges', () => {
  const doc = JSON.parse(read('post-merge-verify.json'));
  for (const deadEnd of map.knownDeadEnds) {
    assert.equal(deadEnd.enforcement, 'missing');
    assert.ok(deadEnd.proposedExitOwner && deadEnd.proposedMaxDurationSeconds > 0 && deadEnd.overdueRecipient);
  }
  assert.equal(doc.version, 1); assert.equal(doc.onFailure, 'page');
  assert.ok(doc.totalBudgetSeconds <= 180);
  assert.ok(doc.steps.reduce((sum, step) => sum + step.budgetSeconds, 0) <= doc.totalBudgetSeconds);
  const edges = new Set(map.objects.flatMap(o => o.transitions.map(e => e.id)));
  for (const step of doc.steps) {
    assert.ok(read('README.md').includes(`id="${step.promise}"`));
    assert.ok(step.edges.length && step.edges.every(e => edges.has(e)));
    assert.deepEqual(step.acceptance, { verdict: 'pass', evidenceRequired: true });
  }
});
test('SMV canonical sandbox smoke merges only disposable Git', () => {
  const result = spawnSync(process.execPath, [new URL('../bin/smv-smoke.mjs', import.meta.url).pathname], { env: { ...process.env, SMV_COMMIT: 'synthetic-test', SMV_MODE: 'sandbox' }, encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const lines = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  const report = lines.at(-1);
  assert.equal(lines.length, 5); assert.equal(report.verdict, 'pass'); assert.equal(report.mode, 'sandbox');
  assert.ok(report.durationSeconds > 0 && report.durationSeconds <= 180);
  assert.ok(report.steps.every(s => s.evidence.ok && s.verdict === 'pass'));
});

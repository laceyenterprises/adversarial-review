import './helpers/dispatch-read-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkHammerEditPlan, HAMMER_EDIT_PLAN_ERROR_ORIGINS, hammerEditPlanError } from '../src/ama/hammer-edit-plan.mjs';
import { main, editPlanExitCode } from '../bin/hammer-edit-plan.mjs';
import { amaAllAuthoritativeReviewerLogins } from '../src/ama/reviewer-authority.mjs';

const head = 'a'.repeat(40);
const review = { commit_id: head, state: 'CHANGES_REQUESTED',
  user: { login: amaAllAuthoritativeReviewerLogins()[0] },
  body: `## Blocking issues
- **Required correction**
  - **File:** \`src/example.mjs\`
  - **Lines:** 2-4
  - **Problem:** Synthetic correction.
## Non-blocking issues
- **Suggested correction**
  - **File:** \`test/example.mjs\`
  - **Lines:** 7
  - **Problem:** Synthetic suggestion.
## Verdict
Request changes
` };
const plan = { reviewedHead: head, kind: 'blocking', findingNumber: 1,
  editKind: 'author-lines', path: 'src/example.mjs', startLine: 2, endLine: 4 };
const cases = [
  ['run-pin-invalid', 'evidence', null], // CLI-only pin validation
  ['review-missing', 'evidence', () => checkHammerEditPlan(null, plan)],
  ['review-head-mismatch', 'evidence', () => checkHammerEditPlan({ ...review, commit_id: 'b'.repeat(40) }, plan)],
  ['reviewer-untrusted', 'evidence', () => checkHammerEditPlan({ ...review, user: {} }, plan)],
  ['review-state-invalid', 'evidence', () => checkHammerEditPlan({ ...review, state: 'PENDING' }, plan)],
  ['finding-evidence-invalid', 'evidence', () => checkHammerEditPlan({ ...review, body: '' }, plan)],
  ['finding-kind-not-authorizing', 'evidence', null],
  ['finding-not-found', 'plan', null], // defensive shared reversal predicate outcome
  ['finding-lines-unreadable', 'evidence', () => checkHammerEditPlan({ ...review,
    body: review.body.replace('2-4', 'unknown') }, plan)],
  ['finding-lines-invalid', 'evidence', () => checkHammerEditPlan({ ...review,
    body: review.body.replace('2-4', '0-4') }, plan)],
  ['plan-json-invalid', 'plan', () => checkHammerEditPlan(review, undefined, { planParseError: true })],
  ['plan-invalid', 'plan', () => checkHammerEditPlan(review, [])],
  ['plan-head-invalid', 'plan', () => checkHammerEditPlan(review, { ...plan, reviewedHead: 'invalid' })],
  ['finding-citation-invalid', 'plan', () => checkHammerEditPlan(review, { ...plan, findingNumber: 99 })],
  ['edit-kind-invalid', 'plan', () => checkHammerEditPlan(review, { ...plan, editKind: 'unknown' })],
  ['edit-location-invalid', 'plan', () => checkHammerEditPlan(review, { ...plan, startLine: 0 })],
  ['not-covered-by-cited-finding', 'plan', () => checkHammerEditPlan(review, { ...plan, endLine: 5 })],
];

test('every registered error has an explicit origin and expected stop/correct contract', () => {
  assert.deepEqual(Object.keys(HAMMER_EDIT_PLAN_ERROR_ORIGINS).sort(), cases.map(([reason]) => reason).sort());
  for (const [reason, origin, invoke] of cases) {
    assert.equal(HAMMER_EDIT_PLAN_ERROR_ORIGINS[reason], origin);
    const result = invoke ? invoke() : hammerEditPlanError(reason);
    assert.equal(result.reason === 'review-evidence-invalid' ? result.diagnostic : result.reason.split(':')[0], reason);
    assert.equal(result.action, origin === 'plan' ? 'correct' : 'stop', reason);
    assert.equal(editPlanExitCode(result), origin === 'plan' ? 21 : 1, reason);
  }
  for (const unknown of ['new-error', 'toString', '__proto__']) {
    assert.throws(() => hammerEditPlanError(unknown), /Unknown hammer edit-plan error/);
  }
});

function assertCorrection(result) {
  assert.equal(result.action, 'correct');
  assert.equal(editPlanExitCode(result), 21);
  assert.match(result.message, /blocking#1: Required correction \(src\/example.mjs:2-4\)/);
  assert.match(result.message, /non-blocking#1: Suggested correction \(test\/example.mjs:7\)/);
  assert.match(result.message, /one object per invocation; for several edits, invoke the helper once per finding/);
}

test('CLI corrects syntax, all non-object shapes and invalid citations with findings and field feedback', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hameditplan05-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const planFile = join(rootDir, 'plan.json');
  const dependencies = { rootDir, env: { HAM_REVIEWED_SHA: head },
    readReviewImpl: async () => review, loadPolicy: () => ({}),
    captureImpl: () => assert.fail('correction cannot capture backlog') };
  for (const [input, reason, field] of [
    ['{', 'plan-json-invalid', /PLAN_JSON/],
    ...[null, [], [plan, plan], 'text', 1, true].map(value => [JSON.stringify(value), 'plan-invalid', /PLAN_JSON/]),
    ...[{ kind: undefined }, { kind: 'advisory' }, { findingNumber: undefined },
      { findingNumber: 0 }, { findingNumber: '1' }, { findingNumber: 2 }]
      .map(fields => [JSON.stringify({ ...plan, ...fields }), 'finding-citation-invalid', /kind and findingNumber/]),
  ]) {
    writeFileSync(planFile, input);
    const result = await main(['sample/service', '7', '1', planFile], dependencies);
    assertCorrection(result);
    assert.equal(result.reason, reason);
    assert.match(result.message, field);
    assert.equal(readFileSync(planFile, 'utf8'), input);
  }
  writeFileSync(planFile, '{');
  for (const candidate of [null, { ...review, commit_id: 'b'.repeat(40) }, { ...review, user: {} }, { ...review, state: 'PENDING' }, { ...review, body: '' }]) {
    assert.equal((await main(['sample/service', '7', '1', planFile], {
      ...dependencies, readReviewImpl: async () => candidate,
    })).action, 'stop');
  }
  assert.equal((await main(['sample/service', '7', '1', planFile], {
    ...dependencies, env: {}, readReviewImpl: () => assert.fail('invalid pin must precede reads'),
  })).diagnostic, 'run-pin-invalid');
});

test('two different plan errors consume one shared correction and then stop without editing', t => {
  const template = readFileSync(new URL('../templates/hammer-prompt.md', import.meta.url), 'utf8');
  const block = template.match(/```bash\n(HAM_EDIT_CORRECTION_FILE=[\s\S]+?)\n```/)[1];
  const runDir = mkdtempSync(join(tmpdir(), 'hameditplan05-budget-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const executable = block.replaceAll('<<RUN_DIR>>', runDir)
    .replace(/\/usr\/bin\/perl[^\n]+\n[^\n]+/, 'mock_check || HAM_EDIT_RC=$?');
  const results = [checkHammerEditPlan(review, []), checkHammerEditPlan(review, { ...plan, findingNumber: 99 })];
  for (const [index, result] of results.entries()) {
    const script = `mock_check() { echo '${JSON.stringify(result)}'; return ${editPlanExitCode(result)}; }\n${executable}\necho EDIT`;
    const child = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, index === 0 ? 21 : 1, child.stderr);
    assert.match(child.stdout, new RegExp(result.reason));
    assert.doesNotMatch(child.stdout, /^EDIT$/m);
  }
});

import './helpers/dispatch-read-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkHammerEditPlan } from '../src/ama/hammer-edit-plan.mjs';
import { main, editPlanExitCode } from '../bin/hammer-edit-plan.mjs';
import { amaAllAuthoritativeReviewerLogins } from '../src/ama/reviewer-authority.mjs';

const template = readFileSync(new URL('../templates/hammer-prompt.md', import.meta.url), 'utf8');
const examples = [...template.matchAll(/```json\n([^`]+)\n```/g)]
  .map(match => JSON.parse(match[1])).filter(plan => plan.reviewedHead);
const ci = examples.find(plan => plan.requiredCiRepair);
const review = { commit_id: 'a'.repeat(40), state: 'CHANGES_REQUESTED',
  user: { login: amaAllAuthoritativeReviewerLogins()[0] },
  body: `## Blocking issues
- **Required correction**
  - **File:** \`src/example.mjs\`
  - **Lines:** 2
  - **Problem:** Required correction.
## Non-blocking issues
- **Suggested correction**
  - **File:** \`src/example.mjs\`
  - **Lines:** 2
  - **Problem:** Suggested correction.
## Verdict
Request changes
` };

test('all four literal template shapes pass with applicable review evidence', () => {
  assert.equal(examples.length, 4);
  assert.equal(Object.hasOwn(ci, 'kind'), false);
  assert.equal(Object.hasOwn(ci, 'findingNumber'), false);
  for (const plan of examples) {
    assert.equal(checkHammerEditPlan(review, plan, { strictNonBlockingRemediation: true }).action, 'allow');
  }
  const empty = { ...review, body: '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nComment only' };
  assert.equal(checkHammerEditPlan(empty, ci).action, 'allow');
});

test('CI citation fields and malformed locations refuse correctably without granting an edit', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hameditplan-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const planFile = join(rootDir, 'plan.json');
  for (const fields of [{ kind: 'blocking' }, { findingNumber: 1 },
    { kind: 'non-blocking', findingNumber: 1 }, { path: '' }, { startLine: 0 }, { endLine: undefined }]) {
    writeFileSync(planFile, JSON.stringify({ ...ci, ...fields }));
    const result = await main(['sample/service', '7', '1', planFile], {
      rootDir, readReviewImpl: async () => review,
      loadPolicy: () => ({ strictNonBlockingRemediation: true }),
      captureImpl: () => assert.fail('shape refusal must not capture a finding'),
    });
    assert.equal(result.action, 'correct');
    assert.equal(editPlanExitCode(result), 21);
    assert.match(result.message, /Do not edit\. Correct the plan once:/);
  }
  assert.equal(checkHammerEditPlan(review, { ...ci, editKind: 'unknown', kind: 'blocking', findingNumber: 1 }).action, 'correct');
});

test('policy and evidence refusals keep their terminal and deferral exits', () => {
  const blocking = examples[0], advisory = examples[3];
  for (const [candidate, plan, reason] of [
    [{ ...review, commit_id: 'b'.repeat(40) }, ci, 'review-evidence-invalid'],
    [{ ...review, user: { login: 'synthetic-author' } }, ci, 'review-evidence-invalid'],
    [review, { ...blocking, findingNumber: 99 }, 'finding-evidence-invalid'],
    [review, { ...blocking, endLine: 3 }, 'not-covered-by-cited-finding'],
    [review, { ...blocking, path: 'src/other.mjs' }, 'not-covered-by-cited-finding'],
    [review, { ...advisory, editKind: 'in-place' }, 'edit-kind-invalid'],
    [{ ...review, body: review.body.replace('**Lines:** 2', '**Lines:** unknown') }, blocking, 'finding-lines-unreadable: \"unknown\"'],
  ]) {
    const result = checkHammerEditPlan(candidate, plan, { strictNonBlockingRemediation: true });
    assert.deepEqual(result, { action: 'stop', reason });
    assert.equal(editPlanExitCode(result), 1);
  }
  assert.equal(editPlanExitCode(checkHammerEditPlan(review, advisory)), 20);
  assert.equal(editPlanExitCode(checkHammerEditPlan(review, ci)), 0);
});

test('template procedure permits one shape correction and never continues past a terminal refusal', t => {
  const block = template.match(/```bash\n(HAM_EDIT_CORRECTION_FILE=[\s\S]+?)\n```/)[1];
  const executable = block.replace(/\/usr\/bin\/perl[^\n]+\n[^\n]+/, 'mock_check || HAM_EDIT_RC=$?');
  for (const [codes, expectedExit, expectedCalls] of [
    [[21, 0], 0, 2], [[21, 21], 21, 2], [[1, 0], 1, 1], [[20], 0, 1], [[78], 78, 1],
  ]) {
    const runDir = mkdtempSync(join(tmpdir(), 'hameditplan-shell-'));
    t.after(() => rmSync(runDir, { recursive: true, force: true }));
    const runnable = executable.replaceAll('<<RUN_DIR>>', runDir);
    const script = `calls=0\nmock_check() { calls=$((calls + 1)); echo called; case "$calls" in\n`
      + codes.map((code, i) => `${i + 1}) return ${code};;`).join('\n')
      + `\nesac; }\n${runnable}\nif [ "$HAM_EDIT_RC" = 21 ]; then\n${runnable}\nfi\n`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, expectedExit, result.stderr);
    assert.equal(result.stdout.trim().split('\n').length, expectedCalls);
  }
});

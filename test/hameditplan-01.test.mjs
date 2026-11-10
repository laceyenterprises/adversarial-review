import './helpers/dispatch-read-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkHammerEditPlan } from '../src/ama/hammer-edit-plan.mjs';
import { main, editPlanExitCode, EDIT_PLAN_USAGE } from '../bin/hammer-edit-plan.mjs';
import { amaAllAuthoritativeReviewerLogins } from '../src/ama/reviewer-authority.mjs';

const template = readFileSync(new URL('../templates/hammer-prompt.md', import.meta.url), 'utf8');
const examples = [...template.matchAll(/```json\n([^`]+)\n```/g)]
  .map(match => JSON.parse(match[1])).filter(plan => plan.editKind);
const ci = { ...examples.find(plan => plan.requiredCiRepair), reviewedHead: 'd'.repeat(40) };
const review = { commit_id: 'd'.repeat(40), state: 'CHANGES_REQUESTED',
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

test('all four literal template shapes pass through the CLI with applicable review evidence', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hameditplan-examples-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const planFile = join(rootDir, 'plan.json');
  assert.equal(examples.length, 4);
  assert.equal(Object.hasOwn(ci, 'kind'), false);
  assert.equal(Object.hasOwn(ci, 'findingNumber'), false);
  for (const plan of examples) {
    assert.equal(Object.hasOwn(plan, 'reviewedHead'), false);
    writeFileSync(planFile, JSON.stringify(plan));
    assert.equal((await main(['sample/service', '7', '1', planFile, '--reviewed-head', review.commit_id], {
      rootDir, env: {}, readReviewImpl: async () => review,
      loadPolicy: () => ({ strictNonBlockingRemediation: true }),
    })).action, 'allow');
    assert.equal(checkHammerEditPlan(review, { ...plan, reviewedHead: review.commit_id },
      { strictNonBlockingRemediation: true }).action, 'allow');
  }
  const empty = { ...review, body: '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nComment only' };
  assert.equal(checkHammerEditPlan(empty, ci).action, 'allow');
});

test('CLI help exposes complete plan shapes offline and the prompt routes to it', () => {
  const result = spawnSync(process.execPath, [new URL('../bin/hammer-edit-plan.mjs', import.meta.url).pathname, '--help'], {
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, EDIT_PLAN_USAGE);
  assert.match(template, /ham_read edit-plan-usage .*hammer-edit-plan\.mjs" --help/);
});

test('CI citation fields and malformed locations refuse correctably without granting an edit', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hameditplan-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const planFile = join(rootDir, 'plan.json');
  for (const fields of [{ kind: 'blocking', findingNumber: 1 },
    { editKind: 'author-lines' }, { editKind: 'additive' }, { editKind: 'in_place' }, { editKind: undefined },
    { path: '' }, { startLine: 0 }, { endLine: undefined }]) {
    writeFileSync(planFile, JSON.stringify({ ...ci, ...fields }));
    const result = await main(['sample/service', '7', '1', planFile], {
      rootDir, env: { HAM_REVIEWED_SHA: review.commit_id }, readReviewImpl: async () => review,
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
  const blocking = { ...examples[0], reviewedHead: review.commit_id };
  const advisory = { ...examples[3], reviewedHead: review.commit_id };
  for (const [candidate, plan, reason, diagnostic] of [
    [{ ...review, commit_id: 'b'.repeat(40) }, ci, 'review-evidence-invalid', 'review-head-mismatch'],
    [{ ...review, user: { login: 'synthetic-author' } }, ci, 'review-evidence-invalid', 'reviewer-untrusted'],
    [review, { ...blocking, findingNumber: 99 }, 'finding-evidence-invalid'],
    [{ ...review, body: review.body.replace('**Lines:** 2', '**Lines:** unknown') }, blocking, 'finding-lines-unreadable: \"unknown\"'],
  ]) {
    const result = checkHammerEditPlan(candidate, plan, { strictNonBlockingRemediation: true });
    assert.deepEqual(result, { action: 'stop', reason, ...(diagnostic ? { diagnostic } : {}) });
    assert.equal(editPlanExitCode(result), 1);
  }
  assert.equal(editPlanExitCode(checkHammerEditPlan(review, advisory)), 20);
  assert.equal(editPlanExitCode(checkHammerEditPlan(review, ci)), 0);
});

test('non-blocking in-place plans correct to additive without granting in-place permission', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hameditplan-non-blocking-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const planFile = join(rootDir, 'plan.json');
  const message = 'correctable: allowed editKinds for kind=non-blocking are additive|author-lines (author-lines only where checkReversalFinding authorizes)';
  const nonBlocking = { ...examples[3], reviewedHead: review.commit_id, editKind: 'in-place' };
  for (const strictNonBlockingRemediation of [false, true]) {
    const dependencies = {
      rootDir, env: { HAM_REVIEWED_SHA: review.commit_id }, readReviewImpl: async () => review,
      loadPolicy: () => ({ strictNonBlockingRemediation }),
      captureImpl: () => assert.fail('a shape correction must not defer a finding'),
    };
    for (const requiredCiRepair of [undefined, false, true]) {
      for (const findingNumber of [undefined, 1]) {
        const plan = { ...nonBlocking, requiredCiRepair, findingNumber };
        writeFileSync(planFile, JSON.stringify(plan));
        const result = await main(['sample/service', '7', '1', planFile], dependencies);
        assert.deepEqual(result, checkHammerEditPlan(review, plan, { strictNonBlockingRemediation }));
        if (findingNumber === undefined) {
          assert.deepEqual(result, { action: 'stop', reason: 'finding-evidence-invalid' });
          assert.equal(editPlanExitCode(result), 1);
        } else {
          assert.deepEqual(result, { action: 'correct', reason: 'edit-kind-invalid', message });
          assert.equal(editPlanExitCode(result), 21);
        }
      }
    }
    writeFileSync(planFile, JSON.stringify({ ...nonBlocking, editKind: 'additive' }));
    const additive = await main(['sample/service', '7', '1', planFile], dependencies);
    assert.deepEqual(additive, { action: 'allow', reason: 'additive-fix' });
    assert.equal(editPlanExitCode(additive), 0);

    for (const allowed of [ci, { ...nonBlocking, kind: 'blocking' }]) {
      const result = checkHammerEditPlan(review, allowed, { strictNonBlockingRemediation });
      assert.deepEqual(result, { action: 'allow', reason: 'in-place-repair' });
      assert.equal(editPlanExitCode(result), 0);
    }
    const unauthorized = checkHammerEditPlan({
      ...review, body: review.body.replace('**Lines:** 2', '**Lines:** unknown'),
    }, { ...nonBlocking, kind: 'blocking' }, { strictNonBlockingRemediation });
    assert.equal(unauthorized.action, 'stop');
  }
  assert.match(template, /Non-blocking in-place: on 21 re-plan as `additive`/);
});

test('cited CI plans retain policy refusals and backlog capture through main', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hameditplan-policy-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const planFile = join(rootDir, 'plan.json');
  for (const [candidate, fields, action] of [
    [review, { kind: 'non-blocking', findingNumber: 1, editKind: 'author-lines' }, 'defer'],
    [{ ...review, body: review.body.replace('**Lines:** 2', '**Lines:** unknown') },
      { kind: 'blocking', findingNumber: 1 }, 'stop'],
    [review, { kind: 'blocking' }, 'stop'],
    [review, { findingNumber: 1 }, 'stop'],
  ]) {
    writeFileSync(planFile, JSON.stringify({ ...ci, ...fields }));
    const captures = [];
    const result = await main(['sample/service', '7', '1', planFile], {
      rootDir, env: { HAM_REVIEWED_SHA: review.commit_id }, readReviewImpl: async () => candidate,
      loadPolicy: () => ({ strictNonBlockingRemediation: false }),
      assertOwner: () => {}, captureImpl: capture => captures.push(capture),
    });
    assert.equal(result.action, action);
    assert.equal(editPlanExitCode(result), action === 'defer' ? 20 : 1);
    assert.equal(captures.length, action === 'defer' ? 1 : 0);
    if (action === 'defer') assert.equal(captures[0].deferredFinding.findingNumber, 1);
    else if (fields.findingNumber && fields.kind) assert.match(result.reason, /finding-lines-unreadable/);
  }
  const corrected = checkHammerEditPlan(review, { ...ci, kind: 'blocking', findingNumber: 1 });
  assert.equal(corrected.action, 'correct');
  assert.match(corrected.message, /retain kind and findingNumber/);
  assert.equal(checkHammerEditPlan(review, { ...ci, kind: 'blocking', findingNumber: 1,
    requiredCiRepair: undefined }).action, 'allow');
});

test('template itself exits without editing on first and repeated shape refusals', t => {
  const block = template.match(/```bash\n(HAM_EDIT_CORRECTION_FILE=[\s\S]+?)\n```/)[1];
  const executable = block.replace(/\/usr\/bin\/perl[^\n]+\n[^\n]+/, 'mock_check || HAM_EDIT_RC=$?');
  for (const [codes, expectedExits] of [
    [[21, 0], [21, 0]], [[21, 21], [21, 1]], [[1], [1]], [[20], [20]], [[78], [78]],
  ]) {
    const runDir = mkdtempSync(join(tmpdir(), 'hameditplan-shell-'));
    t.after(() => rmSync(runDir, { recursive: true, force: true }));
    const runnable = executable.replaceAll('<<RUN_DIR>>', runDir);
    for (const [i, code] of codes.entries()) {
      const script = `mock_check() { return ${code}; }\n${runnable}\nif [ "$HAM_EDIT_RC" = 0 ]; then echo EDIT; fi\n`;
      const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, expectedExits[i], result.stderr);
      assert.equal(result.stdout.includes('\nEDIT') || result.stdout.startsWith('EDIT'), code === 0);
      if (code === 21) assert.match(result.stdout, /NO EDIT:/);
    }
  }
});

test('cited plans reject the CI-only flag for every edit kind', () => {
  for (const editKind of ['author-lines', 'additive', 'in-place']) {
    const result = checkHammerEditPlan(review, { ...examples[0], reviewedHead: review.commit_id,
      editKind, requiredCiRepair: true });
    assert.equal(result.action, 'correct');
    assert.equal(editPlanExitCode(result), 21);
    assert.match(result.message, /without requiredCiRepair; retain kind and findingNumber/);
  }
  for (const editKind of ['author-lines', 'additive', 'unknown', undefined]) {
    const result = checkHammerEditPlan(review, { ...ci, editKind });
    assert.equal(result.action, 'correct');
    assert.match(result.message, /must be in-place for uncited CI repairs/);
  }
});

test('CLI fills absent or unusable plan heads from the run pin without rewriting the plan file', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hameditplan-pin-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const planFile = join(rootDir, 'plan.json');
  for (const reviewedHead of [undefined, null, false, 42, {}, [], '', '  ', review.commit_id]) {
    const input = JSON.stringify({ ...ci, reviewedHead });
    writeFileSync(planFile, input);
    for (const explicit of [false, true]) {
      const result = await main(['sample/service', '7', '1', planFile,
        ...(explicit ? ['--reviewed-head', review.commit_id] : [])], {
        rootDir, env: explicit ? {} : { HAM_REVIEWED_SHA: review.commit_id },
        readReviewImpl: async () => review, loadPolicy: () => ({}),
        captureImpl: () => assert.fail('an allowed CI repair must not capture findings'),
      });
      assert.equal(result.action, 'allow');
      assert.equal(editPlanExitCode(result), 0);
      assert.equal(readFileSync(planFile, 'utf8'), input);
    }
  }
});

test('CLI rejects malformed or mismatched review heads and missing pins and retains review authority checks', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hameditplan-evidence-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const planFile = join(rootDir, 'plan.json');
  for (const [pin, reviewedHead, candidate] of [
    [review.commit_id, 'b'.repeat(40), review],
    [review.commit_id.toUpperCase(), 'B'.repeat(40), review],
    [review.commit_id, 'invalid', review],
    [review.commit_id, 'd'.repeat(39), review],
    [review.commit_id, 'd'.repeat(41), review],
    [review.commit_id, 'G'.repeat(40), review],
    ['D'.repeat(39), null, review],
    ['D'.repeat(41), null, review],
    ['G'.repeat(40), null, review],
    [review.commit_id, ` ${review.commit_id}`, review],
    [undefined, review.commit_id, review],
    ['', review.commit_id, review],
    ['invalid', review.commit_id, review],
    [review.commit_id, null, { ...review, commit_id: 'b'.repeat(40) }],
    [review.commit_id, null, { ...review, user: { login: 'synthetic-author' } }],
    [review.commit_id, null, { ...review, state: 'PENDING' }],
    // A valid head matching neither the pin nor the fetched review cannot authorize edits.
    ['b'.repeat(40), 'c'.repeat(40), review],
  ]) {
    writeFileSync(planFile, JSON.stringify({ ...ci, reviewedHead }));
    const result = await main(['sample/service', '7', '1', planFile], {
      rootDir, env: { HAM_REVIEWED_SHA: pin }, readReviewImpl: async () => candidate,
      loadPolicy: () => ({}), captureImpl: () => assert.fail('invalid evidence must not capture'),
    });
    assert.equal(result.action, 'stop');
    assert.equal(result.reason, 'review-evidence-invalid');
    assert.equal(typeof result.diagnostic, 'string');
    assert.equal(editPlanExitCode(result), 1);
  }
});

test('CLI allows cross-head citations only when the plan matches the fetched review', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hameditplan-cross-head-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const planFile = join(rootDir, 'plan.json');
  for (const explicit of [false, true]) {
    for (const reviewedHead of [review.commit_id, review.commit_id.toUpperCase()]) {
      const input = JSON.stringify({ ...examples[0], reviewedHead });
      writeFileSync(planFile, input);
      const result = await main(['sample/service', '7', '1', planFile,
        ...(explicit ? ['--reviewed-head', 'b'.repeat(40)] : [])], {
        rootDir, env: explicit ? {} : { HAM_REVIEWED_SHA: 'b'.repeat(40) },
        readReviewImpl: async () => review, loadPolicy: () => ({}),
        captureImpl: () => assert.fail('an allowed cross-head citation must not capture findings'),
      });
      assert.deepEqual(result, { action: 'allow', reason: 'finding-authorizes-planned-region' });
      assert.equal(editPlanExitCode(result), 0);
      assert.equal(readFileSync(planFile, 'utf8'), input);
    }
  }
});

test('CLI refuses missing or invalid pins before reading or parsing a plan', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hameditplan-pin-first-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const malformedPlan = join(rootDir, 'malformed.json');
  writeFileSync(malformedPlan, '{');
  const forbidden = () => assert.fail('invalid pins must stop before review or policy reads');
  for (const planFile of [join(rootDir, 'missing.json'), malformedPlan, rootDir]) {
    for (const pin of [undefined, '', 'invalid', 'd'.repeat(39), 'g'.repeat(40)]) {
      for (const explicit of [false, true]) {
        if (explicit && pin === undefined) continue;
        const result = await main(['sample/service', '7', '1', planFile,
          ...(explicit ? ['--reviewed-head', pin] : [])], {
          env: { HAM_REVIEWED_SHA: explicit ? review.commit_id : pin },
          readReviewImpl: forbidden, loadPolicy: forbidden, captureImpl: forbidden,
        });
        assert.deepEqual(result, { action: 'stop', reason: 'review-evidence-invalid', diagnostic: 'run-pin-invalid' });
        assert.equal(editPlanExitCode(result), 1);
      }
    }
  }
});

test('CLI accepts equivalent hash casing from either pin source without rewriting the plan', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hameditplan-case-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const planFile = join(rootDir, 'plan.json');
  for (const pin of [review.commit_id, review.commit_id.toUpperCase()]) {
    for (const reviewedHead of [undefined, review.commit_id, review.commit_id.toUpperCase()]) {
      const input = JSON.stringify({ ...ci, reviewedHead });
      writeFileSync(planFile, input);
      for (const explicit of [false, true]) {
        const result = await main(['sample/service', '7', '1', planFile,
          ...(explicit ? ['--reviewed-head', pin] : [])], {
          rootDir, env: explicit ? {} : { HAM_REVIEWED_SHA: pin },
          readReviewImpl: async () => review, loadPolicy: () => ({}),
          captureImpl: () => assert.fail('an allowed CI repair must not capture findings'),
        });
        assert.equal(result.action, 'allow');
        assert.equal(readFileSync(planFile, 'utf8'), input);
      }
    }
  }
});

test('help exits successfully and prints plan shapes without reading review, policy or plan', async () => {
  const forbidden = () => assert.fail('help must have no plan-check side effects');
  assert.equal(editPlanExitCode({ action: 'help' }), 1);
  for (const flag of ['--help', '-h']) {
    await assert.rejects(main([flag], {
      readReviewImpl: forbidden, loadPolicy: forbidden, captureImpl: forbidden, assertOwner: forbidden,
      env: {},
    }), /usage:/);
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/hammer-edit-plan.mjs', import.meta.url)), flag], {
      encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, '');
    assert.equal(child.stdout, EDIT_PLAN_USAGE);
    assert.match(child.stdout, /usage: hammer-edit-plan\.mjs/);
    for (const shape of ['Blocking reversal:', 'Uncited CI repair:', 'Additive fix:', 'Strict non-blocking fix:']) {
      assert.ok(child.stdout.includes(shape));
    }
    const shapes = [...child.stdout.matchAll(/^\{.+\}$/gm)].map(match => JSON.parse(match[0]));
    assert.equal(shapes.length, 4);
    assert.deepEqual(shapes, examples);
    for (const plan of shapes) {
      assert.equal(checkHammerEditPlan(review, { ...plan, reviewedHead: review.commit_id },
        { strictNonBlockingRemediation: true }).action, 'allow');
    }
  }
  await assert.rejects(main([]), /usage:/);
});

import './helpers/dispatch-read-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, editPlanExitCode } from '../bin/hammer-edit-plan.mjs';
import { checkHammerEditPlan } from '../src/ama/hammer-edit-plan.mjs';
import { amaAllAuthoritativeReviewerLogins } from '../src/ama/reviewer-authority.mjs';

const head = 'a'.repeat(40);
const review = {
  commit_id: head, state: 'CHANGES_REQUESTED',
  user: { login: amaAllAuthoritativeReviewerLogins()[0] },
  body: `## Blocking issues
- **Required correction**
  - **File:** \`src/example.mjs\`
  - **Lines:** 2-4, 8; src/other.mjs:10-12
  - **Problem:** Correct the synthetic example.
- **Separate correction**
  - **File:** \`src/example.mjs\`
  - **Lines:** 5-7
  - **Problem:** Correct a separate region.
## Non-blocking issues
- **Suggested correction**
  - **File:** \`src/example.mjs\`
  - **Lines:** 2-4, 8; src/other.mjs:10-12
  - **Problem:** Simplify the synthetic example.
## Verdict
Request changes
`,
};
const plan = { reviewedHead: head, kind: 'blocking', findingNumber: 1,
  editKind: 'author-lines', path: 'src/example.mjs', startLine: 5, endLine: 7 };
const citedRanges = 'src/example.mjs:2-4, src/example.mjs:8-8, src/other.mjs:10-12';

test('CLI corrects only uncovered author-lines and allows within-range or additive re-planning', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hameditplan04-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const planFile = join(rootDir, 'plan.json');
  for (const kind of ['blocking', 'non-blocking']) {
    const dependencies = {
      rootDir, env: { HAM_REVIEWED_SHA: head }, readReviewImpl: async () => review,
      loadPolicy: () => ({ strictNonBlockingRemediation: true }),
      captureImpl: () => assert.fail('range correction must not capture findings'),
    };
    for (const region of [
      { path: 'src/example.mjs', startLine: 5, endLine: 7 }, // Covered by a different finding.
      { path: 'src/example.mjs', startLine: 2, endLine: 8 }, // Spans gaps.
      { path: 'src/example.mjs', startLine: 1, endLine: 2 },
      { path: 'src/example.mjs', startLine: 4, endLine: 5 },
      { path: 'src/example.mjs', startLine: 10, endLine: 12 }, // Another path's range.
      { path: 'src/uncited.mjs', startLine: 2, endLine: 4 },
    ]) {
      const candidate = { ...plan, kind, ...region };
      const input = JSON.stringify(candidate);
      writeFileSync(planFile, input);
      const result = await main(['sample/service', '7', '1', planFile], dependencies);
      assert.equal(result.action, 'correct');
      assert.equal(result.reason, 'not-covered-by-cited-finding');
      assert.ok(result.message.startsWith(`correctable: plan region ${region.path}:${region.startLine}-${region.endLine} is outside the cited finding's ranges ${citedRanges}; re-plan within a cited range, or as editKind=additive if no existing author line is removed or replaced`));
      assert.equal(editPlanExitCode(result), 21);
      assert.equal(readFileSync(planFile, 'utf8'), input);
    }
    for (const corrected of [
      { ...plan, kind, startLine: 2, endLine: 4 },
      { ...plan, kind, startLine: 8, endLine: 8 },
      { ...plan, kind, path: 'src/other.mjs', startLine: 10, endLine: 12 },
      { reviewedHead: head, kind, findingNumber: 1, editKind: 'additive' },
    ]) {
      writeFileSync(planFile, JSON.stringify(corrected));
      const result = await main(['sample/service', '7', '1', planFile], dependencies);
      assert.equal(result.action, 'allow');
      assert.equal(editPlanExitCode(result), 0);
    }
  }
});

test('out-of-range author-lines never allow across policy, citation, CI flag and authority variants', () => {
  for (const strictNonBlockingRemediation of [false, true]) {
    for (const kind of ['blocking', 'non-blocking', 'unknown', undefined]) {
      for (const findingNumber of [1, 99, undefined]) {
        for (const requiredCiRepair of [false, true, undefined]) {
          for (const candidateReview of [review,
            { ...review, user: { login: 'synthetic-author' } },
            { ...review, commit_id: 'b'.repeat(40) },
            { ...review, body: review.body.replaceAll('2-4, 8; src/other.mjs:10-12', 'unknown') },
          ]) {
            const result = checkHammerEditPlan(candidateReview,
              { ...plan, kind, findingNumber, requiredCiRepair }, { strictNonBlockingRemediation });
            assert.notEqual(result.action, 'allow');
            if (candidateReview.commit_id !== head || candidateReview.user !== review.user) {
              assert.equal(result.action, 'stop');
            } else if (kind === undefined && findingNumber === undefined && requiredCiRepair === true) {
              assert.equal(result.action, 'correct');
              assert.equal(result.reason, 'edit-kind-invalid');
            } else if (kind === 'unknown' || kind === undefined || findingNumber !== 1) {
              assert.equal(result.action, 'correct');
            } else if (kind === 'non-blocking' && !strictNonBlockingRemediation) {
              assert.equal(result.action, 'defer');
            } else if (candidateReview !== review) {
              assert.equal(result.action, 'stop');
            } else {
              assert.equal(result.action, 'correct');
              assert.equal(result.reason, requiredCiRepair ? 'edit-kind-invalid' : 'not-covered-by-cited-finding');
            }
          }
        }
      }
    }
  }
});

test('hammer retains its one-correction budget for outside-range plans', () => {
  const template = readFileSync(new URL('../templates/hammer-prompt.md', import.meta.url), 'utf8');
  assert.match(template, /Out-of-range: on 21 use a cited range or `additive` preserving author lines/);
  assert.match(template, /Second refusal exits 1\. Never retry policy refusals/);
});

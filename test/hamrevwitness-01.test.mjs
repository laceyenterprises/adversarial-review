import './helpers/dispatch-read-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, editPlanExitCode } from '../bin/hammer-edit-plan.mjs';
import { checkHammerEditPlan, HAMMER_REVIEW_EVIDENCE_DIAGNOSTICS,
  refuseHammerReviewEvidence } from '../src/ama/hammer-edit-plan.mjs';
import { parseReviewFindings } from '../src/kernel/review-findings.mjs';
import { findingLocations } from '../src/kernel/finding-lines.mjs';
import { normalizeEffectiveReviewVerdict } from '../src/kernel/verdict.mjs';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/hamrevwitness-01/${name}.json`, import.meta.url)));
const review = fixture('review');
const normalized = fixture('findings');
const candidateHead = '783bb8ab21a11381aaefea05a91d03ea20a1383e';
const reviewedHead = '89d3e4316d09c584b193a1357a7b4e33e0140311';
const plan = { kind: 'non-blocking', findingNumber: 1, editKind: 'additive' };
const refused = diagnostic => ({ action: 'stop', reason: 'review-evidence-invalid', diagnostic });

// Pin authority and coordinates without coupling this RCA to prose normalization.
const findingEvidence = parsed => ({
  verdict_inconsistent: parsed.verdict_inconsistent,
  findingsCount: parsed.findingsCount,
  ...Object.fromEntries(['blocking', 'nonBlocking'].map(kind => {
    const { count, state, malformed, findings } = parsed[kind];
    return [kind, { count, state, ...(malformed === undefined ? {} : { malformed }),
      findings: findings.map(({ title, file, lines }) => ({ title, file, lines })) }];
  })),
});

test('exact posted review retains all six advisory identities, including two demotions', () => {
  assert.equal(review.id, 5835410207);
  assert.equal(review.commit_id, reviewedHead);
  assert.equal(review.user.login, 'lacey-claude-reviewer[bot]');
  assert.equal(review.state, 'CHANGES_REQUESTED');
  assert.deepEqual(findingEvidence(parseReviewFindings(review.body)), normalized);
  assert.equal(normalized.nonBlocking.count, 6);
  assert.equal(normalized.blocking.count, 0);
  // Preserve the independent fail-closed verdict-consistency classifier.
  assert.equal(normalized.blocking.state, 'unknown');
  assert.equal(normalized.blocking.malformed, 'verdict-inconsistent');
  assert.equal(normalizeEffectiveReviewVerdict(review.body), 'request-changes');
  assert.deepEqual(normalized.nonBlocking.findings.map(f => /demoted|insufficient blocking evidence/.test(f.title)),
    [false, false, false, false, true, true]);
  assert.equal((review.body.match(/demoted from blocking/g) || []).length, 2);
});

test('refusal helper enforces its frozen value-free diagnostic allow-list', () => {
  assert.equal(Object.isFrozen(HAMMER_REVIEW_EVIDENCE_DIAGNOSTICS), true);
  assert.deepEqual(HAMMER_REVIEW_EVIDENCE_DIAGNOSTICS, [
    'run-pin-invalid', 'plan-invalid', 'plan-head-invalid', 'review-missing',
    'review-head-mismatch', 'reviewer-untrusted', 'review-state-invalid',
  ]);
  for (const diagnostic of HAMMER_REVIEW_EVIDENCE_DIAGNOSTICS) {
    assert.deepEqual(refuseHammerReviewEvidence(diagnostic), refused(diagnostic));
  }
  for (const diagnostic of ['review-head-mismatched', 'private-review-body', '', undefined, null,
    { toString: () => 'review-missing' }]) {
    assert.throws(() => refuseHammerReviewEvidence(diagnostic), {
      name: 'TypeError', message: 'Unknown hammer review evidence diagnostic',
    });
  }
});

test('candidate pin reproduces exact-head refusal; explicit review witness passes without rewriting input', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hamrevwitness-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const planFile = join(rootDir, 'plan.json');
  const dependencies = {
    rootDir, env: { HAM_REVIEWED_SHA: candidateHead },
    readReviewImpl: async (repo, pr, id) => {
      assert.deepEqual([repo, pr, id], ['laceyenterprises/agent-os', '10491', String(review.id)]);
      return structuredClone(review);
    },
    loadPolicy: () => ({ strictNonBlockingRemediation: true }),
    captureImpl: () => assert.fail('no backlog write'),
    assertOwner: () => assert.fail('no ownership mutation'),
  };
  for (const explicitPin of [false, true]) {
    for (const head of [undefined, candidateHead, reviewedHead]) {
      const input = JSON.stringify({ ...plan, reviewedHead: head });
      writeFileSync(planFile, input);
      const result = await main(['laceyenterprises/agent-os', '10491', String(review.id), planFile,
        ...(explicitPin ? ['--reviewed-head', candidateHead] : [])], dependencies);
      assert.deepEqual(result, head === reviewedHead
        ? { action: 'allow', reason: 'additive-fix' } : refused('review-head-mismatch'));
      assert.equal(editPlanExitCode(result), head === reviewedHead ? 0 : 1);
      assert.equal(readFileSync(planFile, 'utf8'), input);
    }
  }
});

test('ordinary and demoted advisory citations retain strict policy and reviewed coordinates', () => {
  for (const [index, finding] of normalized.nonBlocking.findings.entries()) {
    const location = findingLocations(finding.file, finding.lines)[0];
    assert.ok(location, finding.title);
    const cited = { ...plan, reviewedHead, findingNumber: index + 1, editKind: 'author-lines',
      path: location.path, startLine: location.ranges[0].start, endLine: location.ranges[0].end };
    assert.equal(checkHammerEditPlan(review, cited, { strictNonBlockingRemediation: true }).action, 'allow');
    assert.deepEqual(checkHammerEditPlan(review, cited, { strictNonBlockingRemediation: false }),
      { action: 'defer', reason: 'finding-kind-not-authorizing' });
    assert.equal(checkHammerEditPlan(review, { ...cited, startLine: 1, endLine: 1 },
      { strictNonBlockingRemediation: true }).action, 'correct');
    // Demotion never creates a blocking citation under the same ordinal.
    assert.deepEqual(checkHammerEditPlan(review, { ...cited, kind: 'blocking' }),
      { action: 'stop', reason: 'finding-evidence-invalid' });
  }
});

test('first-failure diagnostics are finite, value-free and never authorize malformed evidence', async t => {
  const valid = { ...plan, reviewedHead };
  for (const [inputReview, inputPlan, diagnostic] of [
    [null, valid, 'review-missing'],
    [review, null, 'plan-invalid'],
    [review, [], 'plan-invalid'],
    [review, { ...valid, reviewedHead: 'private-invalid-head' }, 'plan-head-invalid'],
    [review, { ...valid, reviewedHead: candidateHead }, 'review-head-mismatch'],
    [{ ...review, commit_id: null }, valid, 'review-head-mismatch'],
    [{ ...review, user: { login: 'untrusted-private-login' } }, valid, 'reviewer-untrusted'],
    [{ ...review, user: null }, valid, 'reviewer-untrusted'],
    [{ ...review, state: 'private-invalid-state' }, valid, 'review-state-invalid'],
  ]) {
    const result = checkHammerEditPlan(inputReview, inputPlan);
    assert.deepEqual(result, refused(diagnostic));
    assert.equal(editPlanExitCode(result), 1);
    assert.ok(JSON.stringify(result).length < 110);
    assert.doesNotMatch(JSON.stringify(result), /private|783bb8|89d3e4/);
  }
  for (const fields of [
    { kind: 'advisory' }, { kind: 'blocking' }, { findingNumber: 0 },
    { findingNumber: '1' }, { findingNumber: 7 }, { findingNumber: 1.5 },
  ]) {
    assert.deepEqual(checkHammerEditPlan(review, { ...valid, ...fields }),
      { action: 'stop', reason: 'finding-evidence-invalid' });
  }
  assert.deepEqual(checkHammerEditPlan({ ...review, body: '' }, valid),
    { action: 'stop', reason: 'finding-evidence-invalid' });

  const rootDir = mkdtempSync(join(tmpdir(), 'hamrevwitness-invalid-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const planFile = join(rootDir, 'plan.json');
  const forbidden = () => assert.fail('invalid local evidence must precede external reads');
  for (const [pin, input, diagnostic] of [
    ['private-pin', valid, 'run-pin-invalid'],
    [candidateHead, null, 'plan-invalid'],
    [candidateHead, [], 'plan-invalid'],
    [candidateHead, { ...valid, reviewedHead: 'private-head' }, 'plan-head-invalid'],
  ]) {
    writeFileSync(planFile, JSON.stringify(input));
    assert.deepEqual(await main(['laceyenterprises/agent-os', '10491', String(review.id), planFile], {
      env: { HAM_REVIEWED_SHA: pin }, readReviewImpl: forbidden, loadPolicy: forbidden, captureImpl: forbidden,
    }), refused(diagnostic));
  }
});

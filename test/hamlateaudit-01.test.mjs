import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalReviewProofMatches } from '../src/ama/reviewer-authority.mjs';
import { evaluateMergeEligibility } from '../src/ama/merge-eligibility.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { primaryChangeFixture } from './helpers/primary-change.mjs';
import { resolveHamTerminalRemediationEvidence } from '../src/ama/dispatch-closer.mjs';
import { __test__ as githubApi } from '../src/github-api.mjs';

// Incident facts from the dispatch; bodies are synthetic, not a live PR read.
const OLD = 'a757cb4904c5' + '0'.repeat(28);
const HEAD = '54c42505f6244bb789a6694437112ea262a9ce18';
const OTHER = 'f'.repeat(40);
const AUDIT_AT = '2026-11-07T01:27:18Z';
const body = finding => `## Blocking Issues\n- None.\n\n## Non-blocking Issues\n${finding || '- None.'}\n\n## Verdict\nComment only`;
const old = { node_id: 'PRR_kwDORuLkis8AAAABWptG8A', commit_id: OLD,
  user: { login: 'lacey-gemini-reviewer[bot]' }, state: 'COMMENTED',
  submitted_at: '2026-11-07T01:20:00Z', body: body() };
const late = { ...old, node_id: 'PRR_kwDORuLkis8AAAABWqhqTA', commit_id: HEAD,
  submitted_at: '2026-11-07T01:32:13Z',
  body: body('- **Eyebrow color changed.** Restore the original artwork color.') };
const compare = async (from, to) => {
  assert.equal(to, HEAD);
  return { status: from === OLD ? 'ahead' : from === OTHER ? 'diverged' : 'identical' };
};
const proof = reviews => terminalReviewProofMatches({ reviews, headSha: HEAD, validatedAt: AUDIT_AT, compare });
const gate = terminalReviewProof => evaluateMergeEligibility({
  terminalReviewProof, verdict: 'ham_terminal_remediation_validated', leaseHeld: true,
  requiredChecks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  branchProtectionRequired: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  prState: 'OPEN', labels: [], candidateHead: HEAD, validatedHead: HEAD,
});

test('HAMLATEAUDIT-01: late exact-head artwork finding invalidates old terminal proof despite green CI and held lease', async () => {
  assert.equal(gate(await proof([old])).eligible, true);
  const changed = await proof([old, late]);
  assert.deepEqual(changed, { ok: false, reason: 'review-changed-since-validation',
    reviewId: late.node_id, family: 'gemini' });
  assert.deepEqual(gate(changed).reasons, ['review-changed-since-validation']);
});

test('same-head repeat with identical body preserves proof; changed detail at equal count does not', async () => {
  const initial = { ...old, commit_id: HEAD };
  assert.equal((await proof([initial, { ...late, body: initial.body }])).ok, true);
  const findingBefore = { ...initial, body: late.body };
  assert.equal((await proof([findingBefore, { ...late,
    body: late.body.replace('original artwork color', 'original eyebrow shape') }])).ok, false);
});

test('inapplicable reviews preserve terminal proof under canonical author, state and ancestry rules', async () => {
  for (const ignored of [
    { ...late, user: { login: 'untrusted-reviewer' } },
    { ...late, state: 'PENDING' },
    { ...late, commit_id: OTHER },
  ]) assert.equal((await proof([old, ignored])).ok, true);
});

test('canonical families retain independent findings and input order is chronological', async () => {
  const otherFamily = { ...late, user: { login: 'lacey-codex-reviewer' } };
  assert.equal((await proof([otherFamily, old, { ...late, body: body() }])).ok, false);
  assert.equal((await proof([late, old])).ok, false);
});

test('a fresh audit can consider the new review; unknown evidence never grants authority', async () => {
  assert.equal((await terminalReviewProofMatches({ reviews: [old, late], headSha: HEAD,
    validatedAt: '2026-11-07T01:40:00Z', compare })).ok, true);
  assert.equal((await terminalReviewProofMatches({ reviews: [old], headSha: HEAD, compare })).ok, false);
  assert.equal((await proof([old, { ...late, submitted_at: AUDIT_AT }])).ok, false);
  assert.equal((await proof([old, { ...late, submitted_at: null }])).reason, 'terminal-review-evidence-unavailable');
  for (const options of [
    { compare: async () => { throw new Error('compare 404'); } },
    { currency: async () => ({ current: false }), compare },
    { currency: async () => { throw new Error('currency unavailable'); }, compare },
    { compare, reviews: [{ ...old, commit_id: undefined }] },
  ]) {
    assert.deepEqual(await terminalReviewProofMatches({ reviews: [old], headSha: HEAD,
      validatedAt: AUDIT_AT, ...options }),
    { ok: false, reason: 'terminal-review-evidence-unavailable' });
  }
});

test('proof reads each ancestry/currency pair once per invocation and refreshes on the next gate', async () => {
  let comparisons = 0, currencies = 0;
  const options = { reviews: [old, { ...late, commit_id: OTHER }], headSha: HEAD,
    validatedAt: AUDIT_AT,
    compare: async (...args) => { comparisons++; return compare(...args); },
    currency: async (from) => { currencies++; return { current: from === OLD }; },
  };
  assert.equal((await terminalReviewProofMatches(options)).ok, true);
  assert.equal(comparisons, 1);
  assert.equal(currencies, 2);
  assert.equal((await terminalReviewProofMatches(options)).ok, true);
  assert.equal(comparisons, 2);
  assert.equal(currencies, 4);
});

test('shared terminal evidence resolver consumes production-normalized review heads and classifies missing proof', async () => {
  for (const [reviews, expected] of [
    [[{ ...old, commit_id: HEAD }], null],
    [[{ ...old, commit_id: HEAD }, late], 'review-changed-since-validation'],
    [[{ ...old, commit_id: null }], 'terminal-review-evidence-unavailable'],
  ]) {
    const result = await resolveHamTerminalRemediationEvidence({
      reviewState: { headSha: OLD }, prMetadata: { headSha: HEAD },
      repoPath: 'example/repo', prNumber: 54,
      fetchHeadCloserVerifiedCommitImpl: async () => ({ sha: HEAD, parentSha: OLD,
        trailers: {}, changedFiles: [], primaryChange: primaryChangeFixture(HEAD) }),
      fetchPullRequestRollupImpl: async () => ({
        reviews: reviews.map(review => githubApi.normalizeReview({
          id: review.node_id, author: review.user, commit: { oid: review.commit_id },
          state: review.state, body: review.body, submittedAt: review.submitted_at,
        })),
        comments: [{ author: 'the-hammer-lacey[bot]', createdAt: AUDIT_AT,
          body: `<!-- hq:ham-terminal-remediation:audit -->\nHAM-Base-Head: ${OLD}\nHAM-Validated-Head: ${HEAD}` }],
      }),
      execFileImpl: async () => { throw new Error('unexpected network read'); },
    });
    const proof = result.hamTerminalRemediationGroundTruth.terminalReviewProof;
    assert.equal(proof.ok, expected === null);
    assert.equal(proof.reason || null, expected);
  }
});

test('rendered final GitHub gate fetches reviews and rejects the race after an earlier eligible predicate', () => {
  const root = new URL('../', import.meta.url);
  const script = readFileSync(new URL('bin/hammer-merge.sh', root), 'utf8');
  const gateCode = script.match(/<<'NODE' > "\$HAM_GATE_JSON"\n([\s\S]*?)\nNODE/)[1];
  const fixtureDir = mkdtempSync(join(tmpdir(), 'hamlateaudit-'));
  try {
    const verdictFile = join(fixtureDir, 'verdict.json');
    writeFileSync(verdictFile, JSON.stringify({ eligible: true, trace: {
      headMatch: { current: HEAD },
      hamTerminalRemediation: { ok: true, auditComment: { createdAt: AUDIT_AT } },
    } }));
    for (const [reviews, expected, unavailable] of [
      [[old], true, false], [[old, late], false, false], [[old], false, true],
    ]) {
      // Execute the actual gate's JS with only I/O replaced. The currency and
      // merge predicates remain production code; no GitHub credentials/network.
      const code = `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { terminalReviewProofMatches } from ${JSON.stringify(new URL('src/ama/reviewer-authority.mjs', root).href)};
import { createReviewCurrencyReader } from ${JSON.stringify(new URL('src/ama/review-currency.mjs', root).href)};
import { evaluateMergeEligibility } from ${JSON.stringify(new URL('src/ama/merge-eligibility.mjs', root).href)};
import { classifyCheckRollup, latestCheckRollupItems } from ${JSON.stringify(new URL('src/checks-summary.mjs', root).href)};
const fetchHammerPr = async (_repo, _pr, options) => {
  assert.equal(options.withReviews({ checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }], state: 'OPEN', headSha: ${JSON.stringify(HEAD)} }), true);
  return { headSha: ${JSON.stringify(HEAD)}, state: 'OPEN', mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN', labels: [], reviews: ${JSON.stringify(reviews)},
    checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
};
const createHistoryReader = () => async path => {
  if (path.includes('/compare/')) {
    if (${unavailable}) throw new Error('compare 404');
    return { status: 'ahead' };
  }
  throw new Error('unexpected offline read: ' + path);
};
const loadEffectiveMergeAuthorityConfig = () => ({});
const fetchPrimaryChange = async () => (${JSON.stringify(primaryChangeFixture(HEAD))});
const checkPrimaryChange = () => ({ ok: true });
${gateCode.replace(/^import .*;\n/gm, '').replaceAll('<<REPO>>', 'example/repo').replaceAll('<<PR_NUMBER>>', '54')}`;
      const result = spawnSync(process.execPath, ['--input-type=module'], {
        input: code, encoding: 'utf8', timeout: 15000,
        env: { ...process.env, POST_REMEDIATION_SHA: HEAD, HAM_REVIEW_PROOF_REQUIRED: '1',
          HAM_REVIEW_VERDICT_FILE: verdictFile, HAM_BRANCH_PROTECTION_REQUIRED: 'false' },
      });
      assert.equal(result.status, 0, result.stderr);
      const gateResult = JSON.parse(result.stdout);
      assert.equal(gateResult.ok, expected, result.stdout);
      if (!expected) assert.ok(gateResult.reasons.includes(unavailable
        ? 'terminal-review-evidence-unavailable' : 'review-changed-since-validation'));
    }
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

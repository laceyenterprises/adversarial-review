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
import { closerReviewProof, readCloserReviewProof } from '../src/ama/closer-review-proof.mjs';
import { legacyLaneWriteMain } from '../bin/legacy-lane-write.mjs';
import { runLegacyLaneWrite } from '../src/finalization/legacy-lane-write.mjs';
import { routeFinalizationWriter } from '../src/finalization/queue-routing-boundary.mjs';
import { retryableAmaCloserDeferralOutcome, AMA_CLOSER_RETRYABLE_DEFERRAL_REASONS } from '../src/ama/closer-lease.mjs';

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
const operatorReview = {
  id: 500, state: 'CHANGES_REQUESTED', commit_id: HEAD, submitted_at: '2026-11-07T01:32:13Z',
  author_association: 'CONTRIBUTOR', user: { login: 'fixture-operator', type: 'User' }, body: 'Correct the regression.',
};
async function getReviewEvidence(path) {
  if (path.endsWith('/collaborators/fixture-operator/permission')) return { permission: 'admin' };
  if (path.includes('/compare/')) return { status: 'ahead' };
  throw new Error(`Unexpected read ${path}`);
}
const snapshot = (reviews, headSha = HEAD) => ({ state: 'OPEN', headSha, reviews });
const reviewIdentity = { repo: 'example/repo', prNumber: 54, headSha: HEAD, validatedAt: AUDIT_AT };
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
  assert.equal((await proof([initial, { ...late, state: 'CHANGES_REQUESTED', body: initial.body }])).ok, false);
});

test('closer honors standing exact-head operator requests, including those submitted before the audit', async () => {
  for (const submitted_at of [operatorReview.submitted_at, '2026-11-07T01:25:00Z']) {
    const result = await closerReviewProof({ ...reviewIdentity, snapshot: snapshot([old, { ...operatorReview, submitted_at }]),
      get: getReviewEvidence });
    assert.deepEqual(result, { ok: false, reason: 'operator-review-changes-requested',
      reviewId: operatorReview.id, operatorLogin: 'fixture-operator' });
    assert.equal(gate(result).eligible, false);
  }
  const configured = await closerReviewProof({ ...reviewIdentity, snapshot: snapshot([operatorReview]),
    operatorLogins: ['Fixture-Operator'], get: async () => assert.fail('configured issuer needs no permission read') });
  assert.equal(configured.reason, 'operator-review-changes-requested');
});

test('dismissal or a later approval by the same operator clears only the disposed review across rebases', async () => {
  const evaluate = (reviews, get = getReviewEvidence) =>
    closerReviewProof({ ...reviewIdentity, snapshot: snapshot(reviews), get });
  const approval = { ...operatorReview, id: 501, state: 'APPROVED', submitted_at: '2026-11-07T01:33:00Z' };
  for (const reviews of [[{ ...operatorReview, state: 'DISMISSED' }], [operatorReview, approval],
    [{ ...operatorReview, commit_id: OTHER }, approval],
    [operatorReview, { ...approval, commit_id: OTHER }]]) {
    assert.deepEqual(await evaluate(reviews), { ok: true });
  }
  for (const irrelevant of [
    { ...approval, state: 'COMMENTED' }, { ...approval, user: { login: 'another-user' } },
    { ...approval, commit_id: null }, { ...approval, id: operatorReview.id },
    { ...approval, submitted_at: operatorReview.submitted_at },
  ]) {
    assert.equal((await evaluate([operatorReview, irrelevant])).reviewId, operatorReview.id);
  }
  const nextReview = { ...operatorReview, id: 502, submitted_at: '2026-11-07T01:34:00Z' };
  assert.equal((await evaluate([operatorReview, approval, nextReview])).reviewId, nextReview.id);
  assert.deepEqual(await evaluate([operatorReview], async () => ({ permission: 'read' })), { ok: true });
  assert.equal((await evaluate([operatorReview], async () => { throw new Error('permission unavailable'); })).reason,
    'terminal-review-evidence-unavailable');
  assert.equal((await evaluate([operatorReview], async () => ({}))).reason, 'terminal-review-evidence-unavailable');
});

test('operator veto survives a rebase from H to H-prime, without requiring review commit evidence', async () => {
  for (const commit_id of [HEAD, OTHER, null]) {
    const result = await closerReviewProof({ ...reviewIdentity, headSha: OTHER,
      snapshot: snapshot([{ ...operatorReview, commit_id }], OTHER), get: getReviewEvidence });
    assert.equal(result.reason, 'operator-review-changes-requested');
  }
});

test('irrelevant historical ghost approvals do not park closure; exact-head unknown authors fail closed', async () => {
  for (const ghost of [
    { ...operatorReview, state: 'APPROVED', commit_id: OTHER, user: null },
    { ...operatorReview, state: 'APPROVED', commit_id: null },
    { ...operatorReview, state: 'APPROVED', commit_id: null, user: null },
    { ...operatorReview, commit_id: OTHER, user: null },
  ]) {
    const result = await closerReviewProof({ ...reviewIdentity, snapshot: snapshot([ghost]), get: getReviewEvidence });
    assert.deepEqual(result, { ok: true });
    const veto = await closerReviewProof({ ...reviewIdentity, snapshot: snapshot([operatorReview, ghost]), get: getReviewEvidence });
    assert.equal(veto.reason, 'operator-review-changes-requested');
  }
  for (const state of ['APPROVED', 'CHANGES_REQUESTED']) {
    const result = await closerReviewProof({ ...reviewIdentity,
      snapshot: snapshot([{ ...operatorReview, state, user: null }]), get: getReviewEvidence });
    assert.equal(result.reason, 'terminal-review-evidence-unavailable');
  }
});

test('review refusals do not enter the automatic retry/refund deferral allowlist', () => {
  for (const reason of ['operator-review-changes-requested', 'review-changed-since-validation']) {
    assert.equal(AMA_CLOSER_RETRYABLE_DEFERRAL_REASONS.has(reason), false);
    assert.equal(retryableAmaCloserDeferralOutcome({ outcome: 'deferred', reason }), null);
  }
  assert.equal(retryableAmaCloserDeferralOutcome({ outcome: 'deferred', reason: 'lane-busy' }), 'retryable-lane-busy');
});

test('explicit legacy writer PR identity survives URL variations and malformed targets are named', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closer-pr-identity-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  for (const suffix of ['/pull/54/', '/pull/54#review', '/pulls/54']) {
    const args = ['--root', rootDir, '--repo', reviewIdentity.repo, '--base', 'main', '--pr', '54',
      '--review-validated-at', AUDIT_AT, '--', 'merge', `https://github.com/example/repo${suffix}`,
      '--match-head-commit', HEAD];
    let writes = 0;
    assert.equal(await legacyLaneWriteMain(args, { stdout: { write() {} }, stderr: { write() {} },
      run: options => runLegacyLaneWrite({ ...options, readConfig: () => ({}),
        readReviewProof: async request => { assert.equal(request.prNumber, 54); return { ok: true }; },
        exec: async () => { writes++; return {}; },
      }) }), 0);
    assert.equal(writes, 1);
  }
  const result = await runLegacyLaneWrite({ rootDir, repository: reviewIdentity.repo, base: 'main',
    subject: { target: 'invalid', head: HEAD }, reviewValidatedAt: AUDIT_AT, readConfig: () => ({}),
    exec: async () => assert.fail('unidentified target cannot merge') });
  assert.equal(result.reason, 'merge-target-unparseable');
  for (const pr of ['0', '-1', '1e3', '9007199254740992']) {
    assert.equal(await legacyLaneWriteMain(['--root', rootDir, '--repo', reviewIdentity.repo,
      '--base', 'main', '--pr', pr, '--', 'merge'], { run: async () => assert.fail('invalid PR') }), 64);
  }
});

test('FIFO writer samples fresh exact-head review evidence after another merge owner releases the lane', { timeout: 5000 }, async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closer-late-review-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const lane = { repository: reviewIdentity.repo, base: 'main' };
  let admitted, releaseDaemon;
  const daemonReady = new Promise(resolve => { admitted = resolve; });
  const daemonDone = new Promise(resolve => { releaseDaemon = resolve; });
  const daemon = routeFinalizationWriter({ rootDir, cfg: {}, lane, kind: 'daemon',
    legacy: async () => { admitted(); await daemonDone; return { ok: true }; } });
  await daemonReady;

  const comment = { ...old, commit_id: HEAD };
  const unchanged = { ...comment, node_id: late.node_id, submitted_at: late.submitted_at };
  let live = snapshot([comment, unchanged]);
  let reads = 0, writes = 0, diagnostics = '';
  const args = ['--root', rootDir, '--repo', lane.repository, '--base', lane.base,
    '--review-validated-at', AUDIT_AT, '--', 'synthetic-merge', 'https://github.com/example/repo/pull/54',
    '--match-head-commit', HEAD];
  const click = () => legacyLaneWriteMain(args, {
    stdout: { write() {} }, stderr: { write(text) { diagnostics += text; } },
    run: options => runLegacyLaneWrite({ ...options, readConfig: () => ({}), timeoutMs: 1000,
      readReviewProof: request => readCloserReviewProof(request, {
        fetchPr: async (repo, pr, opts) => {
          reads++;
          assert.equal(repo, lane.repository);
          assert.equal(pr, reviewIdentity.prNumber);
          assert.equal(opts.withChecks, false);
          if (!live) throw new Error('review read failed');
          assert.equal(opts.withReviews(live), live.headSha === HEAD);
          return live;
        },
        get: getReviewEvidence,
      }),
      exec: async (_command, argv) => { writes++; assert.deepEqual(argv.slice(-2), ['--match-head-commit', HEAD]); return {}; },
    }),
  });
  try {
    assert.deepEqual(await closerReviewProof({ ...reviewIdentity, snapshot: live, get: getReviewEvidence }), { ok: true });
    const pending = click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 0, 'the review read must wait for FIFO ownership');
    live = snapshot([comment, unchanged, operatorReview]);
    releaseDaemon();
    await daemon;
    assert.equal(await pending, 75);
    assert.equal(writes, 0);
    assert.match(diagnostics, /operator-review-changes-requested/);
  } finally {
    releaseDaemon();
    await daemon;
  }
  for (const [next, reason] of [
    [snapshot([comment, late]), 'review-changed-since-validation'],
    [snapshot([], OTHER), 'live-head-moved-before-merge'],
    [snapshot(undefined), 'terminal-review-evidence-unavailable'],
    [null, 'terminal-review-evidence-unavailable'],
  ]) {
    live = next;
    diagnostics = '';
    assert.equal(await click(), 75);
    assert.equal(writes, 0);
    assert.match(diagnostics, new RegExp(reason));
  }
  live = snapshot([comment, unchanged, { ...operatorReview, state: 'DISMISSED' }]);
  assert.equal(await click(), 0);
  assert.equal(writes, 1, 'unchanged final comments require no additional review');
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
    for (const [reviews, reason, unavailable] of [
      [[old], null, false], [[old, late], 'review-changed-since-validation', false],
      [[old], 'terminal-review-evidence-unavailable', true],
      [[old, operatorReview], 'operator-review-changes-requested', false],
    ]) {
      // Execute the actual gate's JS with only I/O replaced. The currency and
      // merge predicates remain production code; no GitHub credentials/network.
      const code = `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tenureHeadNeedsReview } from ${JSON.stringify(new URL('src/pr-tenure.mjs', root).href)};
import { latestReviewedHeadSha } from ${JSON.stringify(new URL('src/ci-blocked-hammer.mjs', root).href)};
import { closerReviewProof } from ${JSON.stringify(new URL('src/ama/closer-review-proof.mjs', root).href)};
import { evaluateMergeEligibility } from ${JSON.stringify(new URL('src/ama/merge-eligibility.mjs', root).href)};
import { classifyCheckRollup, latestCheckRollupItems } from ${JSON.stringify(new URL('src/checks-summary.mjs', root).href)};
const fetchHammerPr = async (_repo, _pr, options) => {
  assert.equal(options.withReviews({ checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }], state: 'OPEN', headSha: ${JSON.stringify(HEAD)} }), true);
  return { headSha: ${JSON.stringify(HEAD)}, state: 'OPEN', mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN', labels: [], reviews: ${JSON.stringify(reviews)},
    checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
};
const createHistoryReader = () => async path => {
  if (path.endsWith('/collaborators/fixture-operator/permission')) return { permission: 'admin' };
  if (path.includes('/compare/')) {
    if (${unavailable}) throw new Error('compare 404');
    return { status: 'ahead' };
  }
  throw new Error('unexpected offline read: ' + path);
};
const loadEffectiveMergeAuthorityConfig = () => ({});
const fetchPrimaryChange = async () => (${JSON.stringify(primaryChangeFixture(HEAD))});
const checkPrimaryChange = () => ({ ok: true });
${gateCode.replace(/^import .*;\n/gm, '').replaceAll('<<REPO>>', 'example/repo').replaceAll('<<PR_NUMBER>>', '54').replaceAll('<<TENURE_REVIEW_ARG>>', '').replaceAll('<<REVIEWED_SHA>>', OLD)}`;
      const result = spawnSync(process.execPath, ['--input-type=module'], {
        input: code, encoding: 'utf8', timeout: 15000,
        env: { ...process.env, POST_REMEDIATION_SHA: HEAD, HAM_REVIEW_PROOF_REQUIRED: '1',
          HAM_REVIEW_VERDICT_FILE: verdictFile, HAM_BRANCH_PROTECTION_REQUIRED: 'false' },
      });
      assert.equal(result.status, 0, result.stderr);
      const gateResult = JSON.parse(result.stdout);
      assert.equal(gateResult.ok, reason === null, result.stdout);
      if (reason) assert.ok(gateResult.reasons.includes(reason));
    }
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

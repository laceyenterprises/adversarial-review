import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPrimaryChange, fetchPrimaryChange as fetchPrimaryChangeWithCost,
  primaryChangeExactReviewEvidence } from '../src/ama/primary-change.mjs';
import { recoverStrandedCloserHead } from '../src/ama/closer-head-recovery.mjs';

// REVERSALREBASE-01 replays agent-os PR 8088: a HAM commit reverted an author
// region under a blocking finding, then a conflict-owner rebase and a hammer
// rebase rewrote every commit, so neither the HAM commit nor its Reviewed-Head
// is in the branch history any more.
const fetchPrimaryChange = (args) => fetchPrimaryChangeWithCost(args, {
  fetchCiCostImpl: async ({ headSha }) => ({ headSha, ok: true, failedCheck: false }),
});
const sha = (c) => c.repeat(40);
const oldBase = sha('0'), base = sha('b'), reviewedHead = sha('1'), author = sha('2'), head = sha('c');
const card = (lines) => `- **Finding**\n  - **File:** \`daemon.py\`\n  - **Lines:** \`${lines}\`\n  - **Problem:** Unsafe startup.\n  - **Recommended fix:** Revert it.`;
const review = (overrides = {}) => ({ node_id: 'PRR_cited', html_url: 'https://github.com/fixture/repo/pull/8088#pullrequestreview-1',
  commit_id: reviewedHead, state: 'CHANGES_REQUESTED', user: { login: 'lacey-claude-reviewer[bot]' },
  submitted_at: '2026-10-11T17:00:00Z',
  body: `## Blocking issues\n${card('10-11')}\n## Non-blocking issues\n- None.\n## Verdict\nRequest changes`, ...overrides });
// The author hunk, in the coordinates of the base it was written against.
const authorPatch = (line, added = '+start_unsafe()') => ({ filename: 'daemon.py', status: 'modified', additions: 2, deletions: 1,
  patch: `@@ -${line} +${line},2 @@\n-start()\n${added}\n+log_startup()` });
const message = (cites) => ['HAM repair', '', 'Worker-Class: hammer', 'Worker-Ticket: HAM',
  'Closed-By: hammer (adversarial-pipe-mode)', `Reviewed-Head: ${reviewedHead}`,
  ...cites.map((cite) => `Reversal-Authorized-By: ${cite}`)].join('\n');

// shift: how far the rebases moved the author hunk. reviewedPatch: the author
// hunk as the cited review saw it, in the older base's coordinates.
async function collect({ shift = 5, cites = ['PRR_cited finding=1 kind=blocking'], reviews = [review()],
  rebasedAdded, reviewedAdded, authoredAt = '2026-10-11T17:30:00Z', reviewToParent = 'diverged' } = {}) {
  const primary = authorPatch(10 + shift, rebasedAdded);
  const ham = { sha: head, parents: [{ sha: author }], author: { login: 'the-hammer-lacey[bot]' },
    committer: { login: 'the-hammer-lacey[bot]' },
    commit: { message: message(cites), author: { date: authoredAt } },
    files: [{ filename: 'daemon.py', status: 'modified', additions: 1, deletions: 2,
      patch: `@@ -${10 + shift},2 +${10 + shift} @@\n${rebasedAdded ? `-${rebasedAdded.slice(1)}` : '-start_unsafe()'}\n-log_startup()\n+start()` }] };
  const reads = [];
  const evidence = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 8088, headSha: head,
    get: async (path) => {
      reads.push(path);
      if (path.endsWith('/pulls/8088')) return { head: { sha: head }, base: { sha: base } };
      if (path.includes('/reviews?')) return reviews;
      if (path.endsWith(`/commits/${head}`)) return ham;
      if (path.endsWith(`${base}...${head}`)) return { status: 'ahead', merge_base_commit: { sha: base }, files: [],
        total_commits: 2, commits: [{ sha: author, commit: { message: 'author change' } }, ham] };
      if (path.endsWith(`${base}...${author}`)) return { status: 'ahead', merge_base_commit: { sha: base }, files: [primary] };
      if (path.endsWith(`${author}...${author}`)) return { status: 'identical' };
      if (path.endsWith(`${reviewedHead}...${author}`)) return { status: reviewToParent, merge_base_commit: { sha: oldBase } };
      if (path.endsWith(`${base}...${reviewedHead}`)) return { status: 'diverged', merge_base_commit: { sha: oldBase },
        files: [authorPatch(10, reviewedAdded)] };
      // Every pre-rebase head has diverged from the rebased history.
      if (path.includes('/compare/')) return { status: 'diverged', merge_base_commit: { sha: oldBase }, files: [] };
      throw new Error(`unexpected ${path}`);
    } });
  return { evidence, reads, result: checkPrimaryChange(evidence, head, { strictNonBlockingRemediation: true }) };
}

test('an authorized HAM reversal stays authorized after the branch is rebased onto a newer base', async () => {
  const { evidence, result } = await collect();
  assert.equal(evidence.reversalAuthorizations.length, 1);
  assert.equal(evidence.reversalAuthorizations[0].rebased, true);
  assert.deepEqual(result, { ok: true, applicable: true, testRegionsChanged: [] });
});

test('PR 8088: a conflict-owner rebase then a hammer rebase keep the authorization, past a later review', async () => {
  // Two base moves (5 then 3 lines) and the post-reversal re-review on the
  // conflict-owner head with zero blocking findings, submitted after the HAM commit.
  const later = review({ node_id: 'PRR_later', commit_id: sha('f'), state: 'COMMENTED', submitted_at: '2026-10-11T19:10:00Z',
    body: '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nComment only' });
  const { result } = await collect({ shift: 8, reviews: [review(), later] });
  assert.equal(result.ok, true);
});

test('a trailer naming a review that is not on this pull request is rejected and named', async () => {
  for (const cites of [['PRR_other_pr finding=1 kind=blocking'], ['PRR_cited finding=2 kind=blocking']]) {
    const { result } = await collect({ cites });
    assert.equal(result.reason, 'primary-change-reverted');
    assert.equal(result.missingEvidence.evidence, 'reversal-authorization');
    assert.equal(result.missingEvidence.path, 'daemon.py');
  }
  const { evidence, result } = await collect({ cites: ['PRR_other_pr finding=1 kind=blocking'] });
  assert.deepEqual(evidence.rejectedReversalAuthorizations.map(({ reason }) => reason), ['review-not-on-this-pull-request']);
  assert.match(result.missingEvidence.summary, /PRR_other_pr finding=1 kind=blocking .*review-not-on-this-pull-request/);
});

test('a rebased reversal whose protected patch differs from the reviewed one is rejected', async () => {
  // The conflict resolution rewrote the author line the finding was about.
  assert.equal((await collect({ rebasedAdded: '+start_unsafe(retry=True)' })).result.reason, 'primary-change-reverted');
  assert.equal((await collect({ reviewedAdded: '+start_unsafe(retry=True)' })).result.reason, 'primary-change-reverted');
  // The finding must still cover the matched region in the reviewed head.
  const narrow = review({ body: review().body.replace('`10-11`', '`11`') });
  assert.equal((await collect({ reviews: [narrow] })).result.reason, 'primary-change-reverted');
});

test('an unauthorized rebased reversal still stops the hammer and names the missing authorization', async () => {
  const { evidence, result } = await collect({ cites: [] });
  assert.equal(evidence.reversalAuthorizations, undefined);
  assert.equal(result.reason, 'primary-change-reverted');
  assert.equal(result.missingEvidence.accepted, 0);
  assert.match(result.missingEvidence.summary, /no verified Reversal-Authorized-By covers the reverted daemon\.py region \(0 verified\)/);
});

test('a citation superseded before the reversal, or with unreadable times, stays rejected after a rebase', async () => {
  const superseding = review({ node_id: 'PRR_newer', commit_id: sha('9'), submitted_at: '2026-10-11T17:15:00Z',
    body: '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nApproved', state: 'APPROVED' });
  const cases = [{ reviews: [review(), superseding] }, { authoredAt: 'not a date' },
    { authoredAt: '2026-10-11T16:00:00Z' }, { reviews: [review({ submitted_at: null })] }];
  for (const options of cases) {
    const { evidence, result } = await collect(options);
    assert.equal(result.reason, 'primary-change-reverted', JSON.stringify(options));
    assert.deepEqual(evidence.rejectedReversalAuthorizations.map(({ reason }) => reason), ['review-superseded-before-reversal']);
  }
  // Another family stacking on the same reviewed head does not supersede it.
  const stacked = review({ node_id: 'PRR_gemini', user: { login: 'lacey-gemini-reviewer[bot]' }, submitted_at: '2026-10-11T17:10:00Z' });
  assert.equal((await collect({ reviews: [review(), stacked] })).result.ok, true);
});

test('only a review head that diverged from the HAM parent may use the rebase path', async () => {
  // "behind": the cited head descends from the HAM parent, which no rebase produces.
  for (const reviewToParent of ['behind', 'unknown']) {
    const { evidence, result } = await collect({ reviewToParent });
    assert.equal(result.reason, 'primary-change-reverted');
    assert.deepEqual(evidence.rejectedReversalAuthorizations.map(({ reason }) => reason),
      [reviewToParent === 'behind' ? 'review-not-current' : 'unverifiable']);
  }
});

test('a HAM head failing self-certification only on the reversal authorization requests the exact-head review', async () => {
  const { result: primary } = await collect({ cites: ['PRR_other_pr finding=1 kind=blocking'] });
  const checks = { workerClass: true, head: true, parent: true, commitIdentity: true, nonEmptyCommit: true, primaryChange: false };
  const trace = { primaryChange: primary, hamTerminalRemediation: { active: true, checks } };
  const missingEvidence = primaryChangeExactReviewEvidence(trace);
  assert.equal(missingEvidence, primary.missingEvidence);
  for (const other of [{ ...checks, parent: false }, { ...checks, primaryChange: true }]) {
    assert.equal(primaryChangeExactReviewEvidence({ ...trace, hamTerminalRemediation: { active: true, checks: other } }), null);
  }
  assert.equal(primaryChangeExactReviewEvidence({ ...trace, hamTerminalRemediation: { active: false, checks } }), null);
  assert.equal(primaryChangeExactReviewEvidence({ ...trace, primaryChange: { ...primary,
    missingEvidence: { ...primary.missingEvidence, evidence: 'rename-preservation' } } }), null);

  const refusal = { dispatched: false, skipMergeAgent: true, reason: 'primary-change-repair-required', needsOperator: true,
    reasons: ['stale-review-head', 'verdict-not-settled-success', 'primary-change-reverted'] };
  const requests = [];
  const logs = [];
  const recover = (result, extra = {}) => recoverStrandedCloserHead({ result, closerAuthored: true, rootDir: '/fixture',
    repo: 'fixture/repo', prNumber: 8088, headSha: head, logger: { log: (line) => logs.push(line), warn() {} },
    probeOwnershipImpl: async () => ({ owned: false, uncertain: false }),
    requestBoundedReviewImpl: async (options) => { requests.push(options.headSha); return { triggered: true }; }, ...extra });
  const recovered = await recover({ ...refusal, missingEvidence, exactHeadReview: true });
  assert.equal(recovered.reason, 'closer-head-exact-review-requested');
  assert.equal(recovered.needsOperator, false);
  assert.equal(recovered.missingEvidence.evidence, 'reversal-authorization');
  assert.deepEqual(requests, [head]);
  assert.match(logs[0], /missing-evidence=no verified Reversal-Authorized-By covers the reverted daemon\.py region/);
  // Without that proof, or with any other co-occurring refusal, the operator hold stays.
  for (const result of [refusal, { ...refusal, missingEvidence, exactHeadReview: true, reasons: [...refusal.reasons, 'ci-not-green'] },
    { ...refusal, missingEvidence, exactHeadReview: true, reasons: ['primary-change-reverted'] },
    { ...refusal, reason: 'primary-change-needs-operator', missingEvidence, exactHeadReview: true }]) {
    assert.equal(await recover(result), null);
  }
  // A live owner still wins.
  assert.equal(await recover({ ...refusal, missingEvidence, exactHeadReview: true },
    { probeOwnershipImpl: async () => ({ owned: true, uncertain: false }) }), null);
  assert.equal(requests.length, 1);
});

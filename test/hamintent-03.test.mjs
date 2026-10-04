import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPrimaryChange, fetchPrimaryChange } from '../src/ama/primary-change.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { evaluateMergeEligibility } from '../src/ama/merge-eligibility.mjs';
import { amaAllAuthoritativeReviewerLogins, amaAuthoritativeReviewerLoginsForModel, amaReviewerFamilyForLogin } from '../src/ama/reviewer-authority.mjs';
import { parseCommitTrailerValues, parseCommitTrailers } from '../src/ama/ham-provenance.mjs';
const head = 'c'.repeat(40), author = 'a'.repeat(40), base = 'b'.repeat(40);
const card = (line) => `- **Finding**\n  - **File:** \`run.py\`\n  - **Lines:** \`${line}\`\n  - **Problem:** Must repair.\n  - **Recommended fix:** Revert.`;
const review = (id, model, blocking, nonblocking) => ({ node_id: id, html_url: `https://github.com/fixture/repo/pull/1#pullrequestreview-${id}`,
  commit_id: author, state: 'CHANGES_REQUESTED', user: { login: `lacey-${model}-reviewer[bot]` },
  body: `## Blocking issues\n${blocking}\n## Non-blocking issues\n${nonblocking}\n## Verdict\nRequest changes` });
const reviews = [review('PRR_gemini', 'gemini', [card(90), card(10), card(20)].join('\n'), '- None.'),
  review('PRR_claude', 'claude', card(90), card(30))];
const file = { filename: 'run.py', status: 'modified', additions: 3, deletions: 3,
  patch: [10, 20, 30].map((n) => `@@ -${n} +${n} @@\n-old ${n}\n+new ${n}`).join('\n') };
const citations = ['PRR_gemini finding=2', 'PRR_gemini finding=3 kind=blocking', 'PRR_claude finding=1 kind=non-blocking'];
async function collect({ cites = citations, worker = 'hammer', list = reviews, touched = file } = {}) {
  const message = `HAM repair\n\nWorker-Class: ${worker}\nWorker-Ticket: HAM\nReviewed-Head: ${author}\n${cites.map((c) => `Reversal-Authorized-By: ${c}`).join('\n')}`;
  const commit = { sha: head, parents: [{ sha: author }], committer: { login: 'the-hammer-lacey[bot]' }, commit: { message }, files: [touched] };
  const comparison = { status: 'ahead', merge_base_commit: { sha: base }, files: [file] };
  const evidence = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 1, headSha: head, dispatchedHead: author,
    get: async (url) => {
      if (url.endsWith('/pulls/1')) return { head: { sha: head }, base: { sha: base } };
      if (url.includes('/reviews?')) return list;
      if (url.includes('/commits/')) return commit;
      if (url.endsWith(`${base}...${head}`)) return { ...comparison, files: [], total_commits: 2,
        commits: [{ sha: author, commit: { message: 'author' } }, commit] };
      return comparison;
    } });
  return evidence;
}
async function replay(options = {}) {
  return checkPrimaryChange(await collect(options), head, {
    strictNonBlockingRemediation: options.strictNonBlockingRemediation ?? true,
  });
}
test('#7681 replay authorizes three finding fixes across both final reviewers', async () => {
  assert.equal((await replay()).ok, true);
});
test('every citation is required; ranges and hammer provenance fail closed', async () => {
  for (let i = 0; i < citations.length; i++) {
    assert.equal((await replay({ cites: citations.filter((_, j) => j !== i) })).reason, 'primary-change-reverted');
  }
  const list = structuredClone(reviews);
  list[1].body = list[1].body.replace('`30`', '`31`');
  assert.equal((await replay({ list })).reason, 'primary-change-reverted');
  assert.equal((await replay({ worker: 'codex' })).reason, 'primary-change-reverted');
  assert.equal((await replay({ touched: { ...file, patch: file.patch.replaceAll('30', '31') } })).reason, 'primary-change-reverted');
});
test('superseding a cited reviewer final review refuses its waiver', async () => {
  assert.equal((await replay({ list: [...reviews, { ...reviews[0], node_id: 'PRR_new', body: '## Verdict\nApproved' }] })).reason,
    'primary-change-reverted');
});
test('repeated trailer parser preserves legacy scalar behavior and terminal-block boundaries', () => {
  const message = 'Subject\n\nReversal-Authorized-By: prose finding=9\nnot a trailer\n\n' + citations.map((c) => `Reversal-Authorized-By: ${c}`).join('\n');
  assert.deepEqual(parseCommitTrailerValues(message)['reversal-authorized-by'], citations);
  assert.equal(parseCommitTrailers(message)['reversal-authorized-by'], citations[0]);
});

test('required non-blocking finding can be cited from an approved final review', async () => {
  const list = structuredClone(reviews);
  list[1].state = 'APPROVED';
  list[1].body = list[1].body.replace(card(90), '- None.').replace('Request changes', 'Approved');
  assert.equal((await replay({ list })).ok, true);
});

test('URL citations and reviewer aliases preserve authority', async () => {
  const list = structuredClone(reviews);
  list[0].user.login = 'gemini-reviewer-lacey[bot]';
  const cites = citations.map((c) => c.replace('PRR_gemini', reviews[0].html_url));
  assert.equal((await replay({ list, cites })).ok, true);
});

test('advisory non-blocking citations cannot waive preservation in non-strict mode', async () => {
  for (const verdict of ['Approved', 'Comment only', 'Request changes']) {
    const list = structuredClone(reviews);
    list[1].state = verdict === 'Approved' ? 'APPROVED' : 'COMMENTED';
    list[1].body = list[1].body.replace('Request changes', verdict);
    const evidence = await collect({ list });
    assert.equal(checkPrimaryChange(evidence, head, { strictNonBlockingRemediation: true }).ok, true);
    assert.equal(checkPrimaryChange(evidence, head, { strictNonBlockingRemediation: false }).reason,
      'primary-change-reverted');
    assert.equal(checkPrimaryChange(evidence, head).reason, 'primary-change-reverted', 'omitted policy refuses advisory waivers');

    for (const strictNonBlockingRemediation of [true, false]) {
      const closure = isEligibleForAmaClosure({ headSha: head, verdict: 'approved', riskClass: 'low',
        remediationPending: false, blockingFindingState: 'known', blockingFindingCount: 0,
        nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 },
      { headSha: head, isOpen: true, mergeableState: 'MERGEABLE', labels: [],
        statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }] },
      { enabled: true, strictNonBlockingRemediation, eligibility: { riskClasses: ['low'] },
        branchProtection: { required: false } }, { primaryChange: evidence,
        hamTerminalRemediationGroundTruth: { commit: { primaryChange: evidence } } });
      assert.equal(closure.trace.primaryChange.ok, strictNonBlockingRemediation);
      assert.equal(closure.trace.hamTerminalRemediation.checks.primaryChange, strictNonBlockingRemediation);
      const merge = evaluateMergeEligibility({ primaryChange: evidence, strictNonBlockingRemediation,
        candidateHead: head, validatedHead: head, verdict: 'settled-success', requiredChecks: true,
        mergeable: true, branchProtectionRequired: false, leaseHeld: true, labels: [] });
      assert.equal(merge.eligible, strictNonBlockingRemediation);
    }
  }
  const evidence = await collect();
  // Blocking authorizations remain valid independently of strict mode.
  evidence.primaryFiles = [{ ...file, additions: 2, deletions: 2,
    patch: file.patch.split('\n').slice(0, 6).join('\n') }];
  assert.equal(checkPrimaryChange(evidence, head, { strictNonBlockingRemediation: false }).ok, true);
});

test('collector deduplicates review pairs while all findings still authorize their own regions', async () => {
  const evidence = await collect({ cites: [...citations, citations[0], citations[2]] });
  assert.equal(evidence.reversalAuthorizations.length, 2);
  assert.deepEqual(evidence.reversalAuthorizations.map(({ review }) => review.node_id), ['PRR_gemini', 'PRR_claude']);
  assert.equal(checkPrimaryChange(evidence, head, { strictNonBlockingRemediation: true }).ok, true);
  const withoutThird = await collect({ cites: citations.slice(0, 2) });
  assert.equal(checkPrimaryChange(withoutThird, head, { strictNonBlockingRemediation: true }).reason, 'primary-change-reverted');
});

test('reviewer family lookup follows the authority map, including aliases and bot suffixes', () => {
  for (const login of amaAllAuthoritativeReviewerLogins()) {
    const family = amaReviewerFamilyForLogin(login);
    assert.ok(family);
    assert.equal(amaReviewerFamilyForLogin(`${login}[bot]`), family);
    assert.ok(amaAuthoritativeReviewerLoginsForModel(family).includes(login));
  }
  for (const login of [null, '', 'author', 'lacey-unknown-reviewer[bot]']) {
    assert.equal(amaReviewerFamilyForLogin(login), null);
  }
});

test('reviews on different heads require separate HAM commits with matching Reviewed-Head trailers', async () => {
  const middle = 'd'.repeat(40);
  const list = structuredClone(reviews);
  list[1].commit_id = middle;
  const message = (reviewedHead, cites) => `HAM repair\n\nWorker-Class: hammer\nWorker-Ticket: HAM\nReviewed-Head: ${reviewedHead}\n${cites.map((c) => `Reversal-Authorized-By: ${c}`).join('\n')}`;
  const firstFiles = { ...file, additions: 2, deletions: 2,
    patch: file.patch.split('\n').slice(0, 6).join('\n').replaceAll('-old', '-new').replaceAll('+new', '+old') };
  const remaining = { ...file, additions: 1, deletions: 1, patch: file.patch.split('\n').slice(6).join('\n') };
  for (const split of [true, false]) {
    const commits = [{ sha: middle, parents: [{ sha: author }], committer: { login: 'the-hammer-lacey[bot]' },
      commit: { message: message(author, split ? citations.slice(0, 2) : []) }, files: [firstFiles] },
    { sha: head, parents: [{ sha: middle }], committer: { login: 'the-hammer-lacey[bot]' },
      commit: { message: message(split ? middle : author, split ? citations.slice(2) : citations) },
      files: [{ ...remaining, patch: remaining.patch.replaceAll('-old', '-new').replaceAll('+new', '+old') }] }];
    const evidence = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 1, headSha: head, dispatchedHead: author,
      get: async (url) => {
        if (url.endsWith('/pulls/1')) return { head: { sha: head }, base: { sha: base } };
        if (url.includes('/reviews?')) return list;
        if (url.includes('/commits/')) return commits.find((commit) => url.endsWith(commit.sha));
        if (url.endsWith(`${base}...${head}`)) return { status: 'ahead', merge_base_commit: { sha: base }, files: [],
          total_commits: 3, commits: [{ sha: author, commit: { message: 'author' } }, ...commits] };
        if (url.endsWith(`${middle}...${author}`)) return { status: 'behind' };
        return { status: 'ahead', merge_base_commit: { sha: base },
          files: url.endsWith(`${base}...${middle}`) ? [remaining] : [file] };
      } });
    const result = checkPrimaryChange(evidence, head, { strictNonBlockingRemediation: true });
    assert.equal(result.ok, split);
    assert.equal(evidence.reversalAuthorizations.length, split ? 2 : 1);
  }
});

test('review bodies are parsed once per evaluation and refreshed on the next evaluation', async () => {
  const evidence = await collect();
  const reads = new Map();
  for (const { review } of evidence.reversalAuthorizations) {
    const body = review.body;
    Object.defineProperty(review, 'body', { configurable: true, get() {
      reads.set(review.node_id, (reads.get(review.node_id) || 0) + 1);
      return body;
    } });
  }
  assert.equal(checkPrimaryChange(evidence, head, { strictNonBlockingRemediation: true }).ok, true);
  // Multiple removed lines and region units must not multiply body parsing.
  assert.deepEqual([...reads.values()], [3, 3]);
  const cited = evidence.reversalAuthorizations[1].review;
  Object.defineProperty(cited, 'body', { value: '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nApproved' });
  assert.equal(checkPrimaryChange(evidence, head, { strictNonBlockingRemediation: true }).reason, 'primary-change-reverted');
});

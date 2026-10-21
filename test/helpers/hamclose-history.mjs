import { checkPrimaryChange, fetchPrimaryChange as fetchPrimaryChangeWithCost,
  primaryChangeExactReviewEvidence } from '../../src/ama/primary-change.mjs';

// Synthetic history: moved base, rebased parent and authorized reversal.
const fetchPrimaryChange = (args) => fetchPrimaryChangeWithCost(args, {
  fetchCiCostImpl: async ({ headSha }) => ({ headSha, ok: true, failedCheck: false }),
});
const sha = (c) => c.repeat(40);
const oldBase = sha('0'), base = sha('b'), reviewedHead = sha('1'), author = sha('2'), head = sha('c');
const card = (lines) => `- **Finding**\n  - **File:** \`src/a.mjs\`\n  - **Lines:** \`${lines}\`\n  - **Problem:** Unsafe startup.\n  - **Recommended fix:** Revert it.`;
export const review = (overrides = {}) => ({ node_id: 'PRR_cited', html_url: 'https://github.com/fixture/repo/pull/8088#pullrequestreview-1',
  commit_id: reviewedHead, state: 'CHANGES_REQUESTED', user: { login: 'lacey-claude-reviewer[bot]' },
  submitted_at: '2026-10-11T17:00:00Z',
  body: `## Blocking issues\n${card('10-11')}\n## Non-blocking issues\n- None.\n## Verdict\nRequest changes`, ...overrides });
// The author hunk, in the coordinates of the base it was written against.
const authorPatch = (line, added = '+start_unsafe()') => ({ filename: 'src/a.mjs', status: 'modified', additions: 2, deletions: 1,
  patch: `@@ -${line} +${line},2 @@\n-start()\n${added}\n+log_startup()` });
const message = (cites, reviewHead = reviewedHead) => ['HAM repair', '', 'Worker-Class: hammer', 'Worker-Ticket: HAM',
  'Closed-By: hammer (adversarial-pipe-mode)', `Reviewed-Head: ${reviewHead}`,
  ...cites.map((cite) => `Reversal-Authorized-By: ${cite}`)].join('\n');

// shift: how far the rebases moved the author hunk. reviewedPatch: the author
// hunk as the cited review saw it, in the older base's coordinates.
export async function collect({ shift = 5, cites = ['PRR_cited finding=1 kind=blocking'], reviews = [review()],
  rebasedAdded, reviewedAdded, earlierHammerAdded, reviewHead = reviewedHead, authoredAt = '2026-10-11T17:30:00Z', reviewToParent = 'diverged',
  duplicatePrimary = false, duplicateReviewed = false, originalRecorded = false, originalAdded,
  originalLogin = 'the-hammer-lacey[bot]', originalParent = reviewedHead, snapshotCapped = false,
  originalLine = 10, snapshotStatus = 'ahead', hammerLogin = 'the-hammer-lacey[bot]', nullAuthor = false, builderOnly = false, parentExtraHunk = false, parentContext = '', reviewedContext = '', unrelated = true, attestationAuthor = null, attestationHead = head } = {}) {
  const parent = authorPatch(10 + shift, earlierHammerAdded || rebasedAdded);
  const primary = earlierHammerAdded ? authorPatch(10 + shift, rebasedAdded) : parent;
  for (const file of new Set([primary, parent])) {
    if (parentExtraHunk) { file.patch += '\n@@ -40 +40 @@\n-other\n+extra'; file.additions++; file.deletions++; }
    file.patch += parentContext;
  }
  const parentHead = earlierHammerAdded ? sha('3') : author;
  const ham = { sha: head, parents: [{ sha: parentHead }], author: nullAuthor ? null : { login: hammerLogin },
    committer: { login: 'the-hammer-lacey[bot]' },
    commit: { verification: { verified: false, reason: 'unsigned' }, message: builderOnly ? 'Builder change\n\nWorker-Class: codex' : message(cites, reviewHead), author: { date: authoredAt }, committer: { date: '2026-10-11T17:30:00Z', email: 'the-hammer-lacey[bot]@users.noreply.github.com' } },
    files: [{ filename: 'src/a.mjs', status: 'modified', additions: 1, deletions: 2,
      patch: `@@ -${10 + shift},2 +${10 + shift} @@\n-${(earlierHammerAdded || rebasedAdded || '+start_unsafe()').slice(1)}\n-log_startup()\n+start()` }] };
  const earlierHammer = { ...ham, sha: parentHead, parents: [{ sha: author }],
    commit: { ...ham.commit, message: message([]) }, files: [{ filename: 'src/a.mjs', status: 'modified',
      additions: 1, deletions: 1,
      patch: `@@ -${10 + shift} +${10 + shift} @@\n-start_unsafe()\n${earlierHammerAdded}` }] };
  const duplicate = (file) => ({ ...file, additions: file.additions * 2, deletions: file.deletions * 2,
    patch: `${file.patch}\n${file.patch.replace(/@@ -\d+ \+\d+,2 @@/, '@@ -45 +45,2 @@')}` });
  const original = { ...ham, sha: sha('d'), parents: [{ sha: originalParent }],
    author: { login: originalLogin },
    files: [{ ...ham.files[0], patch: ham.files[0].patch.replace(/@@ -\d+,2 \+\d+ @@/, `@@ -${originalLine},2 +${originalLine} @@`)
      .replace('-start_unsafe()', originalAdded || '-start_unsafe()') }] };
  const reads = [];
  const transport = async (path) => {
      reads.push(path);
      if (path.endsWith('/pulls/8088')) return { head: { sha: head }, base: { sha: base } };
      if (path === 'repos/fixture/repo/pulls/8088/reviews?per_page=100') return reviews;
      if (path === 'repos/fixture/repo/issues/8088/comments?per_page=100') return attestationAuthor ? [{ user: { login: attestationAuthor }, body: `HAM-Base-Head: ${author}\nHAM-Validated-Head: ${attestationHead}` }] : [];
      if (path.endsWith(`/commits/${head}`)) return ham;
      if (earlierHammerAdded && path.endsWith(`/commits/${parentHead}`)) return earlierHammer;
      if (path.endsWith(`/commits/${original.sha}`)) return original;
      if (originalRecorded && path.endsWith(`${reviewedHead}...${sha('f')}`)) {
        return { status: snapshotStatus, total_commits: snapshotCapped ? 250 : 1, commits: [original] };
      }
      if (path.endsWith(`${oldBase}...${reviewedHead}`)) return { status: 'ahead',
        merge_base_commit: { sha: oldBase }, files: [duplicateReviewed ? duplicate(authorPatch(10, reviewedAdded || earlierHammerAdded)) : { ...authorPatch(10, reviewedAdded || earlierHammerAdded), patch: authorPatch(10, reviewedAdded || earlierHammerAdded).patch + reviewedContext }] };
      if (path.endsWith(`${base}...${head}`)) return { status: 'ahead', merge_base_commit: { sha: base }, files: [],
        total_commits: earlierHammerAdded ? 3 : 2,
        commits: [{ sha: author, commit: { message: 'author change' } }, ...(earlierHammerAdded ? [earlierHammer] : []), ham] };
      if (earlierHammerAdded && path.endsWith(`${base}...${parentHead}`)) return { status: 'ahead', merge_base_commit: { sha: base }, files: [parent] };
      if (earlierHammerAdded && path.endsWith(`${author}...${parentHead}`)) return { status: 'ahead' };
      if (earlierHammerAdded && path.endsWith(`${reviewedHead}...${parentHead}`)) return { status: reviewToParent, merge_base_commit: { sha: oldBase } };
      if (path.endsWith(`${base}...${author}`)) return { status: 'ahead', merge_base_commit: { sha: base }, files: [duplicatePrimary ? duplicate(primary) : primary] };
      if (path.endsWith(`${author}...${author}`)) return { status: 'identical' };
      if (path.endsWith(`${reviewedHead}...${author}`)) return { status: reviewToParent, merge_base_commit: { sha: oldBase } };
      if (path.endsWith(`${base}...${reviewedHead}`)) return { status: 'diverged', merge_base_commit: { sha: oldBase },
        files: [duplicateReviewed ? duplicate(authorPatch(10, reviewedAdded || earlierHammerAdded)) : { ...authorPatch(10, reviewedAdded || earlierHammerAdded), patch: authorPatch(10, reviewedAdded || earlierHammerAdded).patch + reviewedContext }, ...(unrelated ? [{ filename: 'src/mainline.mjs', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+base_only()' }] : [])] };
      // Every pre-rebase head has diverged from the rebased history.
      if ([reviewedHead, ...reviews.map(entry => entry.commit_id), base].some(from =>
        [author, parentHead, originalParent, ...reviews.map(entry => entry.commit_id)].some(to => path === `repos/fixture/repo/compare/${from}...${to}`))) return { status: 'diverged', merge_base_commit: { sha: oldBase }, files: [] };
      throw new Error(`unexpected ${path}`);
    };
  const evidence = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 8088, headSha: head, get: transport });
  return { evidence, reads, transport, result: checkPrimaryChange(evidence, head, { strictNonBlockingRemediation: true }) };
}

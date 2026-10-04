import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPrimaryChange, fetchPrimaryChange } from '../src/ama/primary-change.mjs';
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
async function replay({ cites = citations, worker = 'hammer', list = reviews, touched = file } = {}) {
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
  return checkPrimaryChange(evidence, head);
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

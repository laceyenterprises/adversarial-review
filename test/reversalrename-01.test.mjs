import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchPrimaryChange, checkPrimaryChange } from '../src/ama/primary-change.mjs';

const BASE = 'b'.repeat(40), PRIMARY = 'a'.repeat(40), RENAME = 'c'.repeat(40), HEAD = 'd'.repeat(40);
const REPO = 'fixture/repo';
const LINES = ['name: sample', 'kind: widget', 'owner: team'];
const added = { filename: 'a/x.yaml', status: 'added', sha: '1'.repeat(40), additions: 3, deletions: 0,
  patch: `@@ -0,0 +1,3 @@\n${LINES.map(line => `+${line}`).join('\n')}` };
const finding = file => `- **Rename the file**\n  - **File:** \`${file}\`\n  - **Lines:** \`1-3\`\n  - **Problem:** Wrong name.\n  - **Recommended fix:** Rename it.`;
const reviewBody = file => `## Blocking issues\n- None.\n## Non-blocking issues\n${finding(file)}\n## Verdict\nComment only`;

// shape: 'rename' (renamed with an edited line), 'split' (removed + added),
// 'delete', 'edit' (in-place edit, no path change).
function fixture(t, { shape = 'rename', cite = true, citedFile = 'a/x.yaml', reviewer = 'lacey-claude-reviewer[bot]',
  reviewedHead = PRIMARY, later = false, author = 'hammer-worker', destination = 'a/y.yaml',
  replacement = 'partial', additionalFiles = [] } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'reversal-rename-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const patchOf = (removed, kept) => `@@ -1,3 +1,${kept.length} @@\n${removed.map(line => `-${line}`).join('\n')}${kept.length ? '\n' : ''}${kept.map(line => `+${line}`).join('\n')}`;
  const edited = { partial: ['name: renamed', ...LINES.slice(1)], identical: LINES,
    complete: ['name: replaced', 'kind: replacement', 'owner: other-team'] }[replacement];
  const blob = replacement === 'identical' ? added.sha : '2'.repeat(40);
  const renamePatch = replacement === 'partial'
    ? '@@ -1,3 +1,3 @@\n-name: sample\n+name: renamed\n kind: widget\n owner: team'
    : replacement === 'identical' ? undefined : patchOf(LINES, edited);
  const changedLines = { partial: 1, identical: 0, complete: 3 }[replacement];
  const commitFiles = {
    rename: [{ filename: destination, previous_filename: 'a/x.yaml', status: 'renamed', sha: blob,
      additions: changedLines, deletions: changedLines, patch: renamePatch }],
    split: [{ filename: 'a/x.yaml', status: 'removed', sha: '1'.repeat(40), additions: 0, deletions: 3,
      patch: patchOf(LINES, []) }, { filename: destination, status: 'added', sha: blob, additions: 3, deletions: 0,
      patch: `@@ -0,0 +1,3 @@\n${edited.map(line => `+${line}`).join('\n')}` }],
    delete: [{ filename: 'a/x.yaml', status: 'removed', sha: '1'.repeat(40), additions: 0, deletions: 3, patch: patchOf(LINES, []) }],
    edit: [{ filename: 'a/x.yaml', status: 'modified', sha: '2'.repeat(40), additions: 1, deletions: 3,
      patch: '@@ -1,3 +1 @@\n-name: sample\n-kind: widget\n-owner: team\n+name: renamed' }],
  }[shape];
  const finalFiles = { rename: [{ ...commitFiles[0], previous_filename: undefined, status: 'added', additions: 3, deletions: 0,
    patch: `@@ -0,0 +1,3 @@\n${edited.map(line => `+${line}`).join('\n')}` }],
  split: [commitFiles[1]], delete: [], edit: [{ ...added, sha: '2'.repeat(40), additions: 1,
    patch: '@@ -0,0 +1 @@\n+name: renamed' }] }[shape];
  commitFiles.push(...additionalFiles);
  finalFiles.push(...additionalFiles);
  const trailers = `Worker-Class: hammer\nWorker-Ticket: HAM\nReviewed-Head: ${reviewedHead}\n`
    + (cite ? 'Reversal-Authorized-By: PRR_fixture finding=1 kind=non-blocking' : '');
  const commit = (sha, parent, message, files, login) => ({ sha, parents: [{ sha: parent }],
    author: { login }, committer: { login }, commit: { message }, files });
  const history = [
    { sha: PRIMARY, parents: [{ sha: BASE }], commit: { message: 'Add file' } },
    commit(RENAME, PRIMARY, `Rename file\n\n${trailers}`, commitFiles, author),
    ...(later ? [commit(HEAD, RENAME, 'Later repair\n\nWorker-Class: hammer\nWorker-Ticket: HAM', [], author)] : []),
  ];
  const head = later ? HEAD : RENAME;
  const review = { node_id: 'PRR_fixture', commit_id: PRIMARY, state: 'COMMENTED', user: { login: reviewer },
    body: reviewBody(citedFile) };
  const get = async path => {
    if (path === `repos/${REPO}/pulls/7`) return { base: { sha: BASE }, head: { sha: head } };
    if (path.includes('/reviews?')) return [review];
    if (path.includes('/comments?')) return [];
    const sha = path.split('/commits/')[1];
    if (sha) return structuredClone(history.find(entry => entry.sha === sha));
    const [from, to] = path.split('/compare/')[1].split('?')[0].split('...');
    if (to === PRIMARY) return { status: from === BASE ? 'ahead' : 'identical', merge_base_commit: { sha: BASE },
      total_commits: 1, commits: history.slice(0, 1), files: [added] };
    if (from === BASE) return { status: 'ahead', merge_base_commit: { sha: BASE }, total_commits: history.length,
      commits: structuredClone(history), files: to === RENAME || to === head ? finalFiles : [] };
    return { status: from === to ? 'identical' : 'ahead', merge_base_commit: { sha: BASE }, files: [] };
  };
  const collect = () => fetchPrimaryChange({ repo: REPO, prNumber: 7, headSha: head, rootDir, get },
    { fetchCiCostImpl: async () => ({ ok: true, headSha: head }) });
  return { collect, head };
}
const check = (evidence, head) => checkPrimaryChange(evidence, head, { strictNonBlockingRemediation: true });

for (const shape of ['rename', 'split', 'delete']) {
  test(`REVERSALRENAME-01: a cited ${shape} of an added file is authorized by its Reversal-Authorized-By`, async t => {
    const f = fixture(t, { shape });
    const evidence = await f.collect();
    assert.equal(evidence.reversalAuthorizations?.length, 1);
    const result = check(evidence, f.head);
    assert.equal(result.ok, true, JSON.stringify(result));
  });
  test(`REVERSALRENAME-01: an uncited ${shape} of an added file still fails closed`, async t => {
    const f = fixture(t, { shape, cite: false });
    const result = check(await f.collect(), f.head);
    assert.equal(result.reason, 'primary-change-reverted');
    assert.equal(result.missingEvidence.evidence, 'reversal-authorization');
  });
}

test('REVERSALRENAME-01: an in-place edit with the same citation passes', async t => {
  const f = fixture(t, { shape: 'edit' });
  const result = check(await f.collect(), f.head);
  assert.equal(result.ok, true, JSON.stringify(result));
});

const rejectedReasons = result => result.missingEvidence.rejected.map(entry => entry.reason);

test('REVERSALRENAME-01: a citation to a finding naming a different file is refused with a recorded reason', async t => {
  for (const shape of ['rename', 'delete']) {
    const f = fixture(t, { shape, citedFile: 'a/other.yaml' });
    const result = check(await f.collect(), f.head);
    assert.equal(result.reason, 'primary-change-reverted', shape);
    assert.equal(result.missingEvidence.accepted, 0);
    assert.deepEqual(rejectedReasons(result), ['not-covered-by-cited-finding'], shape);
    assert.match(result.missingEvidence.summary, /not-covered-by-cited-finding/);
  }
});

test('REVERSALRENAME-01: a non-authoritative reviewer, mismatched Reviewed-Head or non-hammer author never authorizes', async t => {
  const cases = [{ reviewer: 'fixture-stranger' }, { reviewedHead: 'e'.repeat(40) }, { author: 'fixture-contributor' }];
  for (const options of cases) {
    for (const shape of ['rename', 'delete']) {
      const f = fixture(t, { shape, ...options });
      const evidence = await f.collect();
      const result = check(evidence, f.head);
      assert.equal(result.reason, 'primary-change-reverted', JSON.stringify([shape, options]));
      assert.equal(result.missingEvidence.accepted, 0);
      // The citation is always accounted for: collector or evaluator names it.
      assert.equal(result.missingEvidence.rejected.length, 1, JSON.stringify([shape, options, result.missingEvidence]));
      assert.ok(result.missingEvidence.rejected[0].reason);
    }
  }
});

test('REVERSALRENAME-01: a cited rename into a test path is refused before removal coverage', async t => {
  for (const replacement of ['complete', 'partial', 'identical']) {
    const f = fixture(t, { destination: 'test/y.yaml', replacement });
    const evidence = await f.collect();
    assert.equal(evidence.reversalAuthorizations[0].commit.files[0].filename, 'test/y.yaml');
    assert.equal(evidence.finalFiles[0].filename, 'test/y.yaml');
    const result = check(evidence, f.head);
    assert.equal(result.reason, 'primary-change-reverted', replacement);
    assert.equal(result.missingEvidence.accepted, 0, replacement);
    assert.deepEqual(rejectedReasons(result), ['production-to-test-rename'], replacement);
  }
});

test('REVERSALRENAME-01: a cited identical removed-plus-added move cannot cross into tests', async t => {
  for (const destination of ['a/y.yaml', 'test/y.yaml']) {
    const f = fixture(t, { shape: 'split', replacement: 'identical', destination });
    const evidence = await f.collect();
    assert.equal(evidence.reversalAuthorizations[0].commit.files[1].filename, destination);
    assert.equal(evidence.finalFiles[0].filename, destination);
    const result = check(evidence, f.head);
    if (destination === 'a/y.yaml') assert.equal(result.ok, true, JSON.stringify(result));
    else {
      assert.equal(result.reason, 'primary-change-reverted');
      assert.equal(result.missingEvidence.accepted, 0);
      assert.deepEqual(rejectedReasons(result), ['production-to-test-rename']);
    }
  }
});

test('REVERSALRENAME-01: a cited production rename can replace every protected line', async t => {
  const f = fixture(t, { replacement: 'complete' });
  const result = check(await f.collect(), f.head);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('REVERSALRENAME-01: an unrelated added test does not prevent a cited deletion', async t => {
  const f = fixture(t, { shape: 'delete', additionalFiles: [{
    filename: 'test/deletion.test.mjs', status: 'added', sha: '3'.repeat(40), additions: 1, deletions: 0,
    patch: '@@ -0,0 +1 @@\n+// Verify the obsolete configuration is absent.',
  }] });
  const result = check(await f.collect(), f.head);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('REVERSALRENAME-01: the citation still authorizes when a later trailer-less hammer commit follows it', async t => {
  for (const shape of ['rename', 'delete']) {
    const f = fixture(t, { shape, later: true });
    const evidence = await f.collect();
    assert.equal(evidence.reversalAuthorizations.length, 1);
    const result = check(evidence, f.head);
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  const uncited = fixture(t, { shape: 'rename', cite: false, later: true });
  assert.equal(check(await uncited.collect(), uncited.head).reason, 'primary-change-reverted');
});

test('REVERSALRENAME-01: a citation kept by the collector but not applied is listed instead of reporting zero rejected', () => {
  const evidence = { headSha: HEAD, ciCost: { headSha: HEAD, ok: true }, hasHammerCommits: true, primaryHead: PRIMARY,
    mergeBase: BASE, primaryFiles: [added, { filename: 'a/unrelated.yaml', status: 'modified', additions: 1, deletions: 1,
      patch: '@@ -1 +1 @@\n-old\n+new' }], finalFiles: [],
    reversalAuthorizations: [{ commit: { sha: RENAME, commit: { message:
      'Fix\n\nReversal-Authorized-By: PRR_fixture finding=1 kind=non-blocking' } }, review: { node_id: 'PRR_fixture' } }] };
  const result = checkPrimaryChange(evidence, HEAD, { strictNonBlockingRemediation: true });
  assert.equal(result.reason, 'primary-change-reverted');
  assert.ok(result.missingEvidence.rejected.length > 0);
});

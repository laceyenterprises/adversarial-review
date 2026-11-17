import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkPrimaryChange, fetchPrimaryChange } from '../src/ama/primary-change.mjs';

const snapshot = JSON.parse(readFileSync(new URL('./fixtures/primary-change-authorized-rename/11026.json', import.meta.url), 'utf8'));
const strict = { strictNonBlockingRemediation: true };
function fixture() {
  const { source, final, review, commit, headSha, primaryHead } = structuredClone(snapshot);
  // The predicate needs only a shared merge-base identity for this direct-parent
  // proof; this synthetic SHA is not a claim about the production merge base.
  const mergeBase = 'b'.repeat(40);
  return { headSha, primaryHead, mergeBase, hasHammerCommits: true,
    primaryFiles: [source], finalFiles: [final], diagnosticCommitRange: [{ sha: commit.sha }],
    reversalAuthorizations: [{ commit, review, mergeBase, parentFiles: [source], reviewedFiles: [source] }] };
}
const check = evidence => checkPrimaryChange(evidence, evidence.headSha, strict);
const auth = evidence => evidence.reversalAuthorizations[0];

test('LAC-2212: immutable finding authorizes the edited identity rename despite aggregate added status', () => {
  const evidence = fixture();
  assert.equal(auth(evidence).commit.files[0].status, 'renamed');
  assert.equal(evidence.finalFiles[0].status, 'added');
  assert.equal(check(evidence).ok, true);
  assert.equal(checkPrimaryChange(evidence, evidence.headSha).reason, 'primary-change-reverted');
});

for (const suffix of ['', '.', '. Continue with the identity repair.', '; align the principal', ', then align the principal']) {
  test(`LAC-2212: accepts unquoted rename destination followed by ${JSON.stringify(suffix)}`, () => {
    const evidence = fixture();
    auth(evidence).review.body = auth(evidence).review.body.replace(
      /  - \*\*Recommended fix:\*\* Rename[^\n]+/,
      `  - **Recommended fix:** Rename ${evidence.primaryFiles[0].filename} to ${evidence.finalFiles[0].filename}${suffix}`);
    assert.equal(check(evidence).ok, true);
  });
}

for (const suffix of ['.backup', '.backup.', '/backup']) {
  test(`LAC-2212: refuses unquoted destination extension ${JSON.stringify(suffix)}`, () => {
    const evidence = fixture();
    auth(evidence).review.body = auth(evidence).review.body.replace(
      /  - \*\*Recommended fix:\*\* Rename[^\n]+/,
      `  - **Recommended fix:** Rename ${evidence.primaryFiles[0].filename} to ${evidence.finalFiles[0].filename}${suffix}`);
    assert.equal(check(evidence).ok, false);
  });
}

function appendToRename(evidence, { context = false, appendOnly = false } = {}) {
  const moved = auth(evidence).commit.files[0];
  if (appendOnly) {
    moved.patch = '';
    moved.additions = moved.deletions = 0;
    evidence.finalFiles[0].patch = evidence.primaryFiles[0].patch;
  }
  const hunk = context ? '@@ -10 +10,3 @@\n     desired_state: active' : '@@ -10,0 +11,2 @@';
  moved.patch += `${moved.patch ? '\n' : ''}${hunk}\n+# reviewed appendix\n+enabled: true`;
  moved.additions += 2;
  const final = evidence.finalFiles[0];
  final.patch = final.patch.replace('+1,10', '+1,12') + '\n+# reviewed appendix\n+enabled: true';
  final.additions += 2;
}

for (const context of [false, true]) {
  test(`LAC-2212: authorizes EOF append with ${context ? 'trailing' : 'zero'} context`, () => {
    const evidence = fixture();
    appendToRename(evidence, { context });
    assert.equal(check(evidence).ok, true);
  });
}

test('LAC-2212: an append-only rename can cite the last original line', () => {
  const evidence = fixture();
  appendToRename(evidence, { appendOnly: true });
  auth(evidence).review.body = auth(evidence).review.body.replace('**Lines:** `1-10`', '**Lines:** `10-10`');
  assert.equal(check(evidence).ok, true);
});

test('LAC-2212: EOF append requires finding coverage of the last original line', () => {
  const evidence = fixture();
  appendToRename(evidence);
  auth(evidence).review.body = auth(evidence).review.body.replace('**Lines:** `1-10`', '**Lines:** `1-9`');
  assert.equal(check(evidence).ok, false);
});

test('LAC-2212: insertion past EOF cannot use the EOF anchor', () => {
  const evidence = fixture();
  appendToRename(evidence);
  auth(evidence).commit.files[0].patch = auth(evidence).commit.files[0].patch.replace('-10,0 +11,2', '-11,0 +12,2');
  assert.equal(check(evidence).ok, false);
});

test('LAC-2212: offline collector retains the immutable rename authorization', async () => {
  const e = fixture();
  const { commit, review } = auth(e);
  const headSha = commit.sha;
  const compare = files => ({ merge_base_commit: { sha: e.mergeBase }, files });
  const routes = new Map([
    ['repos/fixture/repo/pulls/1', { head: { sha: headSha }, base: { sha: e.mergeBase } }],
    [`repos/fixture/repo/compare/${e.mergeBase}...${headSha}`,
      { ...compare(e.finalFiles), commits: [commit], total_commits: 1 }],
    [`repos/fixture/repo/compare/${e.mergeBase}...${e.primaryHead}`, compare(e.primaryFiles)],
    [`repos/fixture/repo/compare/${e.primaryHead}...${e.primaryHead}`, { status: 'identical' }],
    [`repos/fixture/repo/commits/${headSha}`, commit],
    ['repos/fixture/repo/pulls/1/reviews?per_page=100', [review]],
  ]);
  const evidence = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 1, headSha,
    get: async path => {
      assert.ok(routes.has(path), `unexpected read: ${path}`);
      return structuredClone(routes.get(path));
    } }, {
    fetchCiCostImpl: async () => ({ headSha, ok: true }),
    proveDerivedArtifactsImpl: async () => ({}),
    proveGeneratedBlocksImpl: async () => ({}),
    proveMigrationRenumbersImpl: async () => ({}),
    fetchDeadCodeSourcesImpl: async () => [],
  });
  assert.equal(evidence.reversalAuthorizations?.length, 1, JSON.stringify(evidence));
  assert.equal(evidence.renameProofs, undefined);
  assert.equal(checkPrimaryChange(evidence, headSha, strict).ok, true, JSON.stringify(evidence));
});

for (const [name, mutate] of Object.entries({
  'uncited rename': e => { auth(e).commit.commit.message = auth(e).commit.commit.message.replace(/^Reversal-Authorized-By:.*$/gm, ''); },
  'different reviewer': e => { auth(e).review.user.login = 'foreign-reviewer[bot]'; },
  'foreign author': e => { auth(e).commit.author.login = 'foreign-builder'; },
  'foreign committer': e => { auth(e).commit.committer.login = 'foreign-builder'; },
  'wrong reviewed head': e => { auth(e).review.commit_id = 'f'.repeat(40); },
  'unrelated parent': e => { auth(e).commit.parents[0].sha = 'f'.repeat(40); },
  'missing commit range': e => { delete e.diagnosticCommitRange; },
  'changed merge base': e => { auth(e).mergeBase = 'f'.repeat(40); },
  'rebased move without structural proof': e => { auth(e).rebased = true; },
  'missing source patch': e => { delete e.primaryFiles[0].patch; },
  'opaque destination': e => { delete e.finalFiles[0].patch; },
  'truncated rename patch': e => { auth(e).commit.files[0].additions++; },
  'capped commit files': e => { auth(e).commit.files.push(...Array.from({ length: 299 }, (_, n) => ({ filename: `other-${n}` }))); },
  'finding covers only first edited line': e => { auth(e).review.body = auth(e).review.body.replace('**Lines:** `1-10`', '**Lines:** `1-1`'); },
  'finding does not request move': e => { auth(e).review.body = auth(e).review.body.replace('**Recommended fix:** Rename', '**Recommended fix:** Keep'); },
  'finding names a different target': e => { auth(e).review.body = auth(e).review.body.replace('to `identities/grok-reviewer.yaml`', 'to `identities/other.yaml`'); },
  'finding target only shares a prefix': e => { auth(e).review.body = auth(e).review.body.replace('to `identities/grok-reviewer.yaml`', 'to `identities/grok-reviewer.yaml.backup`'); },
  'finding target differs in case': e => { auth(e).review.body = auth(e).review.body.replace('to `identities/grok-reviewer.yaml`', 'to `identities/Grok-Reviewer.yaml`'); },
  'rename request source differs in case': e => { auth(e).review.body = auth(e).review.body.replace('Rename `identities/lacey-grok-reviewer.yaml`', 'Rename `identities/Lacey-grok-reviewer.yaml`'); },
  'destination changed after HAM': e => { e.finalFiles[0].sha = 'f'.repeat(40); },
  'unaccounted destination edit': e => { e.finalFiles[0].patch = e.finalFiles[0].patch.replace('+    desired_state: active', '+    desired_state: disabled'); },
  'rename patch does not match parent bytes': e => { auth(e).commit.files[0].patch = auth(e).commit.files[0].patch.replace('-principal: lacey-grok-reviewer', '-principal: other'); },
  'existing destination collision': e => { e.primaryFiles.push({ ...e.primaryFiles[0], filename: e.finalFiles[0].filename }); },
  'modified source needs different structural proof': e => { e.primaryFiles[0].status = 'modified'; },
})) {
  test(`LAC-2212: refuses ${name}`, () => {
    const evidence = fixture();
    mutate(evidence);
    assert.equal(check(evidence).ok, false);
  });
}

test('LAC-2212: retaining the original source continues to preserve the primary change', () => {
  const evidence = fixture();
  evidence.finalFiles.push(evidence.primaryFiles[0]);
  assert.equal(check(evidence).ok, true);
});

for (const destination of ['test/grok-reviewer.yaml', 'tests/grok-reviewer.yaml', '__tests__/grok-reviewer.yaml', 'identities/grok-reviewer.test.mjs']) {
  test(`LAC-2212: explicit finding cannot authorize production move into ${destination}`, () => {
    const evidence = fixture();
    const old = evidence.finalFiles[0].filename;
    evidence.finalFiles[0].filename = destination;
    auth(evidence).commit.files[0].filename = destination;
    auth(evidence).review.body = auth(evidence).review.body.replaceAll(old, destination);
    assert.equal(check(evidence).reason, 'primary-change-reverted');
  });
}

test('LAC-2212: an authorized rename does not waive an unrelated uncited reversal', () => {
  const evidence = fixture();
  evidence.primaryFiles.push({ filename: 'src/authorization.mjs', status: 'modified', additions: 1, deletions: 1,
    patch: '@@ -1 +1 @@\n-allowAll();\n+checkIdentity();' });
  const result = check(evidence);
  assert.equal(result.reason, 'primary-change-reverted');
  assert.equal(result.path, 'src/authorization.mjs');
});

test('LAC-2212: uncited edit outside the rename finding refuses even with matching final bytes', () => {
  const evidence = fixture();
  const moved = auth(evidence).commit.files[0];
  moved.patch += '\n@@ -10 +10 @@\n-    desired_state: active\n+    desired_state: disabled';
  moved.additions++;
  moved.deletions++;
  evidence.finalFiles[0].patch = evidence.finalFiles[0].patch.replace('+    desired_state: active', '+    desired_state: disabled');
  auth(evidence).review.body = auth(evidence).review.body.replace('**Lines:** `1-10`', '**Lines:** `1-4`');
  assert.equal(check(evidence).reason, 'primary-change-reverted');
});

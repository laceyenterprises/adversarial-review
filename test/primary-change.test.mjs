import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPrimaryChange, fetchPrimaryChangeContext as fetchContext, fetchPrimaryChange as fetchPrimaryChangeWithCost, readPrimaryChangeLaunchHead, primaryChangeRoot } from '../src/ama/primary-change.mjs';
import { amaAllAuthoritativeReviewerLogins } from '../src/ama/reviewer-authority.mjs';
import { createHash } from 'node:crypto';
import { storedPrimaryChange } from '../src/ama/primary-change-store.mjs';
import { writeAmaAuditEntry } from '../src/ama/audit.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { primaryChangeFixture, primaryRenameRepository } from './helpers/primary-change.mjs';
import { decideClosureOwner } from '../src/ama/closure-owner.mjs';
const head = 'c'.repeat(40);

test('PRIMARYRENAME-01: an added-file rename loses the builder path in the base-to-head diff', async t => {
  const fixture = primaryRenameRepository(t);
  const evidence = await fetchPrimaryChange(fixture.args);
  assert.equal(evidence.primaryHead, fixture.builder);
  assert.equal(evidence.primaryFiles[0].filename, fixture.source);
  assert.equal(evidence.primaryFiles[0].sha, fixture.blob);
  assert.equal(evidence.finalFiles[0].filename, fixture.destination);
  assert.equal(evidence.finalFiles[0].status, 'added');
  assert.equal(evidence.finalFiles[0].sha, fixture.blob);
  // Removing just the new commit proof reproduces the old refusal exactly.
  const { renameProofs, ...oldEvidence } = evidence;
  assert.equal(renameProofs.length, 1);
  assert.equal(checkPrimaryChange(oldEvidence, fixture.args.headSha).reason, 'primary-change-reverted');
  assert.equal(decideClosureOwner({ primaryChange: oldEvidence, currentHead: fixture.args.headSha }).reason,
    'primary-change-needs-operator');
  assert.equal(checkPrimaryChange(evidence, fixture.args.headSha).ok, true);
  assert.equal(isEligibleForAmaClosure({ headSha: fixture.args.headSha, verdict: 'approved', riskClass: 'low',
    remediationPending: false, blockingFindingState: 'known', blockingFindingCount: 0,
    nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 },
  { headSha: fixture.args.headSha, isOpen: true, mergeableState: 'MERGEABLE', labels: [],
    statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }] },
  { enabled: true, eligibility: { riskClasses: ['low'] }, branchProtection: { required: false } },
  { primaryChange: evidence }).eligible, true);
  assert.equal(decideClosureOwner({ primaryChange: evidence, currentHead: fixture.args.headSha,
    reviewState: { verdict: 'approved', headSha: fixture.args.headSha,
      blockingFindingState: 'known', blockingFindingCount: 0,
      nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 } }).owner, 'daemon-merge');
});

test('PRIMARYRENAME-01: identical renames preserve modified files and survive later unrelated hammer repairs', async t => {
  for (const options of [{ modified: true }, { laterHammer: true }, { binary: true },
    { author: null }, { committer: 'web-flow', verification: { verified: true, reason: 'valid' } }]) {
    const fixture = primaryRenameRepository(t, options);
    const evidence = await fetchPrimaryChange(fixture.args);
    assert.equal(checkPrimaryChange(evidence, fixture.args.headSha).ok, true, JSON.stringify(options));
    assert.equal(evidence.renameProofs[0].commit.sha, fixture.renameSha);
  }
});

test('PRIMARYRENAME-01: web-flow verification is added only to rename proof, never legacy commit evidence', async t => {
  const fixture = primaryRenameRepository(t, { committer: 'web-flow', verification: { verified: true, reason: 'valid' } });
  const path = `repos/fixture/repo/commits/${fixture.renameSha}`;
  assert.equal((await fixture.args.get(path)).commit.verification, undefined);
  const evidence = await fetchPrimaryChange(fixture.args);
  assert.deepEqual(evidence.renameProofs[0].commit.commit.verification, { verified: true, reason: 'valid' });
  assert.equal(checkPrimaryChange(evidence, fixture.args.headSha).ok, true);
  assert.equal((await fixture.args.get(path)).commit.verification, undefined);
});

test('PRIMARYRENAME-01: restoring a modified path to base is not absence, even with its old blob at a new path', async t => {
  const fixture = primaryRenameRepository(t, { modified: true, restored: true });
  const evidence = await fetchPrimaryChange(fixture.args);
  assert.equal(evidence.finalFiles.some(file => file.filename === fixture.source), false);
  assert.equal(evidence.finalFiles[0].sha, fixture.blob);
  assert.equal(evidence.renameProofs, undefined);
  assert.equal(checkPrimaryChange(evidence, fixture.args.headSha).reason, 'primary-change-reverted');
});

test('PRIMARYRENAME-01: changed bytes, deletion, foreign identity and an existing content match retain the refusal', async t => {
  for (const options of [{ changed: true }, { deleted: true },
    { author: 'fixture-contributor' }, { author: 'fixture-contributor', laterHammer: true },
    { committer: 'fixture-contributor' }, { author: null, committer: null },
    { committer: 'web-flow', verification: { verified: false, reason: 'unsigned' } },
    { existingDestination: true }]) {
    const fixture = primaryRenameRepository(t, options);
    const evidence = await fetchPrimaryChange(fixture.args);
    const refusal = checkPrimaryChange(evidence, fixture.args.headSha);
    assert.equal(refusal.reason, 'primary-change-reverted', JSON.stringify(options));
    assert.equal(refusal.missingEvidence.path, fixture.source);
    assert.ok(refusal.missingEvidence.summary.includes(fixture.source));
    assert.ok(refusal.missingEvidence.summary.includes(fixture.renameSha), JSON.stringify(options) + ': ' + refusal.missingEvidence.summary);
    assert.ok(refusal.missingEvidence.summary.includes(options.author === null ? 'Fixture Author'
      : options.author || 'hammer-worker'));
    assert.equal(refusal.missingEvidence.summary.includes(`${fixture.args.headSha} author=`),
      !options.laterHammer, 'attribute the removing commit rather than the later head');
    assert.equal(decideClosureOwner({ primaryChange: evidence, currentHead: fixture.args.headSha }).reason,
      'primary-change-needs-operator');
    const detailed = await fetchPrimaryChangeContext(fixture.args);
    assert.ok(checkPrimaryChange(detailed, fixture.args.headSha).missingEvidence.summary.includes(fixture.renameSha));
  }
});

test('PRIMARYRENAME-01: unavailable or incomplete optional rename proof leaves the old refusal intact', async t => {
  for (const kind of ['unavailable', 'capped', 'foreign-full-commit', 'wrong-sha', 'outside-range']) {
    const fixture = primaryRenameRepository(t, { laterHammer: true });
    const get = async path => {
      if (path.endsWith(`/commits/${fixture.renameSha}`)) {
        if (kind === 'unavailable') throw new Error('Fixture commit unavailable');
        const commit = await fixture.args.get(path);
        if (kind === 'capped') return { ...commit, filesComplete: false, files: Array(300).fill(commit.files[0]) };
        if (kind === 'foreign-full-commit') return { ...commit, author: { login: 'fixture-contributor' } };
        if (kind === 'wrong-sha') return { ...commit, sha: 'f'.repeat(40) };
        return { ...commit, parents: [{ sha: 'f'.repeat(40) }] };
      }
      if (path.endsWith(`${fixture.builder}...${'f'.repeat(40)}`)) return { status: 'diverged' };
      return fixture.args.get(path);
    };
    const evidence = await fetchPrimaryChange({ ...fixture.args, get });
    assert.equal(checkPrimaryChange(evidence, fixture.args.headSha).reason, 'primary-change-reverted', kind);
  }
});

test('PRIMARYRENAME-01: evaluator rechecks identity, exact blob, source absence and range membership', async t => {
  const fixture = primaryRenameRepository(t);
  const evidence = await fetchPrimaryChange(fixture.args);
  for (const mutate of [
    proof => { proof.renameProofs[0].commit.author.login = 'fixture-contributor'; },
    proof => { proof.renameProofs[0].commit.committer.login = 'fixture-contributor'; },
    proof => { proof.renameProofs[0].commit.files[0].sha = 'f'.repeat(40); },
    proof => { proof.diagnosticCommitRange = []; },
    proof => { proof.renameProofs[0].commit.parents[0].sha = 'f'.repeat(40); },
    proof => { proof.finalFiles[0].sha = 'f'.repeat(40); },
    proof => { proof.finalFiles.push({ ...proof.primaryFiles[0], sha: 'f'.repeat(40), additions: 0, patch: '' }); },
  ]) {
    const invalid = structuredClone(evidence); mutate(invalid);
    assert.equal(checkPrimaryChange(invalid, fixture.args.headSha).reason, 'primary-change-reverted');
  }
});

test('PRIMARYRENAME-01: a cached pre-rename refusal is recomputed once and the new proof is reused', async t => {
  const fixture = primaryRenameRepository(t);
  const evidence = await fetchPrimaryChange({ ...fixture.args, get: path => fixture.args.get(path) });
  const legacy = structuredClone(evidence);
  delete legacy.renameProofs;
  delete legacy.ciCost;
  const directory = join(fixture.rootDir, 'data', 'primary-change-history');
  mkdirSync(directory, { recursive: true });
  const reviewKey = createHash('sha256').update('[]').digest('hex');
  const key = [fixture.args.repo, 1, evidence.mergeBase, fixture.args.headSha, evidence.mergeBase, reviewKey, null];
  writeFileSync(join(directory, `${createHash('sha256').update(JSON.stringify(key)).digest('hex')}.json`),
    JSON.stringify({ key, history: legacy }));
  let commitReads = 0;
  const get = Object.assign(path => {
    if (path.includes('/commits/')) commitReads += 1;
    return fixture.args.get(path);
  }, { metadata: fixture.args.get.metadata, persistPrimaryChange: true });
  const fresh = await fetchPrimaryChange({ ...fixture.args, get });
  assert.equal(checkPrimaryChange(fresh, fixture.args.headSha).ok, true);
  assert.equal(commitReads, 1, 'old disk history must not hide the missing proof');
  const reused = await fetchPrimaryChange({ ...fixture.args, get });
  assert.equal(checkPrimaryChange(reused, fixture.args.headSha).ok, true);
  assert.equal(commitReads, 1, 'new disk history reuses the commit proof');
});

test('PRIMARYRENAME-01: an optional proof read outage cannot cache a permanent refusal', async t => {
  const fixture = primaryRenameRepository(t);
  let unavailable = true;
  const get = Object.assign(path => {
    if (path.includes('/commits/') && unavailable) throw new Error('Fixture proof read outage');
    return fixture.args.get(path);
  }, { metadata: fixture.args.get.metadata, persistPrimaryChange: true });
  const refused = await fetchPrimaryChange({ ...fixture.args, get });
  assert.equal(checkPrimaryChange(refused, fixture.args.headSha).reason, 'primary-change-reverted');
  unavailable = false;
  const recovered = await fetchPrimaryChange({ ...fixture.args, get });
  assert.equal(checkPrimaryChange(recovered, fixture.args.headSha).ok, true);
});
// This suite isolates history semantics; ci-cost.test.mjs exercises the live collector.
const fetchPrimaryChange = (args) => fetchPrimaryChangeWithCost(args, {
  fetchCiCostImpl: async ({ headSha }) => ({ headSha, ok: true }),
});
const fetchPrimaryChangeContext = (args, options = {}) => fetchContext(args, {
  fetchCiCostImpl: async ({ headSha }) => ({ headSha, ok: true }),
  createDiagnosticReaderImpl: () => args.get,
  ...options,
});
function predicate(primaryChange) {
  return isEligibleForAmaClosure({ headSha: head, verdict: 'approved', riskClass: 'low',
    remediationPending: false, blockingFindingState: 'known', blockingFindingCount: 0,
    nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 },
  { headSha: head, isOpen: true, mergeableState: 'MERGEABLE', labels: [],
    statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }] },
  { enabled: true, eligibility: { riskClasses: ['low'] }, branchProtection: { required: false } },
  { primaryChange });
}
test('HAMINTENT #1207: reverting the enforcement default fails the predicate', () => {
  const evidence = primaryChangeFixture(head);
  evidence.finalFiles = [];
  const result = predicate(evidence);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('primary-change-reverted'));
});
test('additive test/doc and unrelated same-file line repairs pass', () => {
  const evidence = primaryChangeFixture(head);
  evidence.finalFiles = [{ ...evidence.finalFiles[0], additions: 2, deletions: 2,
    patch: evidence.finalFiles[0].patch + '\n-old unrelated\n+fixed unrelated' },
  { filename: 'README.md', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+Enforcement docs' },
  { filename: 'docs/illustration.png', status: 'added', additions: 0, deletions: 0 }];
  assert.equal(predicate(evidence).eligible, true);
});
test('no hammer commits is not applicable and passes', () => {
  assert.equal(predicate({ headSha: head, hasHammerCommits: false, ciCost: { headSha: head, ok: true } }).eligible, true);
});
test('unknown primary change, stale evidence, truncated patch and missing patch fail closed', () => {
  for (const evidence of [{ headSha: head, hasHammerCommits: null },
    { ...primaryChangeFixture(head), headSha: 'd'.repeat(40) },
    { ...primaryChangeFixture(head), primaryFiles: [{ filename: 'binary', additions: 1, deletions: 0 }] },
    { ...primaryChangeFixture(head), finalFiles: [{ ...primaryChangeFixture(head).finalFiles[0], additions: 99 }] }]) {
    assert.ok(predicate(evidence).reasons.includes(evidence.headSha === head ? 'primary-change-unknown' : 'primary-change-read-failed'));
  }
  assert.equal(checkPrimaryChange(null, head).ok, false);
});
test('collector selects the author head before the FIRST hammer, including repeated hammer runs', async () => {
  const evidence = primaryChangeFixture(head);
  const base = evidence.mergeBase;
  const author = evidence.primaryHead;
  const calls = [];
  const get = async (path) => {
    calls.push(path);
    if (path.endsWith('/pulls/1207')) return { head: { sha: head }, base: { sha: base } };
    if (calls.length === 2) return { merge_base_commit: { sha: base }, files: evidence.primaryFiles, total_commits: 3, commits: [
      { sha: author, commit: { message: 'worker' } },
      { sha: 'e'.repeat(40), parents: [{ sha: author }], commit: { message: 'HAM repair\n\nWorker-Class: hammer' } },
      { sha: head, parents: [{ sha: 'e'.repeat(40) }], commit: { message: 'HAM repair\n\nWorker-Class: hammer' } }] };
    return { merge_base_commit: { sha: base }, files: evidence.primaryFiles };
  };
  const result = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 1207, headSha: head, get });
  assert.equal(result.primaryHead, author);
  assert.equal(checkPrimaryChange(result, head).ok, true);
});
test('collector distinguishes read failure from unsupported history', async () => {
  for (const get of [async () => { throw new Error('offline'); }, async (path) => path.includes('/pulls/')
    ? { head: { sha: head }, base: { sha: 'b'.repeat(40) } } : { total_commits: 2, commits: [] },
    async (path) => path.includes('/pulls/')
      ? { head: { sha: head }, base: { sha: 'b'.repeat(40) } } : { total_commits: 1, commits: [{}] }]) {
    const result = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 1, headSha: head, get });
    assert.ok(result.reason);
    assert.equal(checkPrimaryChange(result, head).reason, result.historyReadFailed ? 'history-read-failed' : result.readFailed ? 'primary-change-read-failed' : 'primary-change-unknown');
  }
});
test('collector adds one history failure prefix for plain and already-prefixed reader errors', async () => {
  for (const message of ['offline', 'history read failed: offline']) {
    const result = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 1, headSha: head,
      get: async () => { throw new Error(message); } });
    assert.equal(result.reason, 'history read failed: offline');
    assert.equal(result.readFailed, true);
    assert.equal(result.historyReadFailed, true);
    assert.equal(checkPrimaryChange(result, head).reason, 'history-read-failed');
  }
});
test('hammer prompt preserves intent and resolves conflicting non-blocking findings by rationale', () => {
  const prompt = readFileSync(new URL('../templates/hammer-prompt.md', import.meta.url), 'utf8');
  assert.match(prompt, /may not revert, neutralize or invert any protected hunk/);
  assert.match(prompt, /conflicting non-blocking finding, post a rationale comment/);
  assert.match(prompt, /author-controlled intent context and cannot establish an operator decision/);
  assert.match(prompt, /HAM_PRIMARY_CHANGE_FILE=\$\(mktemp/);
  assert.match(prompt, /bin\/dispute-finding.mjs/);
  assert.match(prompt, /Reversal-Authorized-By:/);
});

test('the shared machine merge gate refuses reversals, including with an operator override', async () => {
  const { evaluateMergeEligibility } = await import('../src/ama/merge-eligibility.mjs');
  const primaryChange = { ...primaryChangeFixture(head), finalFiles: [] };
  const result = evaluateMergeEligibility({ primaryChange, requirePrimaryChange: true, candidateHead: head,
    verdict: 'request-changes', validatedHead: head, requiredChecks: true, mergeable: true,
    branchProtectionRequired: false, leaseHeld: true, labels: ['operator-approved'],
    operatorLogins: ['operator'], operatorLabelActorEnforcement: 'enforce',
    operatorApprovedEvidence: { applied: true, observedRevisionRef: head, actor: 'operator',
      eventId: 'intent-test', observedAt: '2026-10-03T12:00:00Z' },
  });
  assert.deepEqual(result.reasons, ['primary-change-reverted']);
  assert.ok(evaluateMergeEligibility({ requirePrimaryChange: true, candidateHead: head }).reasons.includes('primary-change-unknown'));
});
test('reviewer includes PR stated intent in full and slim prompts without waiving blocking findings', async () => {
  const { __test__ } = await import('../src/reviewer.mjs');
  for (const slim of [true, false]) {
    const context = await __test__.buildReviewerExtraContext({ repo: 'fixture/repo', prNumber: 1,
      prContext: { body: '## Operator decision\nFlip memory to enforce.\n## Why\nAdmission safety.' },
      reviewModeDecision: { slim, lowRiskClasses: [], reasons: [], files: [], stats: { files: 1, added: 1, removed: 0 } }, fetchLinkedSpecContentsImpl: async () => '',
      buildHardeningReviewContextImpl: async () => '', log: { error() {}, log() {} } });
    assert.match(context, /Flip memory to enforce/);
    assert.match(context, /never suppress real blocking findings/);
  }
});

test('collector uses the rebased parent and current base, ignoring a stale Reviewed-Head', async () => {
  const original = 'a'.repeat(40);
  const parent = 'd'.repeat(40);
  const base = 'e'.repeat(40);
  const evidence = primaryChangeFixture(head);
  const calls = [];
  const get = async (path) => {
    calls.push(path);
    if (path.endsWith('/pulls/1')) return { head: { sha: head }, base: { sha: base } };
    if (path.endsWith(`${base}...${parent}`)) return { merge_base_commit: { sha: base }, files: evidence.primaryFiles };
    if (path.endsWith(`${base}...${head}`)) return {
      total_commits: 1, commits: [{ sha: head, parents: [{ sha: parent }],
        commit: { message: `HAM repair\n\nWorker-Class: hammer\nReviewed-Head: ${original}` } }],
      merge_base_commit: { sha: base }, files: [] };
    throw new Error(`unexpected ${path}`);
  };
  const result = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 1, headSha: head, get });
  assert.equal(result.primaryHead, parent);
  assert.equal(checkPrimaryChange(result, head).reason, 'primary-change-reverted');
  assert.equal(calls.some((path) => path.includes(original)), false);
});

test('in-place bug, identifier and whitespace repairs preserve the author region', () => {
  for (const added of ['return foo(a ?? b);', 'return bar(a);', '    return foo(a);']) {
    const file = { filename: 'src/worker.mjs', status: 'modified', additions: 1, deletions: 1,
      patch: '@@ -10 +10 @@\n-return old();\n+return foo(a);' };
    const evidence = { ...primaryChangeFixture(head), primaryFiles: [file],
      finalFiles: [{ ...file, patch: `@@ -10 +10 @@\n-return old();\n+${added}` }] };
    assert.equal(checkPrimaryChange(evidence, head).ok, true);
  }
});

test('an author addition may be repaired but cannot disappear while another region survives', () => {
  const file = { filename: 'src/worker.mjs', status: 'modified', additions: 1, deletions: 0,
    patch: '@@ -9,1 +9,2 @@\n context\n+return foo(a);' };
  const evidence = { ...primaryChangeFixture(head), primaryFiles: [file],
    finalFiles: [{ ...file, patch: '@@ -9,1 +9,2 @@\n context\n+return foo(a ?? b);' }] };
  assert.equal(checkPrimaryChange(evidence, head).ok, true);
  evidence.finalFiles[0].patch = '@@ -29,1 +29,2 @@\n other context\n+return foo(a);';
  assert.equal(checkPrimaryChange(evidence, head).reason, 'primary-change-reverted');
});

test('restoring one removed occurrence fails even if another identical removal survives', () => {
  const file = { filename: 'src/worker.mjs', status: 'modified', additions: 0, deletions: 2,
    patch: '@@ -10,2 +9,0 @@\n-old\n-old' };
  const evidence = { ...primaryChangeFixture(head), primaryFiles: [file],
    finalFiles: [{ ...file, deletions: 1, patch: '@@ -10 +9,0 @@\n-old' }] };
  assert.equal(checkPrimaryChange(evidence, head).reason, 'primary-change-reverted');
});

test('renames track original paths, allow further renaming, and detect restoration', () => {
  const file = { filename: 'new.txt', previous_filename: 'old.txt', status: 'renamed', additions: 0, deletions: 0 };
  const evidence = { ...primaryChangeFixture(head), primaryFiles: [file], finalFiles: [file] };
  assert.equal(checkPrimaryChange(evidence, head).ok, true);
  evidence.finalFiles = [{ ...file, filename: 'newer.txt' }];
  assert.equal(checkPrimaryChange(evidence, head).ok, true);
  evidence.finalFiles = [];
  assert.equal(checkPrimaryChange(evidence, head).reason, 'primary-change-reverted');
});


test('insertion coordinates agree with and without surrounding diff context', () => {
  const file = { filename: 'src/worker.mjs', status: 'modified', additions: 1, deletions: 0,
    patch: '@@ -9,0 +10 @@\n+return foo(a);' };
  const evidence = { ...primaryChangeFixture(head), primaryFiles: [file],
    finalFiles: [{ ...file, patch: '@@ -9,1 +9,2 @@\n context\n+return foo(a ?? b);' }] };
  assert.equal(checkPrimaryChange(evidence, head).ok, true);
});

test('closer dispatch retries failed reads and escalates deterministic unknown evidence', async () => {
  const { maybeDispatchAmaCloser } = await import('../src/ama/dispatch-closer.mjs');
  for (const readFailed of [true, false]) {
    const result = await maybeDispatchAmaCloser({
      reviewState: { headSha: head, verdict: 'approved', riskClass: 'low',
        remediationPending: false, blockingFindingState: 'known', blockingFindingCount: 0,
        nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 },
      prMetadata: { prNumber: 1, headSha: head, isOpen: true, mergeableState: 'MERGEABLE', labels: [],
        statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }] },
      cfg: { enabled: true, eligibility: { riskClasses: ['low'] }, branchProtection: { required: false } },
      options: { primaryChange: { headSha: head, hasHammerCommits: null, readFailed } },
      dispatchContext: { repo: 'fixture/repo' },
    });
    assert.equal(result.skipMergeAgent, true);
    assert.equal(result.reason, readFailed ? 'gate-read-failed' : 'primary-change-repair-required');
    assert.equal(result.needsOperator === true, !readFailed);
  }
});


test('all failed reads defer while head races stay distinct', async () => {
  for (const message of ['HTTP 403 forbidden', 'HTTP 404 not found', 'invalid JSON', 'HTTP 401']) {
    const result = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 1, headSha: head,
      get: async () => { throw new Error(message); } });
    assert.equal(checkPrimaryChange(result, head).reason, 'history-read-failed');
  }
  const transient = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 1, headSha: head,
    get: async () => { throw new Error('HTTP 503'); } });
  assert.equal(checkPrimaryChange(transient, head).reason, 'history-read-failed');
  const raced = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 1, headSha: head,
    get: async () => ({ head: { sha: 'a'.repeat(40) } }) });
  assert.equal(checkPrimaryChange(raced, head).reason, 'primary-change-read-failed');
});

test('renamed primary paths normalize subsequent previous_filename keys', () => {
  const file = { filename: 'new.txt', previous_filename: 'old.txt', status: 'renamed', additions: 1, deletions: 1,
    patch: '@@ -10 +10 @@\n-old\n+new' };
  const evidence = { ...primaryChangeFixture(head), primaryFiles: [file],
    finalFiles: [{ ...file, previous_filename: 'new.txt', filename: 'newer.txt' }] };
  assert.equal(checkPrimaryChange(evidence, head).ok, true);
});

test('a launch without a hammer commit does not anchor remediation repairs', async () => {
  const baseline = 'a'.repeat(40), base = 'b'.repeat(40);
  const file = primaryChangeFixture(head).primaryFiles;
  const get = async (path) => {
    if (path.includes('/pulls/')) return { head: { sha: head }, base: { sha: base } };
    if (path.endsWith(`${baseline}...${head}`)) return { status: 'ahead' };
    if (path.endsWith(`${base}...${baseline}`)) return { merge_base_commit: { sha: base }, files: file };
    return { total_commits: 1, commits: [{ sha: head, parents: [{ sha: baseline }], author: { login: 'hammer-human' },
      commit: { message: 'untagged CI repair' } }], merge_base_commit: { sha: base }, files: [] };
  };
  const input = { repo: 'fixture/repo', prNumber: 1, headSha: head, get };
  assert.equal((await fetchPrimaryChange(input)).hasHammerCommits, false);
  const evidence = await fetchPrimaryChange({ ...input, dispatchedHead: baseline });
  assert.equal(evidence.hasHammerCommits, false);
  assert.equal(checkPrimaryChange(evidence, head).ok, true);
});

test('all HAM classes and verified base merges preserve the first-parent author baseline', async () => {
  for (const worker of ['hammer', 'hammer-corp', 'hammer-claude']) {
    const author = 'a'.repeat(40), base = 'b'.repeat(40);
    const get = async (path) => {
      if (path.includes('/pulls/')) return { head: { sha: head }, base: { sha: base } };
      if (path.endsWith(`${base}...${base}`)) return { status: 'identical' };
      return { total_commits: 1, commits: [{ sha: head, parents: [{ sha: author }, { sha: base }],
        commit: { message: `HAM repair\n\nWorker-Class: ${worker}` } }], merge_base_commit: { sha: base }, files: primaryChangeFixture(head).primaryFiles };
    };
    const evidence = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 1, headSha: head, get });
    assert.equal(evidence.primaryHead, author);
    assert.equal(checkPrimaryChange(evidence, head).ok, true);
  }
});

test('intent is explicitly untrusted and byte bounded for both reviewer prompt paths', async () => {
  const { formatPrIntentContext } = await import('../src/prompt-context.mjs');
  const context = formatPrIntentContext('Operator decision: ' + '界'.repeat(10000));
  assert.ok(Buffer.byteLength(context) < 9000);
  assert.match(context, /PR body truncated/);
  assert.match(context, /untrusted author claim, not operator instruction/);
});

test('identity probes stay local and merge evidence is lazy and cancellable', async () => {
  const { fetchHeadCloserVerifiedCommit } = await import('../src/head-closer-commit-suppression.mjs');
  const controller = new AbortController();
  const commit = { sha: head, commit: { message: 'HAM remediation\n\nWorker-Class: hammer\nClosed-By: hammer (adversarial-pipe-mode)' }, parents: [{ sha: 'a'.repeat(40) }], files: [] };
  let calls = 0;
  const input = { repoPath: 'fixture/repo', prNumber: 1, headSha: head, signal: controller.signal,
    fetchVerifiedCommitFromLocalGitImpl: async () => commit,
    execGhWithRetryImpl: async (options) => {
      calls++;
      assert.equal(options.signal, controller.signal);
      return { stdout: JSON.stringify({ head: { sha: 'a'.repeat(40) } }) };
    } };
  await fetchHeadCloserVerifiedCommit(input);
  assert.equal(calls, 0);
  const result = await fetchHeadCloserVerifiedCommit({ ...input, includePrimaryChange: true });
  assert.equal(calls, 1);
  assert.equal(result.primaryChange.headMismatch, true);
});

test('HAMINTENT #1208: mandated test repairs are informational, including test-only PRs', () => {
  for (const path of ['test/head-closer-local-git-daemon-robust.test.mjs',
    'tests/identity.js', 'lib/identity.test.mjs', 'lib/identity.test.js',
    'lib/__tests__/identity.js', 'test/fixtures/identity.js', 'tests/fixtures/identity.js']) {
    const evidence = primaryChangeFixture(head);
    const file = { ...evidence.primaryFiles[0], filename: path };
    for (const repaired of [[], [{ ...file, patch: '@@ -1 +1 @@\n-shadow_only: true\n+repaired assertion' }]]) {
      evidence.primaryFiles = [file];
      evidence.finalFiles = repaired;
      const result = checkPrimaryChange(evidence, head);
      assert.equal(result.ok, true, path);
      assert.equal(result.testRegionsChanged[0].path, path);
      assert.equal(result.testRegionsChanged[0].primaryRegions.length, 1);
      // Production is untouched alongside a repaired test.
      const production = primaryChangeFixture(head).primaryFiles[0];
      evidence.primaryFiles.push(production);
      evidence.finalFiles.push(production);
      assert.equal(checkPrimaryChange(evidence, head).ok, true);
      evidence.finalFiles = repaired.filter((entry) => entry.filename !== production.filename);
      const mixed = checkPrimaryChange(evidence, head);
      assert.equal(mixed.reason, 'primary-change-reverted');
      assert.equal(mixed.path, 'src/config-loader.mjs');
      assert.equal(mixed.testRegionsChanged[0].path, path);
    }
  }
});

test('HAMINTENT-01R: restoring the local identity assertion preserves production intent', () => {
  const evidence = primaryChangeFixture(head);
  const production = evidence.primaryFiles[0];
  const identityTest = {
    filename: 'test/head-closer-local-git-daemon-robust.test.mjs',
    status: 'modified', additions: 1, deletions: 1,
    patch: '@@ -1 +1 @@\n-assert.equal(ghCalled, false);\n+assert.equal(ghCalled, true);',
  };
  evidence.primaryFiles = [identityTest, production];
  // The mandated repair restores the assertion to its merge-base value.
  evidence.finalFiles = [production];
  const repaired = checkPrimaryChange(evidence, head);
  assert.equal(repaired.ok, true);
  assert.deepEqual(repaired.testRegionsChanged, [{
    path: identityTest.filename, primaryRegions: [{ start: 1, end: 2 }], finalRegions: [],
  }]);

  // The same repair must not excuse the #1207 production config reversal.
  evidence.finalFiles = [];
  const reverted = checkPrimaryChange(evidence, head);
  assert.equal(reverted.reason, 'primary-change-reverted');
  assert.equal(reverted.path, 'src/config-loader.mjs');
  assert.deepEqual(reverted.testRegionsChanged, repaired.testRegionsChanged);
});

test('production-like names and root fixtures remain protected', () => {
  for (const filename of ['fixtures/config.js', 'src/test-helper.js', 'src/testing/config.js']) {
    const evidence = primaryChangeFixture(head);
    evidence.primaryFiles[0].filename = filename;
    evidence.finalFiles = [];
    assert.equal(checkPrimaryChange(evidence, head).reason, 'primary-change-reverted');
  }
});

test('HAMINTENT-01R: collector reports restored and newly added test regions', async () => {
  const evidence = primaryChangeFixture(head);
  const production = evidence.primaryFiles[0];
  const restored = { ...production, filename: 'test/identity.test.mjs' };
  const added = { filename: 'tests/fixtures/identity.js', status: 'added',
    additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+assert.equal(ghCalled, false);' };
  const result = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 1208,
    headSha: head, get: async (path) => {
      if (path.endsWith('/pulls/1208')) {
        return { head: { sha: head }, base: { sha: evidence.mergeBase } };
      }
      if (path.endsWith(`${evidence.mergeBase}...${head}`)) {
        return { total_commits: 1, commits: [{ sha: head,
          parents: [{ sha: evidence.primaryHead }],
          commit: { message: 'Mandated test repair\n\nWorker-Class: hammer' } }],
        merge_base_commit: { sha: evidence.mergeBase }, files: [production, added] };
      }
      assert.ok(path.endsWith(`${evidence.mergeBase}...${evidence.primaryHead}`));
      return { merge_base_commit: { sha: evidence.mergeBase }, files: [production, restored] };
    } });
  assert.deepEqual(result.testRegionsChanged, [
    { path: restored.filename, primaryRegions: [{ start: 1, end: 2 }], finalRegions: [] },
    { path: added.filename, primaryRegions: [], finalRegions: [{ start: 0, end: 0 }] },
  ]);
  const checked = checkPrimaryChange(result, head);
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.testRegionsChanged, result.testRegionsChanged);
});

test('renaming production into a test directory cannot waive preservation', () => {
  const evidence = primaryChangeFixture(head);
  evidence.finalFiles = [{ ...evidence.primaryFiles[0], status: 'renamed',
    previous_filename: 'src/config-loader.mjs', filename: 'test/config-loader.mjs',
    additions: 0, deletions: 0, patch: '' }];
  assert.equal(checkPrimaryChange(evidence, head).reason, 'primary-change-reverted');
});


test('installation auth outage and cancellation defer primary evidence', async () => {
  for (const error of [Object.assign(new Error('HTTP 401'), { authOutage: true }),
    Object.assign(new Error('cancelled'), { name: 'AbortError' }),
    Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' })]) {
    const evidence = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 1, headSha: head,
      get: async () => { throw error; } });
    assert.equal(checkPrimaryChange(evidence, head).reason, 'history-read-failed');
  }
});

test('opaque primary assets require the identical trusted blob and status', () => {
  const file = { filename: 'asset.png', sha: 'a'.repeat(40), status: 'added', additions: 0, deletions: 0 };
  const evidence = { ...primaryChangeFixture(head), primaryFiles: [file], finalFiles: [{ ...file }] };
  assert.equal(checkPrimaryChange(evidence, head).ok, true);
  evidence.finalFiles[0].sha = 'b'.repeat(40);
  assert.equal(checkPrimaryChange(evidence, head).reason, 'primary-change-unknown');
  evidence.finalFiles = [];
  assert.equal(checkPrimaryChange(evidence, head).reason, 'primary-change-reverted');
});

test('rebased HAM head falls back from diverged launch to the rebased first HAM parent', async () => {
  const launch = 'd'.repeat(40), author = 'a'.repeat(40), base = 'b'.repeat(40);
  const file = primaryChangeFixture(head).primaryFiles;
  const evidence = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 1, headSha: head,
    dispatchedHead: launch, get: async (path) => {
      if (path.includes('/pulls/')) return { head: { sha: head }, base: { sha: base } };
      if (path.endsWith(`${launch}...${head}`)) return { status: 'diverged' };
      return { total_commits: 1, commits: [{ sha: head, parents: [{ sha: author }],
        commit: { message: 'HAM repair\n\nWorker-Class: hammer' } }],
        merge_base_commit: { sha: base }, files: file };
    } });
  assert.equal(evidence.primaryHead, author);
  assert.equal(checkPrimaryChange(evidence, head).ok, true);
});

test('ancestor launch with a stale merge base uses the rebased HAM parent', async () => {
  const launch = 'd'.repeat(40), author = 'a'.repeat(40), base = 'b'.repeat(40);
  const file = primaryChangeFixture(head).primaryFiles;
  const evidence = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 1, headSha: head,
    dispatchedHead: launch, get: async (path) => {
      if (path.includes('/pulls/')) return { head: { sha: head }, base: { sha: base } };
      if (path.endsWith(`${launch}...${head}`)) return { status: 'ahead' };
      if (path.endsWith(`${base}...${launch}`)) return { merge_base_commit: { sha: '9'.repeat(40) }, files: file };
      return { total_commits: 1, commits: [{ sha: head, parents: [{ sha: author }],
        commit: { message: 'HAM repair\n\nWorker-Class: hammer' } }],
        merge_base_commit: { sha: base }, files: file };
    } });
  assert.equal(evidence.primaryHead, author);
  assert.equal(checkPrimaryChange(evidence, head).ok, true);
});

test('quoted HAM trailer outside terminal trailer block is not HAM authority', async () => {
  const base = 'b'.repeat(40);
  const evidence = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 1, headSha: head,
    get: async (path) => path.includes('/pulls/')
      ? { head: { sha: head }, base: { sha: base } }
      : { total_commits: 1, commits: [{ sha: head, commit: {
        message: 'Example\n\nWorker-Class: hammer\n\nThis is quoted documentation.' } }] } });
  assert.equal(evidence.hasHammerCommits, false);
});


test('launch records alone do not anchor a primary change', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'primary-launch-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const directory = join(rootDir, 'data', 'follow-up-jobs', 'ama-closer-dispatches');
  mkdirSync(directory, { recursive: true });
  const baseline = 'a'.repeat(40), base = 'b'.repeat(40);
  for (const [index, record] of [
    { repo: 'fixture/repo', prNumber: 1, workerClass: 'hammer',
      dispatchedAt: '2026-10-01T00:00:00Z', targetRemediationSha: baseline },
    { repo: 'fixture/repo', prNumber: 1, workerClass: 'hammer',
      dispatchedAt: '2026-10-02T00:00:00Z', targetRemediationSha: head },
  ].entries()) writeFileSync(join(directory, `fixture__repo-pr-1-${index}.json`), JSON.stringify(record));
  assert.equal(readPrimaryChangeLaunchHead(rootDir, 'fixture/repo', 1), baseline);
  const evidence = await fetchPrimaryChange({ rootDir, repo: 'fixture/repo', prNumber: 1, headSha: head,
    get: async (path) => {
      if (path.includes('/pulls/')) return { head: { sha: head }, base: { sha: base } };
      if (path.endsWith(`${baseline}...${head}`)) return { status: 'ahead' };
      return { total_commits: 2, commits: [
        { sha: 'e'.repeat(40), commit: { message: 'builder change' } },
        { sha: head, commit: { message: 'remediation worker repair after no-op launch' } }],
        merge_base_commit: { sha: base }, files: primaryChangeFixture(head).primaryFiles };
    } });
  assert.equal(evidence.hasHammerCommits, false);
  assert.equal(checkPrimaryChange(evidence, head).ok, true);
});

test('HAM-like subject without a provenance trailer is not HAM authority', async () => {
  const result = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 1, headSha: head,
    get: async (path) => path.includes('/pulls/')
      ? { head: { sha: head }, base: { sha: 'b'.repeat(40) } }
      : { total_commits: 1, commits: [{ sha: head, commit: { message: 'Worker-Class: hammer' } }] } });
  assert.equal(result.hasHammerCommits, false);
});


test('legacy record reader skips malformed records and unused launch I/O cannot poison history', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'primary-record-errors-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const directory = join(rootDir, 'data', 'follow-up-jobs', 'ama-closer-dispatches');
  mkdirSync(directory, { recursive: true });
  const record = { repo: 'fixture/repo', prNumber: 1, workerClass: 'hammer',
    dispatchedAt: '2026-10-01T00:00:00Z' };
  writeFileSync(join(directory, 'fixture__repo-pr-1-legacy.json'), JSON.stringify(record));
  writeFileSync(join(directory, 'fixture__repo-pr-1-corrupt.json'), '{partial');
  writeFileSync(join(directory, 'fixture__repo-pr-1-valid.json'), JSON.stringify({ ...record,
    dispatchedAt: '2026-10-02T00:00:00Z', targetRemediationSha: 'a'.repeat(40) }));
  assert.equal(readPrimaryChangeLaunchHead(rootDir, 'fixture/repo', 1), 'a'.repeat(40));
  // A directory named as a record deterministically produces EISDIR even as root.
  mkdirSync(join(directory, 'fixture__repo-pr-1-io.json'));
  const evidence = await fetchPrimaryChange({ rootDir, repo: 'fixture/repo', prNumber: 1,
    headSha: head, get: async (path) => path.includes('/pulls/')
      ? { head: { sha: head }, base: { sha: 'b'.repeat(40) } }
      : { total_commits: 0, commits: [] } });
  assert.equal(evidence.hasHammerCommits, false);
});

test('compare cache is evaluation-local and runtime roots honor explicit and environment values', async () => {
  const evidence = primaryChangeFixture(head);
  const calls = [];
  const get = async (path) => {
    calls.push(path);
    if (path.includes('/pulls/')) return { head: { sha: head }, base: { sha: evidence.mergeBase } };
    return { total_commits: 1, commits: [{ sha: head, parents: [{ sha: evidence.primaryHead }],
      commit: { message: 'repair\n\nWorker-Class: hammer' } }],
    merge_base_commit: { sha: evidence.mergeBase }, files: evidence.primaryFiles };
  };
  for (let i = 0; i < 2; i += 1) {
    assert.equal(checkPrimaryChange(await fetchPrimaryChange({ repo: 'fixture/repo',
      prNumber: 1, headSha: head, get }), head).ok, true);
  }
  assert.equal(calls.length, 6); // PR, history/final, primary: fresh on each evaluation.
  assert.equal(primaryChangeRoot({ env: { HAM_ROOT_DIR: '/runtime' } }), '/runtime');
  assert.equal(primaryChangeRoot({ rootDir: '/explicit', env: { HAM_ROOT_DIR: '/runtime' } }), '/explicit');
});

test('a remediation rebase after a launch with no hammer commit remains known', async () => {
  const evidence = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 1, headSha: head,
    dispatchedHead: 'd'.repeat(40), get: async (path) => path.includes('/pulls/')
      ? { head: { sha: head }, base: { sha: 'b'.repeat(40) } }
      : path.includes('d'.repeat(40)) ? { status: 'diverged' }
        : { total_commits: 1, commits: [{ sha: head, commit: { message: 'untagged repair' } }] } });
  assert.equal(evidence.hasHammerCommits, false);
});


test('PRIMARYCHG-01: remediation after hammer and second launch preserve the first hammer parent', async () => {
  const base = 'b'.repeat(40), author = 'a'.repeat(40), hammer = 'e'.repeat(40);
  const files = primaryChangeFixture(head).primaryFiles;
  const evidence = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 1, headSha: head,
    dispatchedHead: hammer, get: async (path) => {
      if (path.includes('/pulls/')) return { head: { sha: head }, base: { sha: base } };
      if (path.endsWith(`${base}...${author}`)) return { merge_base_commit: { sha: base }, files };
      return { total_commits: 3, commits: [
        { sha: author, commit: { message: 'builder and remediation changes' } },
        { sha: hammer, author: { login: 'merge-agent-lacey' }, parents: [{ sha: author }],
          commit: { message: 'repair\n\nClosed-By: hammer (adversarial-pipe-mode)' } },
        { sha: head, parents: [{ sha: hammer }], commit: { message: 'remediation worker repair' } },
      ], merge_base_commit: { sha: base }, files };
    } });
  assert.equal(evidence.hasHammerCommits, true);
  assert.equal(evidence.primaryHead, author);
  assert.equal(checkPrimaryChange(evidence, head).ok, true);
  assert.equal(checkPrimaryChange({ ...evidence, finalFiles: [] }, head).reason, 'primary-change-reverted');
});

test('PRIMARYEMPTY-01: PR 8064 owner-lane builder and unlinked remediation remain merge eligible', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'primaryempty-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const builder = '679e1d8a' + '1'.repeat(32), base = '9bc619416fda58408a31082f71ebde94f24d533a';
  const evidence = await fetchPrimaryChange({ rootDir, repo: 'fixture/repo', prNumber: 8064,
    headSha: head, builderHead: builder, get: async path => path.includes('/pulls/')
      ? { head: { sha: head }, base: { sha: base } }
      : { total_commits: 2, commits: [
        { sha: builder, parents: [{ sha: base }], author: { login: 'clio-airlock' },
          committer: { login: 'clio-airlock' }, commit: { message: 'Stand up paddock',
            author: { name: 'Clio-airlock' }, committer: { name: 'Clio-airlock' } } },
        { sha: head, parents: [{ sha: builder }], author: null, committer: null,
          commit: { message: 'Review repair\n\nWorker-Class: codex-remediation',
            author: { name: 'Codex Remediation Worker' } } },
      ], merge_base_commit: { sha: base }, files: primaryChangeFixture(head).primaryFiles } });
  assert.equal(evidence.hasHammerCommits, false);
  assert.equal(predicate(evidence).eligible, true);
});

for (const useLedger of [true, false]) test(`PRIMARYEMPTY-01: launch-proven untagged HAM after builder protects primary (ledger=${useLedger})`, async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'primaryempty-launch-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const directory = join(rootDir, 'data/follow-up-jobs/ama-closer-dispatches');
  mkdirSync(directory, { recursive: true });
  const builder = 'a'.repeat(40), base = 'b'.repeat(40);
  writeFileSync(join(directory, 'fixture__repo-pr-1-first.json'), JSON.stringify({
    repo: 'fixture/repo', prNumber: 1, workerClass: 'hammer',
    dispatchedAt: '2026-10-11T08:40:00Z', targetRemediationSha: builder,
  }));
  const files = primaryChangeFixture(head).primaryFiles;
  const evidence = await fetchPrimaryChange({ rootDir, repo: 'fixture/repo', prNumber: 1,
    headSha: head, ...(useLedger ? { builderHead: builder } : {}), get: async path => {
      if (path.includes('/reviews?')) return [
        { user: { login: 'clio-airlock' }, commit_id: base, submitted_at: '2026-10-11T08:30:00Z' },
        { user: { login: amaAllAuthoritativeReviewerLogins()[0] }, commit_id: builder, submitted_at: '2026-10-11T08:35:00Z' },
      ];
      if (path.includes('/pulls/')) return { head: { sha: head }, base: { sha: base } };
      if (path.endsWith(`${base}...${builder}`)) return { merge_base_commit: { sha: base }, files };
      return { total_commits: 2, commits: [
        { sha: builder, parents: [{ sha: base }], author: { login: 'clio-airlock' }, commit: { message: 'builder' } },
        { sha: head, parents: [{ sha: builder }], author: { login: 'clio-airlock' }, commit: { message: `untagged hammer push\n\nReviewed-Head: ${base}` } },
      ], merge_base_commit: { sha: base }, files };
    } });
  assert.equal(evidence.primaryHead, builder);
  assert.equal(checkPrimaryChange(evidence, head).ok, true);
  assert.equal(checkPrimaryChange({ ...evidence, finalFiles: [] }, head).reason, 'primary-change-reverted');
});


test('HAMPREDICATE-01: an earlier recorded repair owns the reverted data region, not the later hammer', async t => {
  const root = mkdtempSync(join(tmpdir(), 'primary-repair-diagnostic-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = 'd'.repeat(40), builder = 'a'.repeat(40), earlier = 'e'.repeat(40);
  const file = { filename: 'data/entries.txt', status: 'modified', additions: 2, deletions: 1,
    patch: '@@ -10 +10,2 @@\n-entry marker\n+entry\n+marker' };
  const earlierCommit = { sha: earlier, author: { login: 'hammer-worker' }, parents: [{ sha: builder }],
    commit: { message: 'Join marker onto covered line\n\nWorker-Class: hammer\nWorker-Ticket: HAM\nClosed-By: hammer (adversarial-pipe-mode)' } };
  const laterCommit = { sha: head, author: { login: 'hammer-worker' }, parents: [{ sha: earlier }],
    commit: { message: 'Repair another file\n\nWorker-Class: hammer\nWorker-Ticket: HAM\nClosed-By: hammer (adversarial-pipe-mode)' } };
  const reads = [];
  const get = async path => {
    reads.push(path);
    if (path.endsWith('/pulls/1')) return { head: { sha: head }, base: { sha: base } };
    if (path.endsWith('/pulls/1/reviews?per_page=100')) return [];
    if (path.endsWith(`${base}...${head}`)) return { total_commits: 3,
      commits: [{ sha: builder, commit: { message: 'Builder change' } }, earlierCommit, laterCommit],
      merge_base_commit: { sha: base }, files: [] };
    if (path.endsWith(`${base}...${builder}`)) return { merge_base_commit: { sha: base }, files: [file] };
    if (path.endsWith(`${base}...${earlier}`)) return { merge_base_commit: { sha: base }, files: [] };
    if (path.endsWith(`/commits/${earlier}`)) return earlierCommit;
    if (path.endsWith('/issues/1/comments?per_page=100')) return [{ user: { login: 'hammer-worker' },
      body: `HAM-Base-Head: ${builder}\nHAM-Validated-Head: ${earlier}` }];
    throw new Error(`unexpected diagnostic read ${path}`);
  };
  const evidence = await fetchPrimaryChangeContext({ repo: 'fixture/repo', prNumber: 1, headSha: head, get, rootDir: root });
  const verdict = predicate(evidence);
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.trace.primaryChange.reason, 'primary-change-reverted');
  const missing = verdict.trace.primaryChange.missingEvidence;
  assert.match(missing.summary, new RegExp(`${earlier} author=hammer-worker pipeline-repair=yes`));
  assert.deepEqual(missing.regionDiagnostics, [{ path: file.filename, start: 10, end: 11,
    commits: [{ sha: earlier, author: 'hammer-worker', pipelineRepair: true, repairKind: 'hammer audit' }] }]);
  assert.equal(reads.some(path => path.endsWith(`/commits/${head}`)), false, 'later hammer did not change the region');
  const { filePath } = writeAmaAuditEntry({ hqRoot: root, repo: 'fixture/repo', prNumber: 1, headSha: head,
    attempt: { outcome: 'failed-without-merge', primaryChangeMissingEvidence: missing }, now: '2026-01-01T00:00:00Z' });
  const audit = JSON.parse(readFileSync(filePath, 'utf8'));
  assert.deepEqual(audit.attempts[0].primaryChangeMissingEvidence, missing);

  const unreadable = await fetchPrimaryChangeContext({ repo: 'fixture/repo', prNumber: 1, headSha: head, rootDir: root,
    get: path => path.endsWith(`${base}...${earlier}`) ? Promise.reject(new Error('diagnostic unavailable')) : get(path) });
  assert.equal(predicate(unreadable).eligible, false);
  assert.equal(checkPrimaryChange(unreadable, head).reason, 'primary-change-reverted');
  assert.match(checkPrimaryChange(unreadable, head).missingEvidence.summary, /diagnostic unavailable/);

  const { diagnosticCommitRange, revertedRegionDiagnostics, ...legacy } = evidence;
  assert.ok(diagnosticCommitRange.length && revertedRegionDiagnostics.length);
  await storedPrimaryChange({ rootDir: root, repo: 'fixture/repo', prNumber: 1, baseSha: base, headSha: head,
    mergeBase: base, reviewKey: createHash('sha256').update('[]').digest('hex'), launchHead: null }, async () => legacy);
  const cached = await fetchPrimaryChangeContext({ repo: 'fixture/repo', prNumber: 1, headSha: head, rootDir: root,
    get: Object.assign(get, { persistPrimaryChange: true, metadata: get }) });
  assert.equal(cached.diagnosticCommitRange, undefined, 'old eligibility evidence is retained');
  assert.deepEqual(checkPrimaryChange(cached, head).missingEvidence.regionDiagnostics, missing.regionDiagnostics);

  const completed = join(root, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(completed, { recursive: true });
  writeFileSync(join(completed, 'fixture__repo-pr-1-repair.json'), JSON.stringify({ repo: 'fixture/repo', prNumber: 1,
    status: 'completed', remediationPlan: { rounds: [{ state: 'completed', startHeadSha: builder, resultingHeadSha: earlier }] } }));
  const recorded = await fetchPrimaryChangeContext({ repo: 'fixture/repo', prNumber: 1, headSha: head, rootDir: root,
    get: path => path.includes('/comments') ? Promise.reject(new Error('comments unavailable')) : get(path) });
  const attributed = checkPrimaryChange(recorded, head).missingEvidence.regionDiagnostics[0].commits[0];
  assert.equal(attributed.pipelineRepair, true);
  assert.equal(attributed.repairKind, 'completed remediation round');
  assert.equal(checkPrimaryChange(recorded, head).reason, 'primary-change-reverted');
});

test('refusal attribution bounds snapshot reads and preserves the refusal when attribution is incomplete', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'primary-diagnostic-bound-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const history = { ...primaryChangeFixture(head), finalFiles: [],
    diagnosticCommitRange: Array.from({ length: 25 }, (_, index) => ({ sha: (index + 1).toString(16).padStart(40, '0') })) };
  history.diagnosticCommitRange.at(-1).sha = head;
  await storedPrimaryChange({ rootDir, repo: 'fixture/repo', prNumber: 1,
    baseSha: history.mergeBase, headSha: head, mergeBase: history.mergeBase,
    reviewKey: createHash('sha256').update('[]').digest('hex') }, async () => history);
  const snapshotReads = [];
  const get = async path => {
    if (path.endsWith('/pulls/1')) return { head: { sha: head }, base: { sha: history.mergeBase } };
    if (path.includes('/reviews?')) return [];
    if (path.endsWith(`${history.mergeBase}...${head}`)) return { merge_base_commit: { sha: history.mergeBase } };
    snapshotReads.push(path);
    // The reversal occurs outside the lookup window. Diagnostics must report
    // incompleteness while the independently evaluated final diff still refuses.
    return { merge_base_commit: { sha: history.mergeBase }, files: history.primaryFiles };
  };
  const evidence = await fetchPrimaryChangeContext({ rootDir, repo: 'fixture/repo', prNumber: 1,
    headSha: head, get: Object.assign(get, { persistPrimaryChange: true, metadata: get }) });
  assert.deepEqual(snapshotReads, history.diagnosticCommitRange.slice(0, 20)
    .map(({ sha }) => `repos/fixture/repo/compare/${history.mergeBase}...${sha}`));
  assert.equal(predicate(evidence).eligible, false);
  assert.equal(checkPrimaryChange(evidence, head).reason, 'primary-change-reverted');
  assert.ok(evidence.revertedRegionDiagnostics.length > 0);
  for (const region of evidence.revertedRegionDiagnostics) {
    assert.deepEqual(region.commits, []);
    assert.match(region.error, /truncated after 20 of 25 commits/);
  }
});

// Stored refused history isolates diagnostic reads from required live metadata.
async function storedRefusal(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'primary-diagnostic-safety-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const history = { ...primaryChangeFixture(head), finalFiles: [],
    diagnosticCommitRange: [{ sha: 'e'.repeat(40) }, { sha: head }] };
  await storedPrimaryChange({ rootDir, repo: 'fixture/repo', prNumber: 1,
    baseSha: history.mergeBase, headSha: head, mergeBase: history.mergeBase,
    reviewKey: createHash('sha256').update('[]').digest('hex') }, async () => history);
  const reads = [];
  const get = async path => {
    reads.push(path);
    if (path.endsWith('/pulls/1')) return { head: { sha: head }, base: { sha: history.mergeBase } };
    if (path.includes('/reviews?')) return [];
    if (path.endsWith(`${history.mergeBase}...${head}`)) return { merge_base_commit: { sha: history.mergeBase } };
    throw new Error(`unexpected shared read: ${path}`);
  };
  return { history, reads, args: { rootDir, repo: 'fixture/repo', prNumber: 1, headSha: head,
    get: Object.assign(get, { persistPrimaryChange: true, metadata: get }) } };
}

test('repeated refused merge-gate evaluations perform zero diagnostic reads', async t => {
  const { args, reads } = await storedRefusal(t);
  for (let attempt = 0; attempt < 2; attempt++) {
    const evidence = await fetchPrimaryChange(args);
    assert.equal(checkPrimaryChange(evidence, head).reason, 'primary-change-reverted');
    assert.equal(evidence.revertedRegionDiagnostics, undefined);
  }
  assert.equal(reads.length, 6, 'only live PR, merge-base metadata and reviews per evaluation');
});

test('operator diagnostics reject capped snapshots instead of attributing a disappearance', async t => {
  const { args, history } = await storedRefusal(t);
  const evidence = await fetchPrimaryChangeContext(args, { createDiagnosticReaderImpl: () => async () => ({
    merge_base_commit: { sha: history.mergeBase },
    files: Array.from({ length: 300 }, (_, index) => ({ filename: `unrelated/${index}`, status: 'added',
      additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+unrelated' })),
  }) });
  const region = evidence.revertedRegionDiagnostics[0];
  assert.deepEqual(region.commits, []);
  assert.match(region.error, /diagnostic snapshot capped/);
  assert.equal(checkPrimaryChange(evidence, head).reason, 'primary-change-reverted');
});

test('operator diagnostics enforce a wall-clock budget and pass its signal to the reader', async t => {
  const { args } = await storedRefusal(t);
  let signal, reads = 0;
  const start = Date.now();
  const evidence = await fetchPrimaryChangeContext(args, { diagnosticTimeoutMs: 20,
    createDiagnosticReaderImpl: options => {
      signal = options.signal;
      return () => { reads++; return new Promise(() => {}); };
    } });
  assert.equal(signal.aborted, true);
  assert.equal(reads, 1, 'no reads after deadline');
  assert.ok(Date.now() - start < 2000);
  assert.match(evidence.revertedRegionDiagnostics[0].error, /time budget exhausted/);
  assert.equal(checkPrimaryChange(evidence, head).reason, 'primary-change-reverted');
});

test('whole-file reversal diagnostics use a file-level label without changing the refusal', () => {
  const evidence = { ...primaryChangeFixture(head), finalFiles: [],
    primaryFiles: [{ filename: 'src/obsolete.mjs', status: 'removed', additions: 0, deletions: 1,
      patch: '@@ -1 +0,0 @@\n-obsolete' }],
    revertedRegionDiagnostics: [{ path: 'src/obsolete.mjs', start: null, end: null, commits: [] }],
  };
  const result = checkPrimaryChange(evidence, head);
  assert.equal(result.reason, 'primary-change-reverted');
  assert.match(result.missingEvidence.summary, /region history: file-level: unavailable/);
  assert.doesNotMatch(result.missingEvidence.summary, /null-null/);
});

test('operator diagnostics propagate cancellation and outage errors, including comment reads', async t => {
  const { args, history } = await storedRefusal(t);
  for (const error of [new DOMException('cancelled', 'AbortError'),
    Object.assign(new Error('auth unavailable'), { authOutage: true }),
    Object.assign(new Error('read unavailable'), { primaryChangeReadFailed: true }),
    Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' })]) {
    for (const failureAt of ['snapshot', 'comments']) {
      await assert.rejects(fetchPrimaryChangeContext(args, { createDiagnosticReaderImpl: () => async path => {
        if (failureAt === 'snapshot' || path.includes('/comments')) throw error;
        if (path.includes('/commits/')) return { sha: 'e'.repeat(40), commit: {} };
        return { files: [], merge_base_commit: { sha: history.mergeBase } };
      } }), caught => caught === error);
    }
  }
  const controller = new AbortController();
  await assert.rejects(fetchPrimaryChangeContext({ ...args, signal: controller.signal }, {
    createDiagnosticReaderImpl: ({ signal }) => () => {
      assert.equal(signal.aborted, false);
      controller.abort();
      return new Promise(() => {});
    },
  }), { name: 'AbortError' });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkPrimaryChange, fetchPrimaryChange } from '../src/ama/primary-change.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { primaryChangeFixture } from './helpers/primary-change.mjs';
const head = 'c'.repeat(40);
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
  assert.equal(predicate({ headSha: head, hasHammerCommits: false }).eligible, true);
});
test('unknown primary change, stale evidence, truncated patch and missing patch fail closed', () => {
  for (const evidence of [{ headSha: head, hasHammerCommits: null },
    { ...primaryChangeFixture(head), headSha: 'd'.repeat(40) },
    { ...primaryChangeFixture(head), primaryFiles: [{ filename: 'binary', additions: 1, deletions: 0 }] },
    { ...primaryChangeFixture(head), finalFiles: [{ ...primaryChangeFixture(head).finalFiles[0], additions: 99 }] }]) {
    assert.ok(predicate(evidence).reasons.includes('primary-change-unknown'));
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
    if (calls.length === 2) return { total_commits: 3, commits: [
      { sha: author, commit: { message: 'worker' } },
      { sha: 'e'.repeat(40), parents: [{ sha: author }], commit: { message: 'Worker-Class: hammer' } },
      { sha: head, parents: [{ sha: 'e'.repeat(40) }], commit: { message: 'Worker-Class: hammer' } }] };
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
    assert.equal(checkPrimaryChange(result, head).reason, result.readFailed ? 'primary-change-read-failed' : 'primary-change-unknown');
  }
});
test('hammer prompt preserves intent and resolves conflicting non-blocking findings by rationale', () => {
  const prompt = readFileSync(new URL('../templates/hammer-prompt.md', import.meta.url), 'utf8');
  assert.match(prompt, /may not revert, neutralize or invert any hunk/);
  assert.match(prompt, /conflicting non-blocking finding, post a rationale comment/);
  assert.match(prompt, /author-controlled intent context and cannot establish an operator decision/);
  assert.match(prompt, /HAM_PRIMARY_CHANGE_FILE=\$\(mktemp/);
  assert.match(prompt, /conflicting blocking finding, use the existing escalation path/);
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
        commit: { message: `Worker-Class: hammer\nReviewed-Head: ${original}` } }],
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

test('closer dispatch defers failed reads and reserves operator escalation for unsupported evidence', async () => {
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
    assert.equal(result.reason, readFailed ? 'gate-read-failed' : 'primary-change-needs-operator');
    assert.equal(result.needsOperator === true, !readFailed);
  }
});

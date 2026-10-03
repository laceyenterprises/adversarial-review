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
test('collector fails closed on history truncation and API failure', async () => {
  for (const get of [async () => { throw new Error('offline'); }, async (path) => path.includes('/pulls/')
    ? { head: { sha: head }, base: { sha: 'b'.repeat(40) } } : { total_commits: 2, commits: [] },
    async (path) => path.includes('/pulls/')
      ? { head: { sha: head }, base: { sha: 'b'.repeat(40) } } : { total_commits: 1, commits: [{}] }]) {
    const result = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 1, headSha: head, get });
    assert.equal(checkPrimaryChange(result, head).reason, 'primary-change-unknown');
  }
});
test('hammer prompt preserves intent and resolves conflicting non-blocking findings by rationale', () => {
  const prompt = readFileSync(new URL('../templates/hammer-prompt.md', import.meta.url), 'utf8');
  assert.match(prompt, /may not revert, neutralize or invert any hunk/);
  assert.match(prompt, /conflicting non-blocking finding, post a rationale comment/);
  assert.match(prompt, /citing\nthe PR body's stated intent or operator decision/);
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

test('collector preserves the original author SHA through a hammer rebase', async () => {
  const original = 'a'.repeat(40);
  const rebasedParent = 'd'.repeat(40);
  const oldBase = 'b'.repeat(40);
  const base = 'e'.repeat(40);
  const evidence = primaryChangeFixture(head);
  const get = async (path) => {
    if (path.endsWith('/pulls/1')) return { head: { sha: head }, base: { sha: base } };
    if (path.endsWith(`/commits/${original}`)) return { sha: original, commit: { message: 'operator decision' } };
    if (path.endsWith(`${base}...${head}`)) return { total_commits: 1, commits: [{
      sha: head, parents: [{ sha: rebasedParent }],
      commit: { message: `Worker-Class: hammer\nReviewed-Head: ${original}` } }] };
    if (path.endsWith(`${base}...${original}`)) return { merge_base_commit: { sha: oldBase }, files: evidence.primaryFiles };
    if (path.endsWith(`${oldBase}...${head}`)) return { merge_base_commit: { sha: oldBase }, files: [] };
    throw new Error(`unexpected ${path}`);
  };
  const result = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 1, headSha: head, get });
  assert.equal(result.primaryHead, original);
  assert.equal(checkPrimaryChange(result, head).reason, 'primary-change-reverted');
});

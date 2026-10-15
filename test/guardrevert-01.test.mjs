import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPrimaryChange, checkPrimaryChange } from '../src/ama/primary-change.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { amaAllAuthoritativeReviewerLogins } from '../src/ama/reviewer-authority.mjs';
import { attemptDaemonCleanMerge } from '../src/ama/daemon-merge.mjs';

const base = 'a'.repeat(40), approved = 'b'.repeat(40), head = 'c'.repeat(40);
const guard = 'Reject generated catalog edits in PRs';
const path = 'docs/CATALOG.md';
const index = { filename: path, status: 'modified', additions: 1, deletions: 1,
  patch: '@@ -1 +1 @@\n-Base catalog\n+Regenerated catalog' };
const report = { filename: 'docs/report.md', status: 'added', additions: 1, deletions: 0,
  patch: '@@ -0,0 +1 @@\n+Synthetic incident report' };

function fixture(options = {}) {
  const hammer = { sha: head, parents: [{ sha: approved }],
    author: { login: 'hammer-worker' }, committer: { login: 'hammer-worker' },
    commit: { message: 'Repair generated catalog\n\nWorker-Class: hammer\nWorker-Ticket: HAM\nClosed-By: hammer (adversarial-pipe-mode)' } };
  const failed = { id: 11, name: guard, head_sha: approved, app: { id: 7 },
    status: 'completed', conclusion: 'failure', output: {} };
  const passing = { ...failed, id: 12, head_sha: head, conclusion: 'success' };
  const responses = {
    'pulls/1': { head: { sha: head }, base: { sha: base, ref: 'main' } },
    [`compare/${base}...${head}`]: { total_commits: 2, commits: [
      { sha: approved, commit: { message: 'Add reports' } }, hammer],
    merge_base_commit: { sha: base }, files: [report], filesComplete: true },
    [`compare/${base}...${approved}`]: { merge_base_commit: { sha: base }, files: [report, index], filesComplete: true },
    'branches/main/protection/required_status_checks': { checks: [{ context: guard, app_id: 7 }] },
    [`commits/${approved}/check-runs?per_page=100&page=1`]: { check_runs: [failed] },
    [`commits/${head}/check-runs?per_page=100&page=1`]: { check_runs: [passing] },
    'check-runs/11/annotations?per_page=100&page=1': [{ path, message: 'This file is forbidden in pull requests.' }],
    'pulls/1/reviews?per_page=100': [],
    ...options.responses,
  };
  const calls = [];
  const args = { repo: 'fixture/repository', prNumber: 1, headSha: head,
    get: async endpoint => {
      const key = endpoint.replace('repos/fixture/repository/', ''); calls.push(key);
      if (!(key in responses)) throw new Error(`Unexpected fixture endpoint: ${key}`);
      return structuredClone(responses[key]);
    } };
  return { args, responses, calls, failed, passing };
}

async function evidenceFor(f) {
  return fetchPrimaryChange(f.args, { fetchCiCostImpl: async () => ({ headSha: head, ok: true }) });
}

test('GUARDREVERT-01: required guard authorizes only its named path restored to base', async () => {
  const f = fixture();
  const evidence = await evidenceFor(f);
  const result = checkPrimaryChange(evidence, head);
  assert.equal(result.ok, true);
  assert.deepEqual(result.guardReversals, [{ authorization: `Reversal-Authorized-By: guard:${guard}`,
    paths: [path], failedCheckRun: 11, passingCheckRun: 12, failedHead: approved, passingHead: head }]);
  // Removing another author change remains a refusal, even with valid guard authority.
  evidence.finalFiles = [];
  const unrelated = checkPrimaryChange(evidence, head);
  assert.equal(unrelated.reason, 'primary-change-reverted');
  assert.equal(unrelated.path, 'docs/report.md');
});

const cleanReview = { headSha: approved, verdict: 'approved', riskClass: 'low', remediationPending: false,
  blockingFindingState: 'known', blockingFindingCount: 0, nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 };
const greenPr = { prNumber: 1, headSha: head, isOpen: true, isDraft: false, labels: [],
  mergeableState: 'MERGEABLE', statusCheckRollup: [{ name: guard, status: 'COMPLETED', conclusion: 'SUCCESS' }] };
const cfg = { enabled: true, eligibility: { riskClasses: ['low'] }, branchProtection: { required: false } };

test('GUARDREVERT-01: approved generated-file edit, guard repair and green CI pass terminal validation and merge', async () => {
  const primaryChange = await evidenceFor(fixture());
  // A clean approval itself covers only this proven pure CI repair.
  const approvedRepair = isEligibleForAmaClosure(cleanReview, greenPr, cfg, { primaryChange });
  assert.equal(approvedRepair.eligible, true, JSON.stringify(approvedRepair.reasons));
  assert.equal(approvedRepair.trace.headMatch.guardRepairCoverage, true);
  // Exercise the existing terminal HAM safety core as well as the approval.
  const auditComment = { author: 'hammer-worker', body: `HAM-Validated-Head: ${head}` };
  const terminal = isEligibleForAmaClosure(cleanReview, greenPr, cfg, {
    primaryChange, hamTerminalRemediation: { active: true, commit: { sha: head } },
    hamTerminalRemediationGroundTruth: { commit: { sha: head, primaryChange }, auditComment,
      range: { verified: true, reviewedHead: approved, currentHead: head, baseSha: approved, commits: [head] } },
  });
  assert.equal(terminal.eligible, true, JSON.stringify(terminal.reasons));
  assert.equal(terminal.trace.hamTerminalRemediation.ok, true);
  const live = { candidateHead: head, primaryChange, requirePrimaryChange: true,
    requiredChecks: greenPr.statusCheckRollup, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', prState: 'OPEN', labels: [] };
  let merges = 0;
  const audits = [];
  const result = await attemptDaemonCleanMerge({ repo: 'fixture/repository', prNumber: 1, base: 'main', prTitle: 'Synthetic report repair',
    validatedHead: head, verdict: terminal.trace.hamTerminalRemediation.marker, allowHamTerminalRemediation: true,
    reviewState: cleanReview, liveGate: live, branchProtectionRequired: false,
    fetchLiveGateImpl: async () => live,
    acquireLeaseImpl: async () => ({ acquired: true, lease: { leaseId: 'fixture-lease' } }),
    releaseLeaseImpl: () => {}, runMergeImpl: async target => {
      assert.equal(target.head, head); merges++; return { exitCode: 0 };
    },
    writeAuditImpl: value => { audits.push(value); return { doc: { attempts: [] } }; },
    appendAuditImpl: value => { audits.push(value); return { doc: { attempts: [] } }; },
    readAuditImpl: () => null, writeMergeActionImpl: () => {}, logger: { log() {}, warn() {} },
  });
  assert.equal(result.merged, true, JSON.stringify(result));
  assert.equal(merges, 1);
  assert.ok(audits.length > 0);
});

test('GUARDREVERT-01: guard-only approval coverage survives a rebase; other edits require exact-head review', async () => {
  const original = 'd'.repeat(40);
  const f = fixture();
  f.responses['pulls/1/reviews?per_page=100'] = [{ commit_id: original,
    user: { login: amaAllAuthoritativeReviewerLogins()[0] } }];
  f.responses[`compare/${base}...${original}`] = { files: [report, index],
    merge_base_commit: { sha: 'e'.repeat(40) }, filesComplete: true };
  f.responses[`compare/${original}...${approved}`] = { status: 'diverged' };
  f.responses[`compare/${'e'.repeat(40)}...${base}`] = { status: 'ahead' };
  const primaryChange = await evidenceFor(f);
  const review = { ...cleanReview, headSha: original };
  const result = isEligibleForAmaClosure(review, greenPr, cfg, { primaryChange });
  assert.equal(result.eligible, true, JSON.stringify(result.reasons));
  for (const file of [{ ...report, patch: '@@ -0,0 +1 @@\n+Changed incident conclusions' },
    { filename: 'docs/extra.md', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+Extra' }]) {
    const changed = structuredClone(primaryChange);
    changed.finalFiles = file.filename === report.filename ? [file] : [report, file];
    const refused = isEligibleForAmaClosure(review, greenPr, cfg, { primaryChange: changed });
    assert.ok(refused.reasons.includes('stale-review-head'));
  }
});

test('GUARDREVERT-01: failed, optional, stale, unnamed and partial restorations never gain guard authority', async () => {
  for (const mutate of [
    f => { f.responses['branches/main/protection/required_status_checks'] = { contexts: [] }; },
    f => { f.responses[`commits/${head}/check-runs?per_page=100&page=1`].check_runs[0].conclusion = 'failure'; },
    f => { f.responses[`commits/${head}/check-runs?per_page=100&page=1`].check_runs[0].head_sha = approved; },
    f => { f.responses[`commits/${head}/check-runs?per_page=100&page=1`].check_runs[0].app.id = 8; },
    f => { f.responses['check-runs/11/annotations?per_page=100&page=1'][0].path = 'docs/unrelated.md'; },
    f => { f.responses['check-runs/11/annotations?per_page=100&page=1'][0].message = 'Lint error.'; },
    f => { f.responses[`compare/${base}...${head}`].files.push({ ...index,
      patch: '@@ -1 +1 @@\n-Base catalog\n+Partially reverted catalog' }); },
  ]) {
    const control = await evidenceFor(fixture());
    assert.equal(checkPrimaryChange(control, head).ok, true);
    const f = fixture(); mutate(f);
    const result = checkPrimaryChange(await evidenceFor(f), head);
    assert.equal(result.ok && result.guardReversals?.length > 0, false);
  }
});

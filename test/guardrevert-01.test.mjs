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
  assert.deepEqual(audits.find(record => record.attempt.outcome === 'succeeded').attempt.guardReversals,
    terminal.trace.primaryChange.guardReversals);
});

for (const check of [
  { name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' },
  { name: 'unit', status: 'IN_PROGRESS', conclusion: null },
]) {
  test(`GUARDREVERT-01: daemon failure retains verified guard authority when CI is ${check.status}/${check.conclusion}`, async () => {
    const primaryChange = await evidenceFor(fixture());
    const guardReversals = checkPrimaryChange(primaryChange, head).guardReversals;
    assert.equal(guardReversals.length, 1, 'the offline guard proof must be verified');
    const live = { candidateHead: head, primaryChange, requirePrimaryChange: true,
      requiredChecks: greenPr.statusCheckRollup, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', prState: 'OPEN', labels: [] };
    const audits = [];
    let released = 0;
    const result = await attemptDaemonCleanMerge({ repo: 'fixture/repository', prNumber: 1, base: 'main', prTitle: 'Synthetic report repair',
      validatedHead: head, verdict: 'ham_terminal_remediation_validated', allowHamTerminalRemediation: true,
      reviewState: cleanReview, liveGate: live, branchProtectionRequired: false,
      fetchLiveGateImpl: async () => ({ ...live, requiredChecks: [...live.requiredChecks, check] }),
      acquireLeaseImpl: async () => ({ acquired: true, lease: { leaseId: 'fixture-lease' } }),
      releaseLeaseImpl: () => { released++; },
      runMergeImpl: async () => assert.fail('red or pending CI must prevent merge'),
      writeAuditImpl: value => { audits.push(value); return { doc: { attempts: [] } }; },
      appendAuditImpl: value => { audits.push(value); return { doc: { attempts: [] } }; },
      readAuditImpl: () => null, writeMergeActionImpl: () => {}, logger: { log() {}, warn() {} },
    });
    assert.equal(result.merged, false);
    assert.equal(result.reason, 'gate-not-eligible');
    assert.deepEqual(result.reasons, ['ci-not-green']);
    assert.equal(released, 1);
    const terminal = audits.find(record => record.attempt.attemptPhase === 'daemon-failed');
    assert.equal(terminal.attempt.outcome, 'failed-without-merge');
    assert.deepEqual(terminal.attempt.guardReversals, guardReversals);
  });
}

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

test('GUARDREVERT-01: later family comments retain every distinct authoritative approval head', async () => {
  const original = 'd'.repeat(40), later = 'f'.repeat(40), originalBase = 'e'.repeat(40);
  const user = { login: amaAllAuthoritativeReviewerLogins()[0] };
  const f = fixture();
  f.responses['pulls/1/reviews?per_page=100'] = [
    { commit_id: original, user, state: 'APPROVED' },
    { commit_id: original, user, state: 'COMMENTED' },
    { commit_id: later, user, state: 'COMMENTED' },
    { commit_id: approved, user, state: 'COMMENTED' },
    { commit_id: '9'.repeat(40), user: { login: 'untrusted-reviewer' } },
    { commit_id: 'invalid', user },
  ];
  for (const reviewed of [original, later]) {
    f.responses[`compare/${base}...${reviewed}`] = { files: [report, index],
      merge_base_commit: { sha: originalBase }, filesComplete: true };
    f.responses[`compare/${reviewed}...${approved}`] = { status: 'diverged' };
  }
  f.responses[`compare/${originalBase}...${base}`] = { status: 'ahead' };
  const primaryChange = await evidenceFor(f);
  assert.deepEqual(primaryChange.guardReviewSnapshots.map(snapshot => snapshot.headSha), [original, later]);
  for (const reviewed of [original, later]) {
    assert.equal(f.calls.filter(call => call === `compare/${base}...${reviewed}`).length, 1);
    const result = isEligibleForAmaClosure({ ...cleanReview, headSha: reviewed }, greenPr, cfg, { primaryChange });
    assert.equal(result.eligible, true, JSON.stringify(result.reasons));
  }
});

test('GUARDREVERT-01: failed, optional, stale, unnamed and partial restorations never gain guard authority', async () => {
  for (const mutate of [
    f => { f.responses['branches/main/protection/required_status_checks'] = { contexts: [] }; },
    f => {
      const get = f.args.get; let reads = 0;
      f.args.get = async endpoint => {
        const response = await get(endpoint);
        if (endpoint.endsWith('/pulls/1') && ++reads > 1) response.base.sha = 'e'.repeat(40);
        return response;
      };
    },
    f => { f.responses[`commits/${head}/check-runs?per_page=100&page=1`].check_runs[0].conclusion = 'failure'; },
    f => { f.responses[`commits/${head}/check-runs?per_page=100&page=1`].check_runs[0].head_sha = approved; },
    f => { f.responses[`commits/${head}/check-runs?per_page=100&page=1`].check_runs[0].app.id = 8; },
    f => { f.responses['branches/main/protection/required_status_checks'].checks[0].app_id = 8; },
    f => { f.responses[`commits/${approved}/check-runs?per_page=100&page=1`].check_runs[0].head_sha = head; },
    f => { f.responses[`commits/${head}/check-runs?per_page=100&page=1`].check_runs.push({ ...f.passing, id: 13, status: 'in_progress', conclusion: null }); },
    f => { f.responses['check-runs/11/annotations?per_page=100&page=1'][0].path = 'docs/unrelated.md'; },
    f => { f.responses['check-runs/11/annotations?per_page=100&page=1'][0].message = 'Lint error.'; },
    f => { f.responses['check-runs/11/annotations?per_page=100&page=1'] = [{ path: '.github/workflows/guard.yml',
      message: `${path} is allowed in PRs, but docs/unrelated.md is forbidden in PRs.` }]; },
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

test('GUARDREVERT-01: explicit path prohibitions in summaries and generic error annotations qualify', async () => {
  for (const source of ['summary', 'annotation']) {
    const f = fixture();
    if (source === 'summary') {
      f.responses['check-runs/11/annotations?per_page=100&page=1'] = [];
      f.responses[`commits/${approved}/check-runs?per_page=100&page=1`].check_runs[0].output = {
        summary: `The file \`${path}\` is forbidden in pull requests.` };
    } else {
      f.responses['check-runs/11/annotations?per_page=100&page=1'] = [{ path: '.github/workflows/guard.yml',
        message: `The file \`${path}\` is forbidden in pull requests.` }];
    }
    assert.equal(checkPrimaryChange(await evidenceFor(f), head).ok, true, source);
  }
});

test('GUARDREVERT-01: annotation paths bind punctuated titles and later diagnostic sentences', async () => {
  for (const annotation of [
    { title: 'Guard check.', message: 'This file is forbidden in pull requests.' },
    { title: 'Guard check.', message: 'Generated catalog detected. This file is forbidden in PRs. Restore the base.' },
    { title: 'Guard check!', message: 'Generated catalog detected.\nThis file is forbidden in PRs.' },
    { title: 'This file is forbidden in PRs.', message: 'Restore the generated catalog.' },
  ]) {
    const f = fixture();
    f.responses['check-runs/11/annotations?per_page=100&page=1'] = [{ path, ...annotation }];
    const result = checkPrimaryChange(await evidenceFor(f), head);
    assert.equal(result.ok, true, JSON.stringify(annotation));
    assert.equal(result.guardReversals.length, 1);
  }
});

test('GUARDREVERT-01: punctuation never grants an unrelated path or combines separate assertions', async () => {
  for (const annotation of [
    { path: 'docs/unrelated.md', title: 'Guard check.', message: 'This file is forbidden in PRs.' },
    { path: 'docs/unrelated.md', message: `${path} is allowed in PRs. docs/unrelated.md is forbidden in PRs.` },
    { path, title: 'Pull request checks.', message: 'This file is forbidden.' },
  ]) {
    const f = fixture();
    f.responses['check-runs/11/annotations?per_page=100&page=1'] = [annotation];
    const result = checkPrimaryChange(await evidenceFor(f), head);
    assert.equal(result.reason, 'primary-change-reverted', JSON.stringify(annotation));
  }
});

test('GUARDREVERT-01: rejection recognizes PR context on either side of the named path', async () => {
  for (const message of [`${path} is rejected in pull requests.`, `In pull requests, ${path} is rejected.`]) {
    for (const source of ['summary', 'annotation', 'unrelated-annotation']) {
      const f = fixture();
      f.responses['check-runs/11/annotations?per_page=100&page=1'] = source === 'summary' ? []
        : [{ path: source === 'annotation' ? path : '.github/workflows/guard.yml', message }];
      if (source === 'summary') {
        f.responses[`commits/${approved}/check-runs?per_page=100&page=1`].check_runs[0].output = { summary: message };
      }
      const result = checkPrimaryChange(await evidenceFor(f), head);
      assert.equal(result.ok, true, `${source}: ${message}`);
      assert.equal(result.guardReversals.length, 1);
    }
  }
});

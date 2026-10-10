import { primaryChangeFixture } from './helpers/primary-change.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disputeFinding } from '../src/ama/finding-dispute.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';
import { pickAdversarialGateStatus } from '../src/adversarial-gate-status.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { buildHamTerminalRemediationEvidenceFromGroundTruth } from '../src/ama/dispatch-closer.mjs';
import { normalizeVerifiedCloserCommit } from '../src/head-closer-commit-suppression.mjs';
import {
  blockingFindingIdentitiesFromBody,
  buildWithdrawalComment,
  hammerWithdrawalsFromComments,
  readHammerWithdrawals,
  resolveHammerAdjudication,
} from '../src/ama/hammer-adjudication.mjs';

// HAMFINAL-01 — replay of agent-os PR 7987. Operator decision, 2026-10-10:
//   "Hammers judgement is final"
// Head dff2cad648 drew a 6-chunk oversized Gemini re-review with 3 blocking
// findings: one real pager-ordering defect in ci_bill_alarm.py and two false
// "Malformed JSON" chunk artifacts. The hammer disputed the two artifacts, the
// same-head re-review was dropped by the watcher duplicate guard, the gate sat
// on "remediation-stopped — operator decision required", finding 1 was never
// remediated and the operator hand-merged over CHANGES_REQUESTED.
const REPO = 'laceyenterprises/agent-os';
const PR = 7987;
const REVIEWED_HEAD = `dff2cad648${'0'.repeat(30)}`;
const HAM_HEAD = `e7a1b2c3d4${'1'.repeat(30)}`;
const OTHER_HEAD = 'f'.repeat(40);
const ALARM = 'tools/ci-bill/ci_bill_alarm.py';
const ALARM_TEST = 'tools/ci-bill/test_ci_bill_alarm.py';
const BASELINE = 'tools/docs-inventory/linkcheck-all-baseline.json';
const REAL_TITLE = 'Pager fires before the bill alarm is persisted';
const FALSE_TITLES = ['Linkcheck baseline is malformed JSON', 'Chunk five reports malformed baseline JSON'];

const finding = (title, file, lines, problem) => [
  `- **${title}**`,
  `  - **File:** \`${file}\``,
  `  - **Lines:** \`${lines}\``,
  `  - **Problem:** ${problem}`,
  '  - **Recommended fix:** Fix it.',
].join('\n');
const REVIEW_BODY = [
  '## Summary',
  'Oversized re-review (6 chunks).',
  '',
  '## Blocking issues',
  finding(REAL_TITLE, ALARM, '88-104', 'The page is sent before the alarm row commits.'),
  finding(FALSE_TITLES[0], BASELINE, '1', 'Chunk 4 reports the baseline does not parse.'),
  finding(FALSE_TITLES[1], BASELINE, '1', 'Chunk 5 reports the baseline does not parse.'),
  '',
  '## Non-blocking issues',
  '- None.',
  '',
  '## Verdict',
  'Request changes',
].join('\n');
const IDENTITIES = blockingFindingIdentitiesFromBody(REVIEW_BODY);
const REVIEW = {
  node_id: 'PRR_7987', html_url: `https://github.com/${REPO}/pull/${PR}#pullrequestreview-5478831586`,
  commit_id: REVIEWED_HEAD, state: 'CHANGES_REQUESTED', user: { login: 'lacey-gemini-reviewer[bot]' }, body: REVIEW_BODY,
};
// Concrete exact-head evidence: the repro command and its output.
const BASELINE_EVIDENCE = [
  '```',
  `$ git show ${REVIEWED_HEAD}:${BASELINE} | python3 -m json.tool > /dev/null && echo parses`,
  'parses',
  '```',
  'The baseline parses on the reviewed head; the finding is a chunking artifact.',
].join('\n');

function reviewState(overrides = {}) {
  return {
    headSha: REVIEWED_HEAD,
    verdict: 'request-changes',
    remediationPending: false,
    blockingFindingState: 'known',
    blockingFindingCount: 3,
    blockingFindingIdentities: IDENTITIES,
    nonBlockingFindingState: 'known',
    nonBlockingFindingCount: 0,
    nonBlockingFindingIdentities: [],
    ...overrides,
  };
}

function withdrawal(index, head = REVIEWED_HEAD) {
  return { identity: IDENTITIES[index], headSha: head, findingReviewedHead: head,
    evidenceSha256: 'e'.repeat(64), resolution: 'withdrawn-by-hammer' };
}

function disputeRig(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'hamfinal-01-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const db = openReviewStateDb(rootDir); ensureReviewStateSchema(db); t.after(() => db.close());
  db.prepare(`INSERT INTO reviewed_prs(repo, pr_number, reviewer, review_status, pr_state, reviewed_at, revision_ref)
    VALUES (?, ?, 'gemini', 'posted', 'open', '2026-10-10T11:48:00Z', ?)`).run(REPO, PR, REVIEWED_HEAD);
  const calls = [];
  const deps = {
    db,
    get: async (url) => url.includes('/reviews?') ? [REVIEW] : { state: 'open', head: { sha: REVIEWED_HEAD } },
    postComment: async (body) => {
      calls.push(['comment', body]);
      return { node_id: `IC_${calls.length}`, user: { login: 'the-hammer-lacey[bot]' }, body };
    },
    wake: async (input) => calls.push(['wake', input]),
    logger: { info() {}, warn() {}, error: (text) => calls.push(['event', text]) },
  };
  const args = (findingNumber) => ({ rootDir, repo: REPO, prNumber: PR, headSha: REVIEWED_HEAD,
    reviewRef: REVIEW.node_id, findingNumber, evidence: BASELINE_EVIDENCE });
  return { rootDir, db, calls, deps, args };
}

const stoppedJob = () => ({ jobId: 'job-7987', repo: REPO, prNumber: PR, status: 'stopped', reviewBody: REVIEW_BODY,
  remediationPlan: { currentRound: 2, maxRounds: 2, stop: { code: 'max-rounds-reached' } }, reReview: { requested: false } });
const reviewRow = () => ({ repo: REPO, pr_number: PR, pr_state: 'open', review_status: 'posted',
  reviewer_head_sha: REVIEWED_HEAD, review_body: REVIEW_BODY });

test('7987 replay: the two false findings are withdrawn-by-hammer with no re-review and the review row stays posted', async (t) => {
  const rig = disputeRig(t);
  const results = [];
  for (const findingNumber of [2, 3]) results.push(await disputeFinding(rig.args(findingNumber), rig.deps));
  assert.deepEqual(results.map((r) => [r.withdrawn, r.resolution, r.identity]),
    [[true, 'withdrawn-by-hammer', IDENTITIES[1]], [true, 'withdrawn-by-hammer', IDENTITIES[2]]]);
  // No re-review request means nothing for the same-head duplicate guard to
  // swallow ("reviewer dispatch SKIPPED as duplicate … commit_id match").
  assert.deepEqual(rig.calls.map(([kind]) => kind), ['comment', 'wake', 'comment', 'wake']);
  assert.equal(rig.db.prepare('SELECT review_status FROM reviewed_prs').get().review_status, 'posted');
  for (const [index, [, body]] of rig.calls.filter(([kind]) => kind === 'comment').entries()) {
    assert.match(body, /^Resolution: withdrawn-by-hammer$/m);
    assert.match(body, new RegExp(`^Evidence-SHA256: ${results[index].evidenceSha256}$`, 'm'));
    assert.match(body, new RegExp(`^Reviewed-Head: ${REVIEWED_HEAD}$`, 'm'));
    assert.match(body, /Hammers judgement is final/);
  }
  // Re-running the hammer pass (7987 disputed at 11:55Z and again at 13:08Z)
  // reuses the recorded adjudication instead of spending another request.
  assert.equal((await disputeFinding(rig.args(2), rig.deps)).alreadyRecorded, true);
  assert.equal(rig.calls.filter(([kind]) => kind === 'comment').length, 2);
  const stored = readHammerWithdrawals({ rootDir: rig.rootDir, repo: REPO, prNumber: PR });
  assert.deepEqual(stored.map((row) => row.identity).sort(), [IDENTITIES[1], IDENTITIES[2]].sort());
  assert.ok(stored.every((row) => row.findingReviewedHead === REVIEWED_HEAD && row.headSha === REVIEWED_HEAD));
  // Finding 1 still stands, so the gate still routes it to remediation.
  const adjudication = resolveHammerAdjudication({ ...reviewState(), reviewedHead: REVIEWED_HEAD }, stored);
  assert.equal(adjudication.withdrawnCount, 2);
  assert.equal(adjudication.allBlockingWithdrawn, false);
  const gate = pickAdversarialGateStatus({ reviewRow: reviewRow(), latestJob: stoppedJob(),
    headSha: REVIEWED_HEAD, hammerWithdrawals: stored });
  assert.equal(gate.reason, 'remediation-stopped');
});

test('7987 replay: the hammer remediates finding 1 and its self-cert accepts the two withdrawals', () => {
  const [realDigest, falseDigest] = ['a'.repeat(64), 'b'.repeat(64)];
  const changedFiles = [ALARM, ALARM_TEST];
  const commit = { ...normalizeVerifiedCloserCommit({
    sha: HAM_HEAD,
    parents: [{ sha: REVIEWED_HEAD }],
    commit: { message: ['HAM remediate final adversarial findings', '', 'Worker-Class: hammer', '', 'Worker-Ticket: HAM', '',
      `Reviewed-Head: ${REVIEWED_HEAD}`, '', 'Closed-By: hammer (adversarial-pipe-mode)', '',
      'Remediated-Findings: 3 addressed (3 blocking, 0 non-blocking)', ''].join('\n') },
    committer: { login: 'the-hammer-lacey[bot]' },
    author: { login: null },
    files: changedFiles.map((filename) => ({ filename })),
  }), primaryChange: primaryChangeFixture(HAM_HEAD) };
  const audit = {
    author: 'the-hammer-lacey', createdAt: '2026-10-10T13:20:00Z', id: '3400000000',
    body: [
      '<!-- hq:ham-terminal-remediation:audit -->',
      '',
      '## Hammer remediation audit',
      '',
      'Findings addressed:',
      `- **${REAL_TITLE}** (blocking) — ${ALARM} persists the alarm row before paging; ${ALARM_TEST} covers the crash window.`,
      `- **${FALSE_TITLES[0]}** (blocking) — withdrawn-by-hammer: Evidence-SHA256 ${realDigest} on head ${REVIEWED_HEAD}`,
      `- **${FALSE_TITLES[1]}** (blocking) — withdrawn-by-hammer: Evidence-SHA256 ${falseDigest} on head ${REVIEWED_HEAD}`,
      '',
      'Validation:',
      `- Doc-currency: not applicable; changed files covered: ${changedFiles.join(', ')}; data-model docs not applicable.`,
      '',
      '<sub>',
      `HAM-Terminal-Remediation-Head: ${HAM_HEAD}`,
      'Remediated-Findings: 3 addressed (3 blocking, 0 non-blocking)',
      'Closed-By: hammer (adversarial-pipe-mode)',
      '</sub>',
    ].join('\n'),
  };
  const evidence = buildHamTerminalRemediationEvidenceFromGroundTruth({
    reviewedHead: REVIEWED_HEAD, verifiedCommit: commit, verifiedAuditComment: audit,
  });
  const verdict = isEligibleForAmaClosure(
    reviewState(),
    { prNumber: PR, headSha: HAM_HEAD, isOpen: true, isDraft: false, mergeableState: 'MERGEABLE', labels: [] },
    { enabled: true, workerClass: 'hammer' },
    { env: {}, hamTerminalRemediation: evidence,
      hamTerminalRemediationGroundTruth: { commit, auditComment: audit },
      hammerWithdrawnFindings: [withdrawal(1), withdrawal(2)] },
  );
  const ham = verdict.trace.hamTerminalRemediation;
  assert.equal(ham.ok, true, `expected self-certification; checks=${JSON.stringify(ham.checks)}`);
  assert.ok(ham.waived.includes('blocking-findings-present'));
  for (const reason of ['blocking-findings-present', 'stale-review-head', 'verdict-not-settled-success']) {
    assert.ok(!verdict.reasons.includes(reason), `${reason} must not stand; reasons=${JSON.stringify(verdict.reasons)}`);
  }
  // The old-head withdrawals do not carry forward. The independently checked
  // terminal remediation audit covers all three findings on HAM_HEAD instead.
  assert.equal(verdict.trace.verdict.hammerAdjudication.withdrawnCount, 0);
  assert.equal(verdict.trace.verdict.hammerAdjudication.settled, false);
});

test('regression: a dispute-only PR settles the gate without an operator decision', () => {
  const all = [withdrawal(0), withdrawal(1), withdrawal(2)];
  const stopped = pickAdversarialGateStatus({ reviewRow: reviewRow(), latestJob: stoppedJob(),
    headSha: REVIEWED_HEAD, hammerWithdrawals: all });
  assert.equal(stopped.state, 'success');
  assert.equal(stopped.reason, 'hammer-adjudicated');
  assert.ok(!stopped.operatorDecisionRequired);
  assert.doesNotMatch(stopped.description, /operator decision/i);
  const noJob = pickAdversarialGateStatus({ reviewRow: reviewRow(), latestJob: null,
    headSha: REVIEWED_HEAD, hammerWithdrawals: all });
  assert.equal(noJob.reason, 'hammer-adjudicated');
  // Without the withdrawals the same state keeps its pre-HAMFINAL outcome.
  assert.equal(pickAdversarialGateStatus({ reviewRow: reviewRow(), latestJob: null, headSha: REVIEWED_HEAD }).reason,
    'blocking-review');
  const before = pickAdversarialGateStatus({ reviewRow: reviewRow(), latestJob: stoppedJob(), headSha: REVIEWED_HEAD });
  assert.equal(before.reason, 'remediation-stopped');
  assert.equal(before.operatorDecisionRequired, true);
});

test('regression: dispute-only eligibility matches a clean review', () => {
  const pr = { prNumber: PR, headSha: REVIEWED_HEAD, isOpen: true, isDraft: false, mergeableState: 'MERGEABLE', labels: [] };
  const cfg = { enabled: true, workerClass: 'hammer' };
  const clean = isEligibleForAmaClosure(reviewState({ verdict: 'comment-only', blockingFindingCount: 0,
    blockingFindingIdentities: [] }), pr, cfg, { env: {} });
  const adjudicated = isEligibleForAmaClosure(reviewState(), pr, cfg,
    { env: {}, hammerWithdrawnFindings: [withdrawal(0), withdrawal(1), withdrawal(2)] });
  assert.deepEqual(adjudicated.reasons, clean.reasons);
  assert.equal(adjudicated.eligible, clean.eligible);
  assert.equal(adjudicated.trace.verdict.hammerAdjudication.settled, true);
  const partial = isEligibleForAmaClosure(reviewState(), pr, cfg,
    { env: {}, hammerWithdrawnFindings: [withdrawal(1), withdrawal(2)] });
  assert.ok(partial.reasons.includes('blocking-findings-present'));
  assert.equal(partial.eligible, false);
});

test('regression: ama-check requires durable admission after a withdrawal post', async (t) => {
  const rig = disputeRig(t);
  const tmp = rig.rootDir;
  const write = (name, value) => {
    const path = join(tmp, name);
    writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
    return path;
  };
  const comments = [];
  const postComment = async (body) => {
    const comment = { event: 'commented', node_id: `IC_${comments.length}`, user: { login: 'the-hammer-lacey[bot]' },
      created_at: '2026-10-10T11:55:00Z', body };
    comments.push(comment);
    return comment;
  };
  const run = (timeline, reviewStatus = 'CHANGES_REQUESTED') => {
    const result = spawnSync(process.execPath, [
      new URL('../bin/ama-check.mjs', import.meta.url).pathname,
      '--pr', write('pr.json', { number: PR, headRefOid: REVIEWED_HEAD, state: 'OPEN', isDraft: false,
        mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', labels: [], baseRefName: 'main',
        statusCheckRollup: [{ __typename: 'CheckRun', name: 'lint', conclusion: 'SUCCESS' }],
        author: { login: 'codex-worker-bot' } }),
      '--reviews', write('reviews.json', { reviews: [{ state: reviewStatus, body: REVIEW_BODY,
        author: { login: 'gemini-reviewer-lacey' }, submittedAt: '2026-10-10T11:48:00Z', commit: { oid: REVIEWED_HEAD } }] }),
      '--protection', write('protection.json', '{ "branchProtectionUnavailable": true, "reason": "github_plan" }\n'),
      '--timeline', write('timeline.json', timeline),
      '--primary-change', write('primary-change.json', { headSha: REVIEWED_HEAD, hasHammerCommits: false,
        ciCost: { headSha: REVIEWED_HEAD, ok: true } }),
      '--reviewed-sha', REVIEWED_HEAD, '--reviewer', 'gemini', '--risk-class', 'low',
      '--repo', REPO, '--root-dir', tmp,
    ], { encoding: 'utf8', env: { ...process.env, AGENT_OS_CONFIG_PATH: write('global.yaml', [
      'version: 1', 'roles:', '  adversarial:', '    merge_authority:', '      enabled: true',
      '      strict_non_blocking_remediation: true', '      eligibility:', '        risk_classes: ["low"]',
      '      branch_protection:', '        required: false', ''].join('\n')) } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  for (const number of [1, 2]) await disputeFinding(rig.args(number), { ...rig.deps, postComment });
  let headReads = 0;
  await assert.rejects(disputeFinding(rig.args(3), { ...rig.deps, postComment, get: async (url) => {
    if (url.includes('/reviews?')) return [REVIEW];
    if (++headReads > 1) throw new Error('live-head read exhausted');
    return { state: 'open', head: { sha: REVIEWED_HEAD } };
  } }), /live-head read exhausted/);
  const failedRow = rig.db.prepare('SELECT * FROM ham_finding_disputes WHERE identity=?').get(IDENTITIES[2]);
  assert.equal(failedRow.resolution, null);
  assert.equal(failedRow.comment_id, null);
  assert.equal(failedRow.requests, 0);
  const failed = run(comments);
  assert.equal(failed.eligible, false);
  assert.equal(run(comments, 'DISMISSED').eligible, false, 'dismissal alone does not resolve findings');
  assert.equal(failed.trace.verdict.hammerAdjudication.withdrawnCount, 2);
  assert.ok(failed.reasons.includes('blocking-findings-present'));
  const failedGate = pickAdversarialGateStatus({ reviewRow: reviewRow(), latestJob: null, headSha: REVIEWED_HEAD,
    hammerWithdrawals: readHammerWithdrawals({ rootDir: tmp, repo: REPO, prNumber: PR }) });
  assert.equal(failedGate.reason, 'blocking-review');

  await disputeFinding(rig.args(3), { ...rig.deps, postComment });
  const withdrawn = run(comments);
  assert.equal(withdrawn.eligible, true, JSON.stringify(withdrawn.reasons));
  assert.equal(withdrawn.trace.verdict.hammerAdjudication.settled, true);
  assert.equal(run(comments, 'DISMISSED').eligible, true, 'closure can retry after verified withdrawal dismissal');
  // A lookalike comment from anyone but the hammer resolves nothing.
  // Edits outside the evidence block still invalidate the full-body digest.
  for (const changed of [
    { ...comments.at(-1), user: { login: 'pr-author' } },
    { ...comments.at(-1), node_id: 'IC_unrecorded' },
    { ...comments.at(-1), body: comments.at(-1).body + '\nEdited footer' },
  ]) {
    const spoofed = run([...comments.slice(0, 3), changed]);
    assert.equal(spoofed.eligible, false);
    assert.ok(spoofed.reasons.includes('blocking-findings-present'));
  }
  rig.db.prepare('UPDATE ham_finding_disputes SET head_sha=? WHERE identity=?').run(OTHER_HEAD, IDENTITIES[2]);
  assert.equal(run(comments).eligible, false);
});

test('guardrail: withdrawals need trusted, unedited, concrete evidence on the reviewed head', () => {
  const body = buildWithdrawalComment({ reviewRef: REVIEW.node_id, findingNumber: 2, identity: IDENTITIES[1],
    headSha: REVIEWED_HEAD, findingReviewedHead: REVIEWED_HEAD, evidence: BASELINE_EVIDENCE });
  const hammer = { node_id: 'IC_verified', author: 'the-hammer-lacey', body };
  const records = [{ ...withdrawal(1), commentId: hammer.node_id, commentAuthor: 'the-hammer-lacey[bot]',
    commentSha256: createHash('sha256').update(body).digest('hex'),
    evidenceSha256: createHash('sha256').update(BASELINE_EVIDENCE.trim()).digest('hex') }];
  assert.deepEqual(hammerWithdrawalsFromComments([hammer]), []);
  assert.equal(hammerWithdrawalsFromComments([hammer], records).length, 1);
  assert.equal(hammerWithdrawalsFromComments([{ id: '42', node_id: hammer.node_id,
    user: { login: 'the-hammer-lacey[bot]' }, body }], records).length, 1);
  for (const forged of [
    { ...hammer, author: 'pr-author' },
    { ...hammer, body: body.replace('parses\n```', 'still parses\n```') },
    { ...hammer, body: body.replace(/```[\s\S]*```\n/, '') },
    { ...hammer, body: body.replace('Resolution: withdrawn-by-hammer', 'Resolution: disputed') },
  ]) assert.deepEqual(hammerWithdrawalsFromComments([forged], records), []);
  const [parsed] = hammerWithdrawalsFromComments([hammer], records);
  const state = { ...reviewState(), reviewedHead: REVIEWED_HEAD };
  assert.equal(resolveHammerAdjudication(state, [parsed]).withdrawnCount, 1);
  // A withdrawal recorded against another head, or an unknown blocker list, resolves nothing.
  assert.equal(resolveHammerAdjudication({ ...state, reviewedHead: OTHER_HEAD }, [parsed]).withdrawnCount, 0);
  assert.equal(resolveHammerAdjudication({ ...state, blockingFindingIdentities: null }, [parsed]).applicable, false);
  assert.equal(resolveHammerAdjudication({ ...state, blockingFindingState: 'unknown' }, [parsed]).applicable, false);
  assert.equal(pickAdversarialGateStatus({ reviewRow: reviewRow(), latestJob: stoppedJob(), headSha: REVIEWED_HEAD,
    hammerWithdrawals: [0, 1, 2].map((index) => withdrawal(index, OTHER_HEAD)) }).reason, 'remediation-stopped');
});

test('guardrail: the withdrawal store read is read-only and fail-soft', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hamfinal-01-store-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  assert.deepEqual(readHammerWithdrawals({ rootDir, repo: REPO, prNumber: PR }), []);
  mkdirSync(join(rootDir, 'data'));
  writeFileSync(join(rootDir, 'data', 'reviews.db'), 'not a database');
  const warnings = [];
  assert.deepEqual(readHammerWithdrawals({ rootDir, repo: REPO, prNumber: PR, logger: { warn: (text) => warnings.push(text) } }), []);
  assert.equal(warnings.length, 1);
  rmSync(join(rootDir, 'data', 'reviews.db'));
  // A legacy table without the HAMFINAL-01 columns contributes nothing.
  const legacy = new Database(join(rootDir, 'data', 'reviews.db'));
  legacy.exec(`CREATE TABLE ham_finding_disputes (repo TEXT, pr_number INTEGER, identity TEXT,
    requests INTEGER DEFAULT 0, PRIMARY KEY(repo, pr_number, identity))`);
  legacy.close();
  assert.deepEqual(readHammerWithdrawals({ rootDir, repo: REPO, prNumber: PR, logger: { warn() {} } }), []);
});

test('regression: descendant-head withdrawals cannot settle the reviewed head after a reset', async (t) => {
  const rig = disputeRig(t);
  for (const number of [1, 2, 3]) {
    await disputeFinding({ ...rig.args(number), headSha: HAM_HEAD }, { ...rig.deps,
      get: async (url) => url.includes('/reviews?') ? [REVIEW]
        : url.includes('/compare/') ? { status: 'ahead' } : { state: 'open', head: { sha: HAM_HEAD } },
    });
  }
  const records = readHammerWithdrawals({ rootDir: rig.rootDir, repo: REPO, prNumber: PR });
  const state = { ...reviewState(), reviewedHead: REVIEWED_HEAD };
  assert.equal(resolveHammerAdjudication({ ...state, currentHead: HAM_HEAD }, records).allBlockingWithdrawn, true);
  assert.equal(resolveHammerAdjudication({ ...state, currentHead: REVIEWED_HEAD }, records).withdrawnCount, 0);
  assert.equal(resolveHammerAdjudication({ ...state, reviewedHead: HAM_HEAD, currentHead: HAM_HEAD }, records).withdrawnCount, 0);
  const gate = pickAdversarialGateStatus({ reviewRow: reviewRow(), latestJob: null,
    headSha: REVIEWED_HEAD, hammerWithdrawals: records });
  assert.equal(gate.reason, 'blocking-review');
  const verdict = isEligibleForAmaClosure(reviewState(),
    { prNumber: PR, headSha: REVIEWED_HEAD, isOpen: true, isDraft: false, mergeableState: 'MERGEABLE', labels: [] },
    { enabled: true, workerClass: 'hammer' }, { env: {}, hammerWithdrawnFindings: records });
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.trace.verdict.hammerAdjudication.withdrawnCount, 0);
  assert.ok(verdict.reasons.includes('blocking-findings-present'));
});

test('guardrail: prose-only evidence cannot withdraw a finding', async (t) => {
  const rig = disputeRig(t);
  await assert.rejects(disputeFinding({ ...rig.args(2), evidence: 'The baseline parses fine.' }, rig.deps),
    /exact-head repro command and output, or the head file/);
  assert.equal(rig.calls.length, 0);
  assert.deepEqual(readHammerWithdrawals({ rootDir: rig.rootDir, repo: REPO, prNumber: PR }), []);
});

test('regression: a newer reviewed head with the same identity requires fresh withdrawal admission', async (t) => {
  const rig = disputeRig(t);
  let reviews = [REVIEW];
  const deps = { ...rig.deps, get: async (url) => {
    if (url.includes('/reviews?')) return reviews;
    if (url.includes('/compare/')) return { status: url.endsWith(`${HAM_HEAD}...${REVIEWED_HEAD}`) ? 'behind' : 'ahead' };
    return { state: 'open', head: { sha: HAM_HEAD } };
  } };
  const args = { ...rig.args(2), headSha: HAM_HEAD };
  const first = await disputeFinding(args, deps);
  assert.equal(first.findingReviewedHead, REVIEWED_HEAD);
  const newer = { ...REVIEW, node_id: 'PRR_new', html_url: 'https://github.com/review-new', commit_id: HAM_HEAD };
  reviews = [REVIEW, newer];
  const second = await disputeFinding({ ...args, reviewRef: newer.node_id }, deps);
  assert.equal(second.alreadyRecorded, undefined);
  assert.equal(second.findingReviewedHead, HAM_HEAD);
  assert.notEqual(second.commentId, first.commentId);
  assert.equal(rig.calls.filter(([kind]) => kind === 'comment').length, 2);
  const recorded = readHammerWithdrawals({ rootDir: rig.rootDir, repo: REPO, prNumber: PR });
  assert.equal(resolveHammerAdjudication({ ...reviewState(), reviewedHead: HAM_HEAD, currentHead: HAM_HEAD }, recorded).withdrawnCount, 1);
  assert.equal((await disputeFinding({ ...args, reviewRef: newer.node_id }, deps)).alreadyRecorded, true);
});

import './helpers/registry-session-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test__ as reviewer } from '../src/reviewer.mjs';
import { queueFollowUpForRecoveredPostedReview } from '../src/reviewer-pass-reaper.mjs';
import { claimNextFollowUpJob, readFollowUpJob } from '../src/follow-up-jobs.mjs';
import { pickAdversarialGateStatus } from '../src/adversarial-gate-status.mjs';
import { maybeDeliverOperatorDecisionNotice } from '../src/operator-decision-notice.mjs';
import { classifyOperatorGatedFindings } from '../src/ama/operator-label-gates.mjs';
import { resolveClosureNextAction } from '../src/ama/closure-next-action.mjs';
import { applyLivePackCrossEditFindings, formatLivePackRemediationContext } from '../src/live-pack-cross-edit.mjs';
import { buildRemediationPrompt } from '../src/remediation-prompt-builder.mjs';

const HEAD = 'a'.repeat(40), OTHER = 'b'.repeat(40);
const AT = '2026-01-01T00:00:00.000Z';
const identity = { repo: 'sample/repo', prNumber: 17, headSha: HEAD };
const row = { review_status: 'posted', reviewer_head_sha: HEAD };
const clean = '## Blocking issues\n- None.\n\n## Non-blocking issues\n- None.\n\n## Verdict\nApproved';
const finding = { kind: 'live_pack_cross_edit', pack: 'sample-pack',
  runs: [{ run_id: 'sample-run', state: 'running' }], run_ids: ['sample-run'],
  touched_files: ['projects/sample-pack/prompts/sample.md'], inconclusive: false };
const gated = applyLivePackCrossEditFindings(clean, [finding]);
const mixed = gated.replace('## Blocking issues', '## Blocking issues\n- **Repair parser** — reject malformed input.');
const quiet = { log() {}, warn() {}, error() {} };
const root = t => {
  const path = mkdtempSync(join(tmpdir(), 'livepack-remediation-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
};
const select = (body, overrides = {}) => resolveClosureNextAction({
  subjectKey: 'sample/repo#17', observedAt: AT,
  input: { currentHead: HEAD, lease: null, roundsLeft: true, checks: 'SUCCESS',
    reviewState: { headSha: HEAD, verdict: 'request-changes', postedAt: AT,
      blockingFindingState: 'known', blockingFindingCount: 1,
      nonBlockingFindingState: 'known', nonBlockingFindingCount: 0,
      operatorLabelFindings: classifyOperatorGatedFindings(body) }, ...overrides },
  candidate: { headSha: HEAD, prState: 'OPEN', mergeable: 'MERGEABLE' },
  autonomousMergeExecutionEnabled: true,
});

for (const source of ['reviewer', 'reaper']) {
  test(`LIVEPACKREMEDIATE-01: ${source} queues mixed findings and pages the waiver alongside remediation`, async t => {
    const rootDir = root(t);
    const queued = source === 'reviewer' ? reviewer.queueFollowUpForPostedReview({
      rootDir, ...identity, baseBranch: 'main', branch: 'fixture/SAMPLE-01', revisionRef: HEAD,
      reviewerModel: 'claude', reviewText: mixed, reviewPostedAt: AT,
      resolveHandoffConfigImpl: () => ({ enabled: false }),
    }) : queueFollowUpForRecoveredPostedReview({ rootDir, reviewPostedAt: AT,
      row: { repo: identity.repo, pr_number: 17, head_sha: HEAD, body_md: mixed,
        reviewer_model: 'claude', metadata_json: JSON.stringify({ branch: 'fixture/SAMPLE-01' }) },
      resolveHandoffConfigImpl: () => ({ enabled: false }),
    });
    assert.equal(queued.queued, true);
    const job = readFollowUpJob(queued.jobPath);
    assert.equal(job.status, 'pending');
    const claimed = claimNextFollowUpJob({ rootDir });
    assert.equal(claimed.job.status, 'in_progress');
    const decision = pickAdversarialGateStatus({ reviewRow: row, headSha: HEAD,
      latestJob: claimed.job, hasActiveSamePrRemediation: true });
    assert.equal(decision.reason, 'remediation-in-progress');
    const pages = [], logs = [];
    const args = { rootDir, ...identity, reviewRow: row, decision, now: Date.parse(AT),
      logger: { log: message => logs.push(message) },
      deliverAlertFn: async (body, meta) => pages.push({ body, meta }),
      readLivePR: async () => ({ state: 'OPEN', headRefOid: HEAD }),
      readLaunchRequestStatusImpl: () => assert.fail('waiver notice must not wait on the route') };
    await maybeDeliverOperatorDecisionNotice(args);
    await maybeDeliverOperatorDecisionNotice(args);
    assert.equal(pages.length, 1);
    assert.match(pages[0].body, /live-pack-edit-approved/);
    assert.equal(pages[0].meta.event, 'ama_closer.operator_label_required');
    assert.deepEqual(logs, []);
    assert.equal((await select(mixed)).decision.actor, 'remediator');
    const livePackContext = formatLivePackRemediationContext({ packs: [{ slug: finding.pack,
      planId: 'sample-plan', ownPack: false, live: true, runs: finding.runs, touchedFiles: finding.touched_files }] });
    const prompt = buildRemediationPrompt(job, { template: 'Repair', livePackContext,
      remediationReplyPath: '/tmp/sample-reply.json' });
    assert.match(prompt, /sample-run/);
    assert.match(prompt, /Do not revert or rewrite the PR's intended pack edits/);
    assert.match(prompt, /Only these blocking findings may be remediated:.*Repair parser/);
  });
}

test('LIVEPACKREMEDIATE-01: only the waiver remains: immediate notice and operator ownership with rounds left', async t => {
  const rootDir = root(t), pages = [];
  const latestJob = { status: 'stopped', revisionRef: HEAD, reviewBody: gated,
    remediationPlan: { stop: { code: 'operator-label-required:live-pack-edit-approved' } } };
  const decision = pickAdversarialGateStatus({ reviewRow: row, headSha: HEAD, latestJob });
  assert.equal(decision.state, 'failure');
  assert.equal(decision.reason, 'operator-label-required:live-pack-edit-approved');
  await maybeDeliverOperatorDecisionNotice({ rootDir, ...identity, reviewRow: row, decision,
    deliverAlertFn: async text => pages.push(text), logger: quiet,
    readLivePR: async () => ({ state: 'OPEN', headRefOid: HEAD }) });
  assert.equal(pages.length, 1);
  const shared = await select(gated);
  assert.equal(shared.decision.action, 'operator-hold');
  assert.equal(shared.decision.reason, decision.reason);
  assert.equal(shared.decision.actor, 'operator');
  // A stale label-only review cannot hold the new head or borrow its waiver.
  assert.equal((await select(gated, { currentHead: OTHER })).decision.action, 'review');
  const refreshed = await select(clean, { reviewState: { headSha: HEAD, verdict: 'approved',
    blockingFindingState: 'known', blockingFindingCount: 0, nonBlockingFindingState: 'known',
    nonBlockingFindingCount: 0, operatorLabelFindings: classifyOperatorGatedFindings(clean) } });
  assert.equal(refreshed.decision.action, 'daemon-merge', 'a fresh waived review returns to ordinary closeout');
});

test('LIVEPACKREMEDIATE-01: non-blocking addressable work also retains remediation ownership', async () => {
  const body = gated.replace('## Non-blocking issues\n- None.', '## Non-blocking issues\n- **Repair diagnostic** — name the failed input.');
  assert.equal(classifyOperatorGatedFindings(body).allGated, false);
  assert.equal((await select(body)).decision.actor, 'remediator');
});

for (const [state, headRefOid] of [['CLOSED', HEAD], ['MERGED', HEAD], ['OPEN', OTHER]]) {
  test(`LIVEPACKREMEDIATE-01: no waiver notice for obsolete review ${state}/${headRefOid[0]}`, async t => {
    const decision = pickAdversarialGateStatus({ reviewRow: { ...row, reviewBody: gated }, headSha: HEAD });
    await maybeDeliverOperatorDecisionNotice({ rootDir: root(t), ...identity, reviewRow: row, decision,
      deliverAlertFn: async () => assert.fail('obsolete finding must not page'),
      readLivePR: async () => ({ state, headRefOid }), logger: quiet });
  });
}

test('LIVEPACKREMEDIATE-01: a real operator-decision stop retains remediation-stopped', () => {
  const body = '## Blocking issues\n- **Choose contract** — operator must resolve conflicting requirements.\n## Verdict\nRequest changes';
  const decision = pickAdversarialGateStatus({ reviewRow: row, headSha: HEAD,
    latestJob: { status: 'stopped', revisionRef: HEAD, reviewBody: body,
      remediationPlan: { stop: { code: 'operator-decision-required' } } } });
  assert.equal(decision.reason, 'remediation-stopped');
  assert.equal(decision.operatorDecisionRequired, true);
  assert.equal(decision.operatorLabelGates, undefined);
});

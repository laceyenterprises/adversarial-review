import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as gates from '../src/ama/operator-label-gates.mjs';
import { consumeNextFollowUpJob } from '../src/follow-up-remediation.mjs';
import { createFollowUpJob } from '../src/follow-up-jobs.mjs';
import { applyLivePackCrossEditFindings, evaluateLivePackCrossEdits, formatLivePackRemediationContext } from '../src/live-pack-cross-edit.mjs';
import { resolveSettledReviewVerdict } from '../src/adversarial-gate-status.mjs';
import { buildRemediationPrompt } from '../src/remediation-prompt-builder.mjs';

const head = 'a'.repeat(40);
const label = 'live-pack-edit-approved';
const finding = { kind: 'live_pack_cross_edit', pack: 'sample-pack', runs: [{ run_id: 'run_sample', state: 'running' }],
  run_ids: ['run_sample'], touched_files: ['projects/sample-pack/plan.json'], inconclusive: false };
const clean = '## Blocking issues\n- None.\n\n## Non-blocking issues\n- None.\n\n## Verdict\nComment only\n';
const gatedBody = applyLivePackCrossEditFindings(clean, [finding]);
const log = { log() {}, warn() {}, error() {}, info() {} };

test('REMLABEL-01: operator-only live-pack finding never dispatches; comment and page occur once', async t => {
  const oldRemediator = process.env.ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR;
  process.env.ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR = 'remediator-codex-corp';
  t.after(() => {
    if (oldRemediator === undefined) delete process.env.ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR;
    else process.env.ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR = oldRemediator;
  });
  const rootDir = mkdtempSync(join(tmpdir(), 'remlabel-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  createFollowUpJob({ rootDir, repo: 'sample/repo', prNumber: 1, revisionRef: head,
    reviewerModel: 'claude', reviewBody: gatedBody, reviewPostedAt: '2026-10-16T12:00:00Z' });
  const comments = [];
  const pages = [];
  const args = { rootDir, promptTemplate: 'Remediate', log,
    resolvePRLifecycleImpl: async () => ({ prState: 'open', source: 'live', headSha: head }),
    postCommentImpl: async ({ body, workerClass }) => {
      assert.equal(workerClass, 'claude-code', 'the hold uses its reviewer bot without resolving remediation config');
      comments.push(body); return { posted: true };
    },
    deliverAlertImpl: async body => { pages.push(body); },
    execFileImpl: async () => { throw new Error('must not prepare or launch a worker'); },
    resolveRemediationWorkerClassImpl: async () => { throw new Error('must not route a remediator'); },
    spawnImpl: () => { throw new Error('must not spawn'); } };
  const result = await consumeNextFollowUpJob(args);
  assert.equal(result.reason, `operator-label-required:${label}`);
  assert.equal(result.job.remediationWorker.state, 'never-spawned');
  assert.equal(result.job.remediationPlan.rounds.at(-1).spawnedAt, undefined);
  assert.equal((await consumeNextFollowUpJob(args)).reason, 'no-pending-jobs');
  const classification = gates.classifyOperatorGatedFindings(gatedBody);
  await gates.holdForOperatorLabels({ ...args, repo: 'sample/repo', prNumber: 1, headSha: head,
    gates: classification.gated.map(({ check, label, reason }) => ({ check, label, reason })) });
  assert.equal(comments.length, 1);
  assert.equal(pages.length, 1);
  assert.equal(readdirSync(join(rootDir, 'data', 'operator-label-holds')).some(name => name.endsWith('.lock')), false);
  assert.match(comments[0], /live-pack-edit-approved/);
  assert.match(comments[0], /leave the guarded changes in place/);
});

for (const [prState, headSha, expected] of [
  ['closed', head, 'pr-closed'], ['merged', head, 'pr-merged'],
  ['open', 'b'.repeat(40), 'stale-review-head'],
]) {
  test(`operator-only review respects lifecycle before paging: ${expected}`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'remlabel-lifecycle-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    createFollowUpJob({ rootDir, repo: 'sample/repo', prNumber: 1, revisionRef: head,
      reviewerModel: 'claude', reviewBody: gatedBody, reviewPostedAt: '2026-10-16T12:00:00Z' });
    let lifecycleReads = 0;
    const result = await consumeNextFollowUpJob({ rootDir, promptTemplate: 'Remediate', log,
      resolvePRLifecycleImpl: async () => { lifecycleReads++; return { prState, headSha, source: 'live' }; },
      postCommentImpl: async ({ body }) => {
        assert.doesNotMatch(body, /Operator-gated review held/);
        return { posted: true };
      },
      deliverAlertImpl: async () => assert.fail('obsolete PR must not page'),
      execFileImpl: async () => assert.fail('obsolete PR must not prepare a worker'),
      spawnImpl: () => assert.fail('obsolete PR must not spawn') });
    assert.equal(result.reason, expected);
    assert.equal(result.job.status, 'stopped');
    assert.equal(lifecycleReads, 1);
    assert.equal(result.job.remediationWorker.state, 'never-spawned');
  });
}

test('REMLABEL-01: mixed findings restrict the prompt to actionable fixes and preserve gated changes', () => {
  const body = gatedBody.replace('## Blocking issues', '## Blocking issues\n- **Repair parser** — reject malformed input.');
  const classification = gates.classifyOperatorGatedFindings(body);
  assert.equal(classification.allGated, false);
  assert.equal(classification.gated.length, 1);
  assert.equal(classification.actionable.length, 1);
  const prompt = buildRemediationPrompt({ jobId: 'sample-job', repo: 'sample/repo', prNumber: 1,
    baseBranch: 'main', reviewBody: body }, { template: 'Remediate', remediationReplyPath: '/tmp/sample/reply.json' });
  assert.match(prompt, /Only these blocking findings may be remediated:.*Repair parser/);
  assert.match(prompt, /Leave their changes in place/);
  assert.match(prompt, /Do not edit or restore/);
  assert.match(prompt, /Report them in blockers/);
});

test('REMLABEL-01: a fresh review observing the waiver proceeds without an operator-only remediation hold', async () => {
  const evaluate = labels => evaluateLivePackCrossEdits({ repo: 'sample/repo', prNumber: 1,
    changedPaths: finding.touched_files, baseRef: 'main', headRef: head, labels,
    fetchFileAtRefImpl: async () => JSON.stringify({ planId: 'sample-plan', tickets: [] }),
    readActiveDagRunsImpl: async () => ({ ok: true, runs: finding.runs }) });
  const refused = await evaluate([]);
  assert.equal(gates.classifyOperatorGatedFindings(applyLivePackCrossEditFindings(clean, refused.findings)).allGated, true);
  const waived = await evaluate([{ name: label }]);
  assert.equal(waived.waived, true);
  assert.deepEqual(waived.findings, []);
  assert.equal(gates.classifyOperatorGatedFindings(applyLivePackCrossEditFindings(clean, waived.findings)).allGated, false);
});

test('REMLABEL-01: live-pack guidance never directs restoration to base', () => {
  const context = formatLivePackRemediationContext({ packs: [{ slug: 'sample-pack', planId: 'sample-plan',
    live: true, runs: finding.runs, touchedFiles: finding.touched_files }] });
  assert.doesNotMatch(context, /addressed by restoring|restoring.*is allowed/i);
  assert.match(context, /never revert/);
  assert.doesNotMatch(gatedBody, /Restore these files/);
});


test('REMLABEL-01: every staged remediator uses the guarded publisher and bounded lease replay', () => {
  for (const currentRound of [0, 1, 2]) {
    const prompt = buildRemediationPrompt({ jobId: 'sample-job', repo: 'sample/repo', prNumber: 1,
      baseBranch: 'main', branch: 'topic', revisionRef: head, reviewBody: gatedBody,
      remediationPlan: { currentRound, maxRounds: 3 } }, { remediationReplyPath: '/tmp/sample/reply.json' });
    assert.match(prompt, /remediation-publish\.mjs/);
    assert.match(prompt, /--previous-head 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'/);
    assert.match(prompt, /--expected-remote-sha <fresh-remote-sha>/);
    assert.match(prompt, /Retry (?:that stale-head replay )?at most three times/);
    assert.match(prompt, /diff-guard refusal is terminal/);
    assert.doesNotMatch(prompt, /git push --force-with-lease/);
  }
});


test('REMLABEL-01: closer classification uses the current review body after an operator hold', t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'remlabel-settled-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const args = { repo: 'sample/repo', prNumber: 1, currentHeadSha: head,
    reviewRow: { review_status: 'posted', reviewer_head_sha: head },
    latestJobFinder: () => ({ status: 'stopped', revisionRef: head, reviewBody: gatedBody }),
    capturedReviewerPassFinder: () => null };
  const held = resolveSettledReviewVerdict(rootDir, { ...args, liveHeadReview: { resolved: true, bodies: [gatedBody] } });
  assert.equal(held.remediationPending, false);
  assert.equal(held.operatorLabelFindings.allGated, true);
  const fresh = resolveSettledReviewVerdict(rootDir, { ...args, liveHeadReview: { resolved: true, bodies: [clean] } });
  assert.equal(fresh.operatorLabelFindings.allGated, false);
  assert.equal(fresh.blockingFindingCount, 0);
  const unknown = resolveSettledReviewVerdict(rootDir, { ...args, liveHeadReview: { resolved: false } });
  assert.equal(unknown.operatorLabelFindings, null);
});

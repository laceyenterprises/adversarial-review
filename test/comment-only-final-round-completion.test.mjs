import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFinalRoundOperationalBlockers,
  resolveCommentOnlyFinalRoundCompletion,
} from '../src/comment-only-final-round-completion.mjs';
import { validateRemediationReply } from '../src/kernel/remediation-reply.mjs';

const reviewedHead = '1'.repeat(40);
const pushedHead = '2'.repeat(40);
const pendingCiBlocker = {
  title: 'pending-pr-head-ci',
  finding: 'PR-head repo-guards had not completed after one bounded CI wait.',
  reasoning: 'Required checks need to complete before the AMA closer can merge.',
};
const pendingGate = { state: 'pending', headSha: pushedHead, failedChecks: [], pendingChecks: [{ name: 'repo-guards' }] };

test('pending CI on the proven pushed head is the only thing a final-round blocker may report', () => {
  const classify = (blockers, ciGate = pendingGate, head = pushedHead) =>
    classifyFinalRoundOperationalBlockers(blockers, { ciGate, pushedHead: head });

  assert.deepEqual(classify([]), { pendingCiOnly: true, reason: 'none' });
  assert.deepEqual(classify([{ ...pendingCiBlocker, kind: 'pending-ci' }]),
    { pendingCiOnly: true, reason: 'kind-pending-ci' });
  // A worker predating the tag writes one entry; the probe corroborates it.
  assert.deepEqual(classify([pendingCiBlocker]), { pendingCiOnly: true, reason: 'ci-probe-pending-ci' });
  assert.equal(classify([pendingCiBlocker], { ...pendingGate, state: 'green' }).pendingCiOnly, true);

  assert.equal(classify([pendingCiBlocker], { ...pendingGate, state: 'failed' }).reason, 'ci-failed');
  assert.equal(classify([pendingCiBlocker], { ...pendingGate, state: 'unknown' }).reason, 'ci-unknown');
  assert.equal(classify([pendingCiBlocker], { ...pendingGate, headSha: reviewedHead }).reason, 'ci-probe-head-mismatch');
  assert.equal(classify([pendingCiBlocker], null).reason, 'ci-probe-head-mismatch');
  assert.equal(classify([pendingCiBlocker], pendingGate, null).reason, 'no-proven-push');
  assert.equal(classify([pendingCiBlocker, { ...pendingCiBlocker, title: 'second' }]).reason,
    'ambiguous-untagged-operational-blockers');
  // A declared non-CI code fails closed even when tagged and even while CI is pending.
  assert.equal(classify([{ ...pendingCiBlocker, title: 'stale-pr-head', kind: 'pending-ci' }]).reason,
    'declared-non-ci-operational-blocker');
});

test('the title never classifies pending CI: a CI-sounding title with red CI fails closed', () => {
  const result = classifyFinalRoundOperationalBlockers([{ ...pendingCiBlocker, title: 'ci-pending' }], {
    ciGate: { ...pendingGate, state: 'failed', failedChecks: [{ name: 'repo-guards' }] },
    pushedHead,
  });
  assert.deepEqual(result, { pendingCiOnly: false, reason: 'ci-failed' });
});

test('reply schema accepts kind pending-ci and rejects an unknown kind', () => {
  const reply = {
    kind: 'adversarial-review-remediation-reply', schemaVersion: 1, jobId: 'job-1',
    outcome: 'partial', summary: 'Pushed the one-line fix.', validation: ['git diff --check'],
    addressed: [], pushback: [], blockers: [],
    operationalBlockers: [{ ...pendingCiBlocker, kind: 'pending-ci' }],
    reReview: { requested: false, reason: null },
  };
  assert.doesNotThrow(() => validateRemediationReply(reply));
  assert.throws(
    () => validateRemediationReply({ ...reply, operationalBlockers: [{ ...pendingCiBlocker, kind: 'ci-ish' }] }),
    /operationalBlockers\[0\]\.kind must be one of: pending-ci/,
  );
});

function finalRoundJob(overrides = {}) {
  return {
    jobId: 'example__repo-pr-42-final', repo: 'example/repo', prNumber: 42, baseBranch: 'main',
    revisionRef: reviewedHead, finalRound: 'comment-only', ...overrides,
  };
}

function pushedWorkspaceExec({ jobId = 'example__repo-pr-42-final', head = pushedHead } = {}) {
  return async (command, args) => {
    if (command === 'gh') return { stdout: args[0] === 'api' ? 'ahead\n' : `${head}\n` };
    if (args.includes('show')) return { stdout: `fix\n\nWorker-Job-Id: ${jobId}\n` };
    if (args.includes('cherry')) return { stdout: args.at(-1) === `origin/main` ? `+ ${head}\n` : '' };
    if (args.includes('rev-list')) return { stdout: '' };
    return { stdout: `${head}\n` };
  };
}

async function resolve({ reply, ciGate = pendingGate, job = finalRoundJob(), execFileImpl = pushedWorkspaceExec(), audit = { suspect: [], error: null } } = {}) {
  const warnings = [];
  const probes = [];
  const alerts = [];
  const result = await resolveCommentOnlyFinalRoundCompletion({
    job, jobPath: '/unused', reply, workspaceDir: '/tmp/final-round/workspace',
    auditWorkspaceForContaminationImpl: async () => audit,
    inspectRemediationCiRegressionImpl: async (args) => { probes.push(args); return ciGate; },
    deliverAlertImpl: async (text, options) => { alerts.push({ text, ...options }); return { queued: true }; },
    execFileImpl,
    log: { warn: (msg) => warnings.push(msg), log: () => {}, error: (msg) => warnings.push(msg) },
  });
  return { result, warnings, probes, alerts };
}

test('a partial final round whose only blocker is pending CI completes with its pushed head', async () => {
  const { result, probes } = await resolve({
    reply: { outcome: 'partial', blockers: [], operationalBlockers: [pendingCiBlocker] },
  });
  assert.equal(result.completed, true);
  assert.equal(result.workerPushedHeadSha, pushedHead);
  assert.deepEqual(result.completionFields, {
    workerPushedHeadSha: pushedHead,
    workerPushProof: { method: 'git-cherry-replay', reviewedCommitsReplayed: 0, workerCommits: 1 },
    finalRoundOutcome: { completed: true, reason: 'ci-probe-pending-ci', ciState: 'pending', push: 'descendant' },
  });
  assert.equal(probes.length, 1, 'the CI state probe decides, not the reply text');
});

test('a final round with red CI or a review blocker is not complete but still records its push', async () => {
  const red = await resolve({
    reply: { outcome: 'blocked', blockers: [], operationalBlockers: [pendingCiBlocker] },
    ciGate: { ...pendingGate, state: 'failed' },
  });
  assert.equal(red.result.completed, false);
  assert.equal(red.result.completionFields.workerPushedHeadSha, pushedHead);
  assert.equal(red.result.completionFields.finalRoundOutcome.reason, 'ci-failed');
  assert.match(red.warnings.join('\n'), /is not complete: outcome=blocked reason=ci-failed/);

  const blocked = await resolve({
    reply: { outcome: 'blocked', blockers: [{ finding: 'Needs a product decision.' }], operationalBlockers: [] },
  });
  assert.equal(blocked.result.completed, false);
  assert.equal(blocked.result.completionFields.finalRoundOutcome.reason, 'review-blockers');
  assert.equal(blocked.probes.length, 0);
});

test('a clean final round that pushed nothing still completes; a partial one without a push does not', async () => {
  const unchanged = pushedWorkspaceExec({ head: reviewedHead });
  const clean = await resolve({ reply: { outcome: 'completed', blockers: [], operationalBlockers: [] }, execFileImpl: unchanged });
  assert.equal(clean.result.completed, true);
  assert.equal(clean.result.workerPushedHeadSha, null);
  const partial = await resolve({ reply: { outcome: 'partial', blockers: [], operationalBlockers: [] }, execFileImpl: unchanged });
  assert.equal(partial.result.completed, false);
  assert.equal(partial.result.completionFields.finalRoundOutcome.reason, 'no-proven-push');
});

test('non-final jobs are untouched', async () => {
  const { result, probes } = await resolve({
    job: finalRoundJob({ finalRound: undefined }),
    reply: { outcome: 'partial', blockers: [], operationalBlockers: [pendingCiBlocker] },
  });
  assert.deepEqual(result, { completed: false, workerPushedHeadSha: null, completionFields: {} });
  assert.equal(probes.length, 0);
});

test('a completed final round whose moved head cannot be proven alerts and records the held head', async () => {
  const foreignHead = '3'.repeat(40);
  const { result, alerts, warnings } = await resolve({
    reply: { outcome: 'completed', blockers: [], operationalBlockers: [] },
    // The workspace HEAD is the worker's commit, but someone else's head is live.
    execFileImpl: async (command, args) => (command === 'gh'
      ? { stdout: `${foreignHead}\n` }
      : pushedWorkspaceExec()(command, args)),
  });
  assert.equal(result.workerPushedHeadSha, null);
  assert.equal(result.completed, true, 'the worker outcome stands; the head is held, not re-reviewed');
  assert.equal(result.completionFields.withheldPushHeadSha, foreignHead);
  assert.match(result.completionFields.finalRoundOutcome.push, /^live-head-mismatch/);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].event, 'adversarial_review.comment_only_final_round_push_unproven');
  assert.equal(alerts[0].payload.liveHeadSha, foreignHead);
  assert.match(alerts[0].text, /could not be proven \(live-head-mismatch/);
  assert.match(warnings.join('\n'), /Withholding final-round push proof for example\/repo#42: live-head-mismatch/);
});

test('a contamination-audit failure withholds the proof, names the reason, and alerts on a moved head', async () => {
  const { result, alerts } = await resolve({
    reply: { outcome: 'completed', blockers: [], operationalBlockers: [] },
    audit: { suspect: [{ sha: 'abc', subject: 'dup' }], error: null },
  });
  assert.equal(result.workerPushedHeadSha, null);
  assert.equal(result.completionFields.finalRoundOutcome.push, 'branch-contamination-audit-failed');
  assert.equal(result.completionFields.withheldPushHeadSha, pushedHead);
  assert.equal(alerts.length, 1);
});

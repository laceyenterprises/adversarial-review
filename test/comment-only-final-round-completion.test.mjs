import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFinalRoundOperationalBlockers,
  resolveCommentOnlyFinalRoundCompletion,
} from '../src/comment-only-final-round-completion.mjs';
import { normalizeCiPendingOnlyReply, validateRemediationReply } from '../src/kernel/remediation-reply.mjs';

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
  assert.deepEqual(classify([{ ...pendingCiBlocker, kind: 'pending-ci' }], { ...pendingGate, state: 'green' }),
    { pendingCiOnly: true, reason: 'kind-pending-ci' });
  // The untagged legacy entry is the CI wait only while CI is still running.
  assert.deepEqual(classify([pendingCiBlocker], { ...pendingGate, state: 'green' }),
    { pendingCiOnly: false, reason: 'untagged-blocker-ci-not-pending' });

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

test('an unrelated blocker is never the CI wait, even while CI is pending', () => {
  const classify = (blockers, outcome = 'partial', ciGate = pendingGate) =>
    classifyFinalRoundOperationalBlockers(blockers, { ciGate, pushedHead, outcome });
  const unrelated = {
    title: 'missing-deploy-credential',
    finding: 'The staging deploy key is not provisioned for this repo.',
    needsHumanInput: 'Provision the staging deploy key.',
  };
  assert.deepEqual(classify([unrelated], 'blocked'),
    { pendingCiOnly: false, reason: 'operational-blocker-needs-human-input' });
  assert.deepEqual(classify([{ ...unrelated, needsHumanInput: undefined, reasoning: 'Needs the key.' }], 'blocked'),
    { pendingCiOnly: false, reason: 'untagged-blocker-outcome-blocked' });
  // Asking a human is not waiting on CI, whatever the tag says.
  assert.deepEqual(classify([{ ...unrelated, kind: 'pending-ci' }]),
    { pendingCiOnly: false, reason: 'operational-blocker-needs-human-input' });
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

async function resolve({ reply, ciGate = pendingGate, job = finalRoundJob(), execFileImpl = pushedWorkspaceExec(), audit = { suspect: [], error: null }, ...options } = {}) {
  const warnings = [];
  const probes = [];
  const alerts = [];
  const audits = [audit].flat();
  const result = await resolveCommentOnlyFinalRoundCompletion({
    job, jobPath: '/unused', reply, workspaceDir: '/tmp/final-round/workspace',
    auditWorkspaceForContaminationImpl: async () => (audits.length > 1 ? audits.shift() : audits[0]),
    inspectRemediationCiRegressionImpl: async (args) => { probes.push(args); return ciGate; },
    deliverAlertImpl: async (text, options) => { alerts.push({ text, ...options }); return { queued: true }; },
    execFileImpl,
    log: { warn: (msg) => warnings.push(msg), log: () => {}, error: (msg) => warnings.push(msg) },
    sleepImpl: async () => {},
    writeJobImpl: () => assert.fail('only a transient retry writes the job'),
    ...options,
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

test('a blocked reply with an unrelated blocker does not complete the final round on pending CI', async () => {
  const { result, alerts } = await resolve({
    reply: {
      outcome: 'blocked', blockers: [],
      operationalBlockers: [{
        title: 'missing-deploy-credential', finding: 'The staging deploy key is not provisioned.',
        needsHumanInput: 'Provision the staging deploy key.',
      }],
    },
  });
  assert.equal(result.completed, false);
  assert.equal(result.workerPushedHeadSha, pushedHead, 'the push is still recorded');
  assert.equal(result.completionFields.finalRoundOutcome.reason, 'operational-blocker-needs-human-input');
  assert.deepEqual(alerts, []);
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

test('a completed final round whose moved head cannot be proven records the head for automatic review', async () => {
  const foreignHead = '3'.repeat(40);
  const { result, alerts, warnings } = await resolve({
    reply: { outcome: 'completed', blockers: [], operationalBlockers: [] },
    // The workspace HEAD is the worker's commit, but someone else's head is live.
    execFileImpl: async (command, args) => (command === 'gh'
      ? { stdout: `${foreignHead}\n` }
      : pushedWorkspaceExec()(command, args)),
  });
  assert.equal(result.workerPushedHeadSha, null);
  assert.equal(result.completed, true, 'the worker outcome stands; the head requires automatic review');
  assert.equal(result.completionFields.withheldPushHeadSha, foreignHead);
  assert.match(result.completionFields.finalRoundOutcome.push, /^live-head-mismatch/);
  assert.equal(alerts.length, 0);
  assert.match(warnings.join('\n'), /Withholding final-round push proof for example\/repo#42: live-head-mismatch/);
});

test('a contamination-audit failure withholds the proof, names the reason for automatic review', async () => {
  const { result, alerts } = await resolve({
    reply: { outcome: 'completed', blockers: [], operationalBlockers: [] },
    audit: { suspect: [{ sha: 'abc', subject: 'dup' }], error: null },
  });
  assert.equal(result.workerPushedHeadSha, null);
  assert.equal(result.completionFields.finalRoundOutcome.push, 'branch-contamination-audit-failed');
  assert.equal(result.completionFields.withheldPushHeadSha, pushedHead);
  assert.equal(alerts.length, 0);
});

const completedReply = { outcome: 'completed', blockers: [], operationalBlockers: [] };
const fetchTimeout = 'git fetch origin main failed: Command failed: git fetch origin main\nfatal: unable to access \'https://github.com/example/repo.git/\': Operation timed out';

test('a transient contamination-audit failure is retried, then the push is proven', async () => {
  const sleeps = [];
  const { result, alerts } = await resolve({
    reply: completedReply,
    audit: [{ suspect: [], error: fetchTimeout }, { suspect: [], error: null }],
    sleepImpl: async (ms) => { sleeps.push(ms); },
  });
  assert.deepEqual(sleeps, [2000]);
  assert.equal(result.completed, true);
  assert.equal(result.workerPushedHeadSha, pushedHead);
  assert.equal(alerts.length, 0);
});

test('a git lock during the push proof is retried rather than holding the head', async () => {
  let locked = 1;
  const { result, alerts } = await resolve({
    reply: completedReply,
    execFileImpl: async (command, args) => {
      if (command === 'git' && args.includes('rev-parse') && locked-- > 0) {
        throw new Error("Command failed: git rev-parse HEAD\nfatal: Unable to create '/w/.git/index.lock': File exists.");
      }
      return pushedWorkspaceExec()(command, args);
    },
  });
  assert.equal(result.workerPushedHeadSha, pushedHead);
  assert.equal(result.completionFields.withheldPushHeadSha, undefined);
  assert.equal(alerts.length, 0);
});

test('a transient failure that outlasts the in-process retries leaves the job re-entrant', async () => {
  const writes = [];
  const nowMs = Date.parse('2026-09-28T12:00:00Z');
  const { result, alerts } = await resolve({
    reply: completedReply,
    audit: { suspect: [], error: fetchTimeout },
    now: () => nowMs,
    writeJobImpl: (path, job) => writes.push({ path, job }),
  });
  assert.equal(result.retryLater, true);
  assert.equal(result.completed, false);
  assert.deepEqual(result.completionFields, {}, 'no withheld head is recorded');
  assert.equal(alerts.length, 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/unused');
  assert.deepEqual(writes[0].job.finalRoundProofTransient, {
    since: '2026-09-28T12:00:00.000Z', lastAttemptAt: '2026-09-28T12:00:00.000Z', attempts: 3, error: `audit: ${fetchTimeout}`,
  });
  assert.equal(result.job, writes[0].job);

  // The next reconcile keeps the first failure time and counts on.
  const later = await resolve({
    reply: completedReply, job: writes[0].job, audit: { suspect: [], error: fetchTimeout },
    now: () => nowMs + 10 * 60 * 1000, writeJobImpl: (path, job) => writes.push({ path, job }),
  });
  assert.equal(later.result.retryLater, true);
  assert.equal(writes[1].job.finalRoundProofTransient.since, '2026-09-28T12:00:00.000Z');
  assert.equal(writes[1].job.finalRoundProofTransient.attempts, 6);

  // Past the window it is withheld, which holds the head and alerts an operator.
  const expired = await resolve({
    reply: completedReply, job: writes[0].job, audit: { suspect: [], error: fetchTimeout },
    now: () => nowMs + 61 * 60 * 1000,
  });
  assert.equal(expired.result.retryLater, undefined);
  assert.equal(expired.result.completionFields.finalRoundOutcome.push, 'branch-contamination-audit-failed');
  assert.equal(expired.result.completionFields.withheldPushHeadSha, pushedHead);
  assert.equal(expired.alerts.length, 0);
});

test('a non-transient audit error withholds at once, without retrying', async () => {
  let sleeps = 0;
  const { result, alerts } = await resolve({
    reply: completedReply,
    audit: { suspect: [], error: 'workspace has no .git' },
    sleepImpl: async () => { sleeps += 1; },
  });
  assert.equal(sleeps, 0);
  assert.equal(result.completionFields.finalRoundOutcome.push, 'branch-contamination-audit-failed');
  assert.equal(alerts.length, 0);
});


test('HELDHEAD-01 pending-only CI reply is work-complete even when replay proof is withheld', async () => {
  const reply = normalizeCiPendingOnlyReply({
    outcome: 'blocked', summary: `Pushed ${pushedHead}; findings fixed.`, validation: [],
    blockers: [], operationalBlockers: [{ kind: 'pending-ci', title: 'Repo Guards',
      finding: 'PR-head CI remains pending.', needsHumanInput: 'Human intervention required' }],
    reReview: { requested: false },
  }, { expectedJob: finalRoundJob() });
  const { result } = await resolve({ reply, execFileImpl: async (command, args) =>
    command === 'git' && args.includes('cherry')
      ? { stdout: `+ ${reviewedHead}\n` } : pushedWorkspaceExec()(command, args) });
  assert.equal(result.completed, true);
  assert.equal(result.completionFields.finalRoundOutcome.ciState, 'pending');
  assert.equal(result.completionFields.withheldPushHeadSha, pushedHead);
  assert.equal(result.workerPushedHeadSha, null);
});

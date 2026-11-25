import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { createReviewCurrencyReader, rebaseCurrencyCovers } from '../src/ama/review-currency.mjs';
import { readCompletedRemediationRounds } from '../src/ama/hammer-head-validation.mjs';
import { validateRemediationReply } from '../src/kernel/remediation-reply.mjs';
import { parseReviewFindings } from '../src/kernel/review-findings.mjs';
import { resolveRemediationReplyTarget } from '../src/remediation-reply-paths.mjs';

const repo = 'example/agent-os';
const prNumber = 11643;
const reviewed = 'a'.repeat(40);
const published = 'b'.repeat(40);
const current = 'c'.repeat(40);
const branch = 'builder/pack';
const ref = `refs/heads/${branch}`;
const spawnedAt = '2026-11-25T11:13:04.716Z';
const reconciledAt = '2026-11-25T11:27:37.939Z';
const stoppedAt = '2026-11-25T11:37:50.216Z';
const firstTitle = 'Upstream gates read the wrong repository';
const secondTitle = 'Builder titles conflict with publication policy';
const packTitle = '[live_pack_cross_edit] Cross-pack edit of live build pack `work-pack`';
const reviewBody = [
  '## Blocking issues', '', `- **${firstTitle}**`, '  - **File:** plan.json', '  - **Problem:** Reads from the wrong repository',
  `- **${secondTitle}**`, '  - **File:** step.md', '  - **Problem:** Requires a title forbidden by policy',
  '- **Incidental note** — explanatory prose',
  `- **${packTitle}** — run(s): unknown (inconclusive); touched: \`plan.json\`.`,
  '', '## Non-blocking issues', '- None.', '', '## Verdict', 'Request changes',
].join('\n');

async function fixture(t) {
  const rootDir = await mkdtemp(join(tmpdir(), 'stopped-remediation-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const hqRoot = join(rootDir, 'hq');
  const originalHqRoot = process.env.HQ_ROOT;
  process.env.HQ_ROOT = hqRoot;
  t.after(() => {
    if (originalHqRoot === undefined) delete process.env.HQ_ROOT;
    else process.env.HQ_ROOT = originalHqRoot;
  });
  const jobId = 'example__agent-os-pr-11643-2026-11-25T11-09-24-514Z';
  const { replyPath } = resolveRemediationReplyTarget().resolvePath({ launchRequestId: jobId });
  const workspaceDir = join(rootDir, 'workspace');
  const outputPath = join(workspaceDir, '.adversarial-follow-up', 'codex-last-message.md');
  const worker = {
    workerClass: 'codex', state: 'failed', launchRequestId: jobId, spawnedAt, reconciledAt,
    recordedOutcome: { exitCode: 0, signal: null }, replyPath, workspaceDir, outputPath,
  };
  const stop = { code: 'max-rounds-reached', ciRegression: true, sourceStatus: 'failed',
    stoppedBy: { type: 'system', requestedBy: 'watcher-ci-admission' } };
  const failure = { code: 'invalid-remediation-reply', remediationReplyPath: replyPath,
    message: 'review has 2 blocking issue(s), reply records 3 (addressed=2, pushback=0, blockers=1)' };
  const round = { round: 2, kind: 'remediation', state: 'stopped', revisionRef: reviewed, startHeadSha: reviewed,
    publishedHeadSha: published, spawnedAt, finishedAt: stoppedAt, worker, stop, failure };
  const job = { kind: 'adversarial-review-follow-up', status: 'stopped', jobId, repo, prNumber, branch,
    revisionRef: reviewed, domainId: 'code-pr', stoppedAt, workspaceDir, reviewBody, failure,
    remediationWorker: structuredClone(worker),
    remediationPlan: { currentRound: 2, maxRounds: 2, dispatchPath: 'bare', stop, rounds: [round] } };
  const reply = {
    kind: 'adversarial-review-remediation-reply', schemaVersion: 1, jobId, repo, prNumber,
    outcome: 'partial', summary: 'Published source with remaining external holds.', validation: [],
    addressed: [firstTitle, secondTitle].map(title => ({ title, finding: title, action: 'Repaired the source.', files: ['plan.json'] })),
    pushback: [], blockers: [{ title: packTitle, finding: 'Cross-pack edit', reasoning: 'Pack evidence was inconclusive.' }],
    operationalBlockers: [{ title: 'ci-pending', kind: 'pending-ci', finding: 'The PR check remained pending.',
      reasoning: 'The bounded check observation ended.' }],
    nonBlocking: [], reReview: { requested: false, reason: null },
  };
  const actor = { type: 'Bot', login: 'lacey-codex-agent[bot]' };
  const activity = [
    { actor, ref, activity_type: 'push', before: published, after: current, timestamp: '2026-11-25T15:29:34Z' },
    { actor, ref, activity_type: 'force_push', before: reviewed, after: published, timestamp: '2026-11-25T11:23:16Z' },
  ];
  const live = { state: 'open', head: { sha: current, ref: branch, repo: { full_name: repo } }, base: { sha: 'd'.repeat(40) } };
  const comparison = { status: 'ahead', merge_base_commit: { sha: published }, total_commits: 1 };
  const commit = { sha: published, commit: { message: `Publish pack fixes\n\nWorker-Class: codex-remediation\nWorker-Job-Id: ${jobId}\n` } };
  const jobPath = join(rootDir, 'data', 'follow-up-jobs', 'stopped', `${jobId}.json`);
  async function put(path, text) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
    await utimes(path, new Date('2026-11-25T11:25:00Z'), new Date('2026-11-25T11:25:00Z'));
  }
  async function read({ partition = 'stopped', writeOutput = true, rebaseOnly = false, head = current } = {}) {
    await put(jobPath.replace('/stopped/', `/${partition}/`), JSON.stringify(job));
    await put(replyPath, JSON.stringify(reply));
    if (writeOutput) await put(outputPath, 'Finished the source fixes and left the operator hold.');
    const get = async path => {
      if (path.includes(`/compare/${reviewed}...${head}`)) return { status: 'diverged' };
      if (path.includes(`/compare/${published}...${head}`)) return comparison;
      if (path.includes('/activity?')) return activity;
      if (path.endsWith(`/commits/${published}`)) return commit;
      throw new Error(`Unexpected history read ${path}`);
    };
    const currency = createReviewCurrencyReader({ repo, prNumber, rootDir, get, comments: [], pr: live,
      git: async () => { throw new Error('No checkout available'); } });
    return currency(reviewed, head, { rebaseOnly });
  }
  return { rootDir, job, round, worker, reply, activity, comparison, commit, live, replyPath, jobPath, put, read };
}

test('the published source and its CI child carry findings from the actual final review only', async t => {
  const f = await fixture(t);
  assert.equal(parseReviewFindings(reviewBody).blocking.count, 3);
  assert.equal(validateRemediationReply(f.reply, { expectedJob: f.job }).blockers[0].title, packTitle);
  const omitted = { ...f.reply, blockers: [] };
  assert.throws(() => validateRemediationReply(omitted, { expectedJob: f.job }), /review has 3 blocking issue/);
  const wrongTitle = { ...f.reply, blockers: [{ ...f.reply.blockers[0], title: 'Different pack' }] };
  assert.throws(() => validateRemediationReply(wrongTitle, { expectedJob: f.job }), /titles must match/);

  const evidence = await f.read({ partition: 'stopped-archived' });
  assert.equal(evidence.proof, 'verified-stopped-remediation-finding-currency');
  assert.equal(rebaseCurrencyCovers(evidence, reviewed, current), false);
  for (const [remediationPending, reason] of [[true, 'remediation-pending'], [undefined, 'remediation-state-unknown']]) {
    const result = isEligibleForAmaClosure({
      headSha: reviewed, reviewCurrency: evidence, verdict: 'request-changes',
      blockingFindingState: 'known', blockingFindingCount: 3, remediationPending,
    }, { headSha: current, isOpen: true, mergeableState: 'MERGEABLE' }, { enabled: true, eligibility: {} });
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.includes(reason));
    assert.ok(result.reasons.includes('blocking-findings-present'));
    assert.ok(result.reasons.includes('stale-review-head'));
  }
  assert.equal((await f.read({ partition: 'stopped-archived', rebaseOnly: true })).current, false);
  assert.deepEqual(await readCompletedRemediationRounds(f.rootDir, repo, prNumber), []);
  f.activity.shift();
  f.live.head.sha = published;
  assert.equal((await f.read({ partition: 'stopped-archived', head: published })).proof, evidence.proof);
});

const refusals = {
  'only a pending record': { partition: 'pending' },
  'unknown local exit outcome': f => { delete f.worker.recordedOutcome; },
  'worker exit nonzero': f => { f.worker.recordedOutcome.exitCode = 1; },
  'HQ worker without its own produced proof': f => { f.worker.dispatchId = 'lrq_other'; },
  'operator-stopped round': f => { f.job.remediationPlan.stop.stoppedBy = { type: 'operator' }; },
  'another accounting failure': f => { f.job.failure.message = 'invalid JSON'; },
  'mismatched published SHA': f => { f.round.publishedHeadSha = 'e'.repeat(40); },
  'ambiguous provenance trailers': f => { f.commit.commit.message += `Worker-Job-Id: ${f.job.jobId}\n`; },
  'human copy of the App login': f => { f.activity[1].actor = { ...f.activity[1].actor, type: 'User' }; },
  'different registered App pushes the source': f => { f.activity[1].actor.login = 'lacey-claude-agent[bot]'; },
  'force-push from a different branch': f => { f.activity[1].ref = 'refs/heads/other'; },
  'force-push outside the worker attempt': f => { f.activity[1].timestamp = '2026-11-25T10:00:00Z'; },
  'withheld push sidecar': f => f.put(`${f.replyPath}.publication-failure.json`, '{}'),
  'same job still present in progress': f => f.put(f.jobPath.replace('/stopped/', '/in-progress/'), '{}'),
  'missing final message': { writeOutput: false },
  'missing pack accountability': f => { f.reply.blockers = []; },
  'publication refusal mislabeled as pending CI': f => { f.reply.operationalBlockers[0].title = 'push-lease-rejected'; },
  'unstructured pending CI report': f => { f.reply.operationalBlockers[0].kind = undefined; },
  'mismatched PR in canonical reply': f => { f.reply.prNumber++; },
  'unproven successor ancestry': f => { f.comparison.merge_base_commit.sha = reviewed; },
  'later force-push': f => { f.activity[0].activity_type = 'force_push'; },
  'capped branch activity': f => { f.activity.push(...Array(98).fill({})); },
  'duplicated terminal record': f => f.put(f.jobPath.replace('/stopped/', '/stopped-archived/'), JSON.stringify(f.job)),
  'terminal PR': f => { f.live.state = 'closed'; },
};

for (const [name, change] of Object.entries(refusals)) {
  test(`stopped publication refuses ${name}`, async t => {
    const f = await fixture(t);
    if (typeof change === 'function') await change(f);
    assert.equal((await f.read(typeof change === 'object' ? change : {})).current, false);
  });
}

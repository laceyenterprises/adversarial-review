import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { createReviewCurrencyReader, currencyGit, rebaseCurrencyCovers } from '../src/ama/review-currency.mjs';
import { readCompletedRemediationRounds } from '../src/ama/hammer-head-validation.mjs';
import { latestAuthoritativeReviewInAncestry } from '../src/ama/reviewer-authority.mjs';
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
    revisionRef: reviewed, domainId: 'code-pr', createdAt: '2026-11-25T11:09:24.514Z', reviewerModel: 'codex',
    stoppedAt, workspaceDir, reviewBody, failure,
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
  const successor = { sha: current, commit: { message: commit.commit.message } };
  const review = { id: 1, commit_id: reviewed, user: { login: 'lacey-codex-reviewer[bot]' },
    submitted_at: '2026-11-25T11:09:11Z', body: reviewBody, state: 'CHANGES_REQUESTED' };
  const jobPath = join(rootDir, 'data', 'follow-up-jobs', 'stopped', `${jobId}.json`);
  const reads = [];
  async function put(path, text) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
    await utimes(path, new Date('2026-11-25T11:25:00Z'), new Date('2026-11-25T11:25:00Z'));
  }
  async function reader({ partition = 'stopped', writeOutput = true, head = current } = {}) {
    reads.length = 0;
    await put(jobPath.replace('/stopped/', `/${partition}/`), JSON.stringify(job));
    await put(replyPath, JSON.stringify(reply));
    if (writeOutput) await put(outputPath, 'Finished the source fixes and left the operator hold.');
    const get = async path => {
      reads.push(path);
      if (path.includes(`/compare/${reviewed}...${head}`)) return { status: 'diverged' };
      if (path.includes(`/compare/${published}...${head}`)) return comparison;
      if (path.includes('/activity?')) return activity;
      if (path.endsWith(`/commits/${published}`)) return commit;
      if (path.endsWith(`/commits/${current}`)) return successor;
      throw new Error(`Unexpected history read ${path}`);
    };
    return createReviewCurrencyReader({ repo, prNumber, rootDir, get, comments: [], pr: live,
      git: async () => { throw new Error('No checkout available'); } });
  }
  async function read({ rebaseOnly = false, head = current, ...options } = {}) {
    return (await reader({ head, ...options }))(reviewed, head, { rebaseOnly, review });
  }
  return { rootDir, job, round, worker, reply, activity, comparison, commit, successor, review, live, replyPath, jobPath, put, read, reader, reads };
}

test('the published source and its direct child keep findings applicable without a head-match waiver', async t => {
  const f = await fixture(t);
  assert.equal(parseReviewFindings(reviewBody).blocking.count, 3);
  assert.equal(validateRemediationReply(f.reply, { expectedJob: f.job }).blockers[0].title, packTitle);
  const omitted = { ...f.reply, blockers: [] };
  assert.throws(() => validateRemediationReply(omitted, { expectedJob: f.job }), /review has 3 blocking issue/);
  const wrongTitle = { ...f.reply, blockers: [{ ...f.reply.blockers[0], title: 'Different pack' }] };
  assert.throws(() => validateRemediationReply(wrongTitle, { expectedJob: f.job }), /titles must match/);

  const evidence = await f.read({ partition: 'stopped-archived/2026-11' });
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
  assert.equal((await f.read({ partition: 'stopped-archived/2026-11', rebaseOnly: true })).current, false);
  assert.deepEqual(await readCompletedRemediationRounds(f.rootDir, repo, prNumber), []);
  f.activity.shift();
  f.live.head.sha = published;
  assert.equal((await f.read({ partition: 'stopped-archived/2026-11', head: published })).proof, evidence.proof);
});

test('stopped publication currency is scoped to the matching submitted review in a shared reader', async t => {
  const f = await fixture(t);
  const currency = await f.reader();
  const sibling = { ...f.review, id: 2, user: { login: 'lacey-claude-reviewer' }, state: 'COMMENTED' };
  const otherBody = { ...f.review, id: 3, body: `${reviewBody}\nDifferent review text.` };
  const later = { ...f.review, id: 4, submitted_at: '2026-11-25T11:10:00Z' };
  assert.equal((await currency(reviewed, current)).current, false);
  assert.equal((await currency(reviewed, current, { review: sibling })).current, false);
  const selected = await latestAuthoritativeReviewInAncestry([f.review, sibling], current, null, currency);
  assert.equal(selected, f.review);
  assert.equal((await currency(reviewed, current, { review: otherBody })).current, false);
  assert.equal((await currency(reviewed, current, { review: later })).current, false);
  assert.equal(f.reads.filter(path => path.includes('/activity?')).length, 1);
});

const refusals = {
  'only a pending record': { partition: 'pending' },
  'stop at another review head': f => { f.job.revisionRef = 'e'.repeat(40); },
  'unknown local exit outcome': f => { delete f.worker.recordedOutcome; },
  'worker exit nonzero': f => { f.worker.recordedOutcome.exitCode = 1; },
  'HQ worker without its own produced proof': f => { f.worker.dispatchId = 'lrq_other'; },
  'operator-stopped round': f => { f.job.remediationPlan.stop.stoppedBy = { type: 'operator' }; },
  'another accounting failure': f => { f.job.failure.message = 'invalid JSON'; },
  'mismatched published SHA': f => { f.round.publishedHeadSha = 'e'.repeat(40); },
  'ambiguous provenance trailers': f => { f.commit.commit.message += `Worker-Job-Id: ${f.job.jobId}\n`; },
  'publication trailer for another job': f => { f.commit.commit.message = f.commit.commit.message.replace(f.job.jobId, `${f.job.jobId}-other`); },
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
  'successor without worker trailers': f => { f.successor.commit.message = 'Follow-up change without provenance'; },
  'successor from a different job using the same App': f => {
    f.successor.commit.message = f.successor.commit.message.replace(f.job.jobId, `${f.job.jobId}-other`);
  },
  'later force-push': f => { f.activity[0].activity_type = 'force_push'; },
  'capped branch activity': f => { f.activity.push(...Array(98).fill({})); },
  'duplicated terminal record': f => f.put(f.jobPath.replace('/stopped/', '/stopped-archived/2026-11/'), JSON.stringify(f.job)),
  'terminal PR': f => { f.live.state = 'closed'; },
};

const noActivityRead = new Set([
  'only a pending record', 'stop at another review head', 'operator-stopped round',
  'another accounting failure', 'same job still present in progress', 'duplicated terminal record',
  'withheld push sidecar', 'missing final message', 'missing pack accountability',
  'publication refusal mislabeled as pending CI', 'unstructured pending CI report', 'mismatched PR in canonical reply',
]);

for (const [name, change] of Object.entries(refusals)) {
  test(`stopped publication refuses ${name}`, async t => {
    const f = await fixture(t);
    if (typeof change === 'function') await change(f);
    assert.equal((await f.read(typeof change === 'object' ? change : {})).current, false);
    if (noActivityRead.has(name)) assert.equal(f.reads.some(path => path.includes('/activity?')), false);
    if (name === 'human copy of the App login') assert.equal(f.reads.some(path => path.includes('/commits/')), false);
  });
}

test('a capped local scan supplies no partial proof or activity read', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 256; index++) {
    await f.put(join(dirname(f.jobPath), `${f.job.jobId}-${index}.json`), '{}');
  }
  assert.equal((await f.read()).current, false);
  assert.equal(f.reads.some(path => path.includes('/activity?')), false);
});

test('corrupt matching JSON refuses proof and identifies the offending artifact', async t => {
  const f = await fixture(t);
  const bad = join(dirname(f.jobPath), `${f.job.jobId}-corrupt.json`);
  await f.put(bad, '{');
  const result = await f.read();
  assert.equal(result.current, false);
  assert.ok(result.missingProof.includes(`invalid JSON: ${bad}`), result.missingProof);
  assert.equal(f.reads.some(path => path.includes('/activity?')), false);
});

test('cached names never cache job contents across separate currency readers', async t => {
  const f = await fixture(t);
  assert.equal((await f.read()).current, true);
  f.job.failure.message = 'different refusal';
  assert.equal((await f.read()).current, false);
  assert.equal(f.reads.some(path => path.includes('/activity?')), false);
});

async function advisoryFixture(t) {
  const f = await fixture(t);
  const cwd = join(f.rootDir, 'checkout');
  await mkdir(cwd);
  const git = (args, input, options) => currencyGit(args, input, { ...options, cwd });
  const head = async () => (await git(['rev-parse', 'HEAD'])).trim();
  const put = (path, text) => f.put(join(cwd, path), text);
  const commit = async message => {
    await git(['add', '--all']);
    await git(['commit', '-m', message]);
    return head();
  };
  const spec = 'projects/work-pack/SPEC.md';
  const cli = 'docs/reference/hq-cli-reference.md';
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.name', 'Fixture']);
  await git(['config', 'user.email', 'fixture@example.test']);
  await put(spec, 'Existing pack contract\n');
  await put(cli, 'Existing CLI reference\n');
  await put('source.js', 'old\n');
  await commit('Initial main');
  await git(['checkout', '-b', 'reviewed']);
  await put('source.js', 'feature\n');
  const reviewed = await commit('Original reviewed source');
  await git(['checkout', 'main']);
  await put('trunk.txt', 'main updated\n');
  await commit('Advance main');
  await git(['checkout', '-b', 'publication']);
  await git(['cherry-pick', reviewed]);
  await put('source.js', 'feature with error handling\n');
  const published = await commit(`Worker publication\n\nWorker-Class: codex-remediation\nWorker-Job-Id: ${f.job.jobId}`);
  await git(['checkout', '-b', 'closer']);
  await put(spec, 'Existing pack contract\nDocument the new interface.\n');
  await put(cli, 'Closer CLI reference\n');
  const closer = await commit('Publish pack amendment');
  await git(['checkout', 'main']);
  await put('trunk.txt', 'new trunk\n');
  const intermediate = await commit('Intermediate main');
  await put(cli, 'Updated main CLI reference\n');
  const base = await commit('Latest main');
  await git(['checkout', '-b', 'integrate', published]);
  await put(cli, 'Regenerated CLI reference\n');
  await commit('Regenerate CLI docs');
  await git(['merge', '--no-edit', intermediate]);
  const beforeCloser = await head();
  await git(['merge', '--no-edit', '-X', 'ours', closer]);
  await git(['merge', '--no-edit', '-X', 'ours', base]);
  const current = await head();

  const specTitle = 'Document the interface in the governing pack';
  const body = [
    '## Blocking issues', '- None.', '## Non-blocking issues',
    `- **${firstTitle}**`, '  - **File:** source.js', '  - **Problem:** No error handling.',
    `- **${specTitle}**`, '  - **File:** source.js', `  - **Problem:** The interface is absent from ${spec}.`,
    '## Verdict', 'Comment only',
  ].join('\n');
  Object.assign(f.review, { commit_id: reviewed, body, state: 'COMMENTED', user: { ...f.review.user, type: 'Bot' } });
  const reply = { ...f.reply, addressed: [], nonBlocking: [{ title: firstTitle, finding: 'Missing error handling',
    action: 'Added handling.', files: ['source.js'] }], blockers: [{ title: specTitle, kind: 'live-pack-operator-edit',
    finding: 'The governing pack needs an edit.', reasoning: 'The operator owns this edit.',
    needsHumanInput: `Operator-Live-Edit-Required: live-pack-plan ${spec}` }] };
  const stop = { code: 'no-progress', sourceStatus: 'completed', stoppedBy: null, stoppedAt: reconciledAt };
  const reReview = { requested: false, status: 'suppressed', suppressed: 'comment-only-final-round' };
  const message = 'Published during the bounded worker attempt.\n';
  const completion = { workerPushedHeadSha: published, workerModel: 'codex', finalRemediationPush: true,
    workerPushProof: { method: 'git-cherry-replay', reviewedCommitsReplayed: 1, workerCommits: 1 },
    finalRoundOutcome: { completed: false, reason: 'review-blockers', ciState: null, push: 'replayed-onto-base' },
    finalMessagePath: f.worker.outputPath, finalMessageBytes: Buffer.byteLength(message),
    finalMessageDigest: createHash('sha256').update(message).digest('hex') };
  const receipt = { state: 'worker-wrote-reply', path: f.replyPath, payload: reply };
  Object.assign(f.worker, { state: 'completed' });
  Object.assign(f.round, { round: 1, revisionRef: reviewed, startHeadSha: reviewed, publishedHeadSha: published,
    completion, stop, finishedAt: reconciledAt, reReview, remediationReply: receipt, failure: null });
  Object.assign(f.job.remediationPlan, { currentRound: 1, stop });
  Object.assign(f.job, { revisionRef: reviewed, reviewBody: body, remediationWorker: f.worker,
    completion, nonBlockingOnly: true, finalRound: 'comment-only', stoppedAt: reconciledAt, failure: null,
    reReview, remediationReply: receipt });
  const opener = { actor: f.activity[1].actor, type: 'force_push', before: reviewed, after: published, at: f.activity[1].timestamp };
  const hammer = { type: 'Bot', login: 'the-hammer-lacey[bot]' };
  const activity = [
    { actor: { type: 'User', login: 'maintainer' }, type: 'push', before: closer, after: current, at: '2026-11-25T12:30:00Z' },
    { actor: hammer, type: 'push', before: published, after: closer, at: '2026-11-25T12:00:00Z' }, opener,
  ].map(({ type, at, ...event }) => ({ ...event, ref, activity_type: type, timestamp: at }));
  const comments = [{ user: hammer, body: `HAM-Base-Head: ${published}\nHAM-Pushed-Head: ${closer}` }];
  const live = { ...f.live, head: { ...f.live.head, sha: current }, base: { sha: base, ref: 'main', repo: { full_name: repo } } };
  const reviews = [structuredClone(f.review)];
  const get = async path => {
    if (path.includes('/compare/')) return { status: 'diverged' };
    if (path.includes('/activity?')) return activity;
    if (path.endsWith('/reviews?per_page=100')) return reviews;
    if (path.endsWith(`/commits/${published}`)) return { sha: published, commit: { message: await git(['show', '-s', '--format=%B', published]) } };
    throw new Error(`Unexpected history read ${path}`);
  };
  const reader = async (gitImpl = git) => {
    await f.put(f.jobPath, JSON.stringify(f.job));
    await f.put(f.replyPath, JSON.stringify(reply));
    await f.put(f.worker.outputPath, message);
    return createReviewCurrencyReader({ repo, prNumber, rootDir: f.rootDir, get, git: gitImpl, comments, pr: live });
  };
  const amend = async (path, text) => {
    await put(path, text);
    await git(['add', '--all']);
    await git(['commit', '--amend', '--no-edit']);
    live.head.sha = activity[0].after = await head();
  };
  return { ...f, read: async () => (await reader())(reviewed, live.head.sha, { review: f.review }),
    reader, reviewed, published, closer, current, live, reviews, comments, activity, reply, completion, amend, spec,
    git, beforeCloser };
}

test('native stopped advisory publication retains the authoritative review through the closer and exact main integration', async t => {
  const f = await advisoryFixture(t);
  const currency = await f.reader();
  const proof = await currency(f.reviewed, f.current, { review: f.review });
  assert.equal(proof.proof, 'verified-stopped-advisory-finding-lineage', proof.missingProof);
  assert.equal((await currency(f.reviewed, f.current)).proof, proof.proof);
  assert.equal(await latestAuthoritativeReviewInAncestry(f.reviews, f.current, null, currency), f.reviews[0]);
  assert.equal((await currency(f.reviewed, f.current, { rebaseOnly: true, review: f.review })).current, false);
  assert.equal(rebaseCurrencyCovers(proof, f.reviewed, f.current), false);
  assert.deepEqual(await readCompletedRemediationRounds(f.rootDir, repo, prNumber), []);
  for (const [remediationPending, reason] of [[true, 'remediation-pending'], [undefined, 'remediation-state-unknown'],
    [false, 'non-blocking-findings-present']]) {
    const verdict = isEligibleForAmaClosure({ headSha: f.reviewed, reviewCurrency: proof, verdict: 'comment-only',
      blockingFindingState: 'known', blockingFindingCount: 0, nonBlockingFindingState: 'known',
      nonBlockingFindingCount: 2, remediationPending,
    }, { headSha: f.current, isOpen: true, mergeableState: 'MERGEABLE' }, { enabled: true, eligibility: {} });
    assert.equal(verdict.eligible, false);
    for (const refusal of [reason, 'stale-review-head']) assert.ok(verdict.reasons.includes(refusal), verdict.reasons.join(', '));
  }
});

test('native stopped advisory lineage fails closed when the closer is absent from the first parent', async t => {
  const f = await advisoryFixture(t);
  // Keep the integration tree and main parent. Replace only the first parent.
  const current = (await f.git(['commit-tree', `${f.current}^{tree}`, '-p', f.beforeCloser,
    '-p', f.live.base.sha, '-m', 'Integrate without closer ancestry'])).trim();
  f.live.head.sha = f.activity[0].after = current;
  const ancestryArgs = ['merge-base', '--is-ancestor', f.closer, f.beforeCloser];
  await assert.rejects(f.git(ancestryArgs), { code: 1 });
  let checkedAncestry = false;
  const currency = await f.reader((args, input, options) => {
    if (args.join(' ') === ancestryArgs.join(' ')) checkedAncestry = true;
    return f.git(args, input, options);
  });
  const proof = await currency(f.reviewed, current, { review: f.review });
  assert.equal(proof.current, false);
  assert.equal(checkedAncestry, true);
  assert.ok(!proof.missingProof.includes(ancestryArgs.join(' ')), proof.missingProof);
});

for (const hasCheckout of [false, true]) {
  test(`native stopped advisory lineage skips source replay with ${hasCheckout ? 'a stale' : 'no'} origin-bound checkout`, async t => {
    const f = await advisoryFixture(t);
    const trace = join(f.rootDir, 'git.trace');
    const cloneRoot = join(f.rootDir, 'clones');
    if (hasCheckout) {
      const cwd = join(cloneRoot, repo);
      await mkdir(cwd, { recursive: true });
      await currencyGit(['init'], undefined, { cwd });
      await currencyGit(['remote', 'add', 'origin', `git@github.com:${repo}.git`], undefined, { cwd });
    }
    const originalTrace = process.env.GIT_TRACE2_EVENT;
    const originalCloneRoot = process.env.ADVERSARIAL_REVIEWER_CLONE_ROOT;
    process.env.GIT_TRACE2_EVENT = trace;
    process.env.ADVERSARIAL_REVIEWER_CLONE_ROOT = cloneRoot;
    t.after(() => {
      if (originalTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
      else process.env.GIT_TRACE2_EVENT = originalTrace;
      if (originalCloneRoot === undefined) delete process.env.ADVERSARIAL_REVIEWER_CLONE_ROOT;
      else process.env.ADVERSARIAL_REVIEWER_CLONE_ROOT = originalCloneRoot;
    });
    const currency = await f.reader(null);
    assert.equal((await currency(f.reviewed, f.current, { review: f.review })).current, false);
    const commands = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      .filter(event => event.event === 'start').map(event => event.argv[1]);
    assert.equal(commands.filter(command => command === 'cat-file').length, hasCheckout ? 2 : 1);
    assert.equal(commands.slice(commands.indexOf('cat-file') + 1).includes('merge-base'), false,
      'source replay requires a hydrated checkout');
  });
}

for (const artifact of ['replyPath', 'outputPath']) {
  test(`native stopped advisory lineage declines a missing ${artifact} without a filesystem error`, async t => {
    const f = await advisoryFixture(t);
    const currency = await f.reader();
    await rm(f.worker[artifact]);
    const proof = await currency(f.reviewed, f.current, { review: f.review });
    assert.equal(proof.current, false);
    assert.doesNotMatch(proof.missingProof, /ENOENT/);
  });
}

const advisoryRefusals = {
  'an unaccounted source finding': f => { f.reply.nonBlocking = []; },
  'an unresolved source finding': f => { f.reply.blockers[0].kind = 'source-defect'; },
  'the withheld final push': f => { f.completion.finalRemediationPush = false; },
  'a publication-failure artifact': f => f.put(`${f.replyPath}.publication-failure.json`, '{}'),
  'a mismatched final artifact digest': f => { f.completion.finalMessageDigest = 'f'.repeat(64); },
  'a different reply launch': f => { f.worker.launchRequestId = 'lrq_other'; },
  'a still-owned job': f => f.put(f.jobPath.replace('/stopped/', '/in-progress/'), '{}'),
  'a different source review ID': f => { f.reviews[0].id++; },
  'a different source review body': f => { f.reviews[0].body += '\nOther findings'; },
  'a copied reviewer login': f => { f.reviews[0].user.type = 'User'; },
  'an incorrect replay count': f => { f.completion.workerPushProof.reviewedCommitsReplayed = 2; },
  'an unauthenticated worker push': f => { f.activity[2].actor.type = 'User'; },
  'an unauthenticated closer push': f => { f.activity[1].actor.type = 'User'; },
  'a different closer App': f => { f.activity[1].actor = { type: 'Bot', login: 'other-closer[bot]' }; },
  'a copied closer publication comment': f => { f.comments[0].user = { login: 'maintainer' }; },
  'an intervening branch rewrite': f => { f.activity[0].activity_type = 'force_push'; },
  'a final tree that drops the worker repair': f => f.amend('source.js', 'feature\n'),
  'a final tree that drops the SPEC amendment': f => f.amend(f.spec, 'Existing pack contract\n'),
  'an unrelated final source addition': f => f.amend('unreviewed.js', 'extra source\n'),
};
for (const [description, change] of Object.entries(advisoryRefusals)) {
  test(`native stopped advisory lineage refuses ${description}`, async t => {
    const f = await advisoryFixture(t);
    await change(f);
    assert.equal((await f.read()).current, false);
  });
}

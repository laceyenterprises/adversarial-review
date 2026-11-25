import './helpers/load-aware-timeout-fixture.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkPrimaryChange, fetchPrimaryChange } from '../src/ama/primary-change.mjs';
import { review as makeReview, collect } from './helpers/hamclose-history.mjs';

const sha = digit => digit.repeat(40);
const repo = 'fixture/repo', prNumber = 8088;
const oldBase = sha('0'), reviewedHead = sha('1'), rebased = sha('2'), parent = sha('3'), base = sha('b'), head = sha('c');
const spec = 'docs/SPEC-startup.md';
const jobId = 'fixture__repo-pr-8088-follow-up';
const review = makeReview({ body: `## Blocking issues
- **Spec drift**
  - **File:** \`src/a.mjs\`
  - **Lines:** \`10-11\`
  - **Problem:** Startup contract drifted.
  - **Recommended fix:** Update the spec.

## Non-blocking issues
- **Unsafe startup**
  - **File:** \`src/a.mjs\`
  - **Lines:** \`10-11\`
  - **Problem:** Unsafe startup.
  - **Recommended fix:** Revert it.

## Verdict
Request changes` });
const entry = (id, previous, message = 'sample change') =>
  ({ sha: id, parents: [{ sha: previous }], commit: { message } });
const blob = digit => ({ mode: '100644', type: 'blob', sha: sha(digit) });

async function run(t, mutate = () => {}, strict = true) {
  const rootDir = mkdtempSync(join(tmpdir(), 'source-remediation-parent-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const store = join(rootDir, 'data', 'primary-change-history');
  const { transport } = await collect({ reviews: [review], cites: ['PRR_cited finding=1 kind=non-blocking'] });
  const original = await transport(`repos/${repo}/compare/${oldBase}...${reviewedHead}`);
  const primary = await transport(`repos/${repo}/compare/${base}...${rebased}`);
  const hammer = await transport(`repos/${repo}/commits/${head}`);
  hammer.parents[0].sha = parent;
  const worker = { state: 'completed', launchRequestId: jobId, workerClass: 'codex' };
  const completion = { workerPushedHeadSha: parent, finalRemediationPush: true };
  const round = { round: 2, kind: 'remediation', state: 'completed', startHeadSha: reviewedHead,
    revisionRef: reviewedHead, resultingHeadSha: parent, publishedHeadSha: parent, worker, completion,
    remediationReply: { state: 'worker-wrote-reply', payload: {
      jobId, repo, prNumber, kind: 'adversarial-review-remediation-reply', schemaVersion: 1,
      outcome: 'completed', summary: 'Updated the startup specification.',
      addressed: [{ title: 'Spec drift', finding: 'Spec drift', action: 'Documented startup.', files: [`${spec}:42`] }],
      validation: ['Checked the spec.'], blockers: [], reReview: { requested: false },
    } } };
  const job = { kind: 'adversarial-review-follow-up', repo, prNumber, jobId, status: 'completed',
    revisionRef: reviewedHead, reviewerModel: 'claude', reviewBody: review.body,
    completion: { ...completion }, remediationWorker: { ...worker },
    remediationPlan: { dispatchPath: 'bare', currentRound: 2, maxRounds: 2, rounds: [round] },
  };
  const doc = { filename: spec, sha: sha('a'), status: 'added', additions: 1, deletions: 0,
    patch: '@@ -0,0 +1 @@\n+The startup contract.' };
  const fixture = {
    job, round, hammer, docs: [doc], review: structuredClone(review),
    original: { ...original, total_commits: 1, commits: [entry(reviewedHead, oldBase)] },
    history: [entry(rebased, base), entry(parent, rebased,
      `Update the spec\n\nWorker-Class: codex-remediation\nWorker-Job-Id: ${jobId}`), hammer],
    baseComparison: { status: 'ahead', merge_base_commit: { sha: oldBase } },
    timeline: { nodes: [{ __typename: 'HeadRefForcePushedEvent', createdAt: '2026-10-11T17:20:00Z',
      actor: { __typename: 'Bot', login: 'lacey-codex-agent' },
      beforeCommit: { oid: reviewedHead }, afterCommit: { oid: parent } }], pageInfo: { hasNextPage: false } },
    originalDelta: [{ path: 'src/a.mjs', a: blob('4'), b: blob('5') }],
    replayDelta: [{ path: 'src/a.mjs', a: blob('4'), b: blob('5') }],
    publishedDelta: [{ path: spec, b: blob('a') }],
  };
  mutate(fixture);
  if (fixture.persist) mkdirSync(store, { recursive: true });
  if (fixture.job) {
    const completed = join(rootDir, 'data', 'follow-up-jobs', 'completed');
    mkdirSync(completed, { recursive: true });
    writeFileSync(join(completed, 'fixture__repo-pr-8088-2026-10-11T17-00-00-000Z.json'), JSON.stringify(fixture.job));
    if (fixture.damagedSibling !== undefined) {
      writeFileSync(join(completed, 'fixture__repo-pr-8088-damaged.json'), fixture.damagedSibling);
    }
  }

  const comparisons = new Map([
    [`${base}...${head}`, { merge_base_commit: { sha: base }, files: fixture.docs,
      commits: fixture.history, total_commits: fixture.history.length }],
    [`${base}...${parent}`, { ...primary, files: [...primary.files, ...fixture.docs] }],
    [`${oldBase}...${reviewedHead}`, fixture.original],
    [`${oldBase}...${base}`, fixture.baseComparison],
    [`${reviewedHead}...${parent}`, { status: 'diverged', merge_base_commit: { sha: oldBase } }],
    [`${parent}...${parent}`, { status: 'identical' }],
  ]);
  const get = async path => {
    if (path.endsWith('/reviews?per_page=100')) return [fixture.review, ...(fixture.otherReviews || [])];
    if (path.endsWith(`/commits/${head}`)) return fixture.hammer;
    return comparisons.get(path.split('/compare/')[1]) || transport(path);
  };
  get.persistPrimaryChange = fixture.persist;
  get.metadata = get;
  get.env = fixture.env;
  get.exactFileChanges = async (_repo, before, after) => {
    if (fixture.treeError) throw fixture.treeError;
    assert.equal(before, new Map([[parent, rebased], [reviewedHead, oldBase], [rebased, base]]).get(after));
    return new Map([[parent, fixture.publishedDelta], [reviewedHead, fixture.originalDelta],
      [rebased, fixture.replayDelta]]).get(after);
  };
  get.forcePushTimelinePage = async () => {
    if (fixture.timelineError) throw fixture.timelineError;
    return fixture.timeline;
  };
  const read = () => fetchPrimaryChange({ repo, prNumber, headSha: head, get, rootDir },
    { fetchCiCostImpl: async () => ({ ok: true, headSha: head }) });
  const evidence = await read();
  return { evidence, result: checkPrimaryChange(evidence, head, { strictNonBlockingRemediation: strict }), read, fixture, store };
}

test('completed docs publication between rebased review and closer preserves exact source authority', async t => {
  const { evidence, result } = await run(t);
  assert.deepEqual(evidence.reversalAuthorizations[0].sourceRemediationPaths, [spec]);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('completed docs publication uses the reader environment for the worker App', async t => {
  const { result } = await run(t, f => {
    f.env = { OAUTH_BROKER_CODEX_AGENT_PROVIDER: 'github-app-renamed-codex' };
    f.timeline.nodes[0].actor.login = 'renamed-codex[bot]';
  });
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('failed publication reads are uncached and retried on the same head', async t => {
  for (const [key, flags] of [
    ['timelineError', { primaryChangeReadFailed: true }],
    ['timelineError', { authOutage: true }],
    ['treeError', { primaryChangeReadFailed: true }],
  ]) {
    await t.test(`${key}: ${Object.keys(flags)[0]}`, async t => {
      const { evidence, read, fixture, store } = await run(t, f => {
        f.persist = true;
        f[key] = Object.assign(new Error('fixture publication read failed'), flags);
      });
      assert.equal(evidence.historyReadFailed, true, JSON.stringify(evidence));
      assert.equal(evidence.readFailed, true);
      assert.deepEqual(readdirSync(store), []);

      delete fixture[key];
      const recovered = await read();
      assert.deepEqual(recovered.reversalAuthorizations[0].sourceRemediationPaths, [spec]);
      assert.equal(recovered.laneReversalHistory, true, 'the publication carries a worker-job trailer');
      assert.deepEqual(readdirSync(store), []);
    });
  }
});

test('missing or mismatched publication or immutable replay retains reviewed-parent refusal', async t => {
  const cases = {
    'absent completed job': f => { f.job = null; },
    'unfinished round': f => { f.round.state = 'in-progress'; },
    'head observation without worker publication': f => { delete f.round.completion.workerPushedHeadSha; },
    'no published round endpoint': f => { delete f.round.publishedHeadSha; },
    'signed publication lane cannot claim the bare receipt': f => { f.round.worker.requiresProducedAttestation = true; },
    'wrong worker': f => { f.round.worker.workerClass = 'gemini'; f.job.remediationWorker.workerClass = 'gemini'; },
    'missing worker class': f => { delete f.round.worker.workerClass; delete f.job.remediationWorker.workerClass; },
    'wrong launch': f => { f.round.worker.launchRequestId = 'different-job'; },
    'wrong review body': f => { f.job.reviewBody += 'Altered.'; },
    'wrong PR': f => { f.job.prNumber++; },
    'placeholder reply': f => { f.round.remediationReply.payload.summary = 'Replace this with a short remediation summary.'; },
    'truncated sibling job': f => { f.damagedSibling = JSON.stringify(f.job).slice(0, -1); },
    'oversize sibling job': f => { f.damagedSibling = `${JSON.stringify(f.job)}${' '.repeat(1024 * 1024)}`; },
    'unlisted spec path': f => { f.round.remediationReply.payload.addressed[0].files = ['docs/SPEC-other.md']; },
    'forged push actor': f => { f.timeline.nodes[0].actor.__typename = 'User'; },
    'different fleet App': f => { f.timeline.nodes[0].actor.login = 'lacey-claude-agent'; },
    'different push endpoint': f => { f.timeline.nodes[0].beforeCommit.oid = base; },
    'incomplete push timeline': f => { f.timeline.pageInfo = { hasNextPage: true, endCursor: 'repeat' }; },
    'wrong rebase direction': f => { f.baseComparison.status = 'behind'; },
    'wrong published parent': f => { f.history[1].parents[0].sha = oldBase; },
    'nonlinear history': f => { f.history[1].parents.push({ sha: oldBase }); },
    'rewritten blob differs': f => { f.replayDelta[0].b = blob('6'); },
    'rewritten mode differs': f => { f.replayDelta[0].b.mode = '100755'; },
    'opaque tree evidence': f => { f.replayDelta = null; },
    'empty publication': f => { f.publishedDelta = []; },
    'unrelated source edit': f => { f.publishedDelta.push({ path: 'src/extra.mjs', b: blob('7') }); },
    'parent gains other edits': f => { f.docs.push({ ...f.docs[0], filename: 'docs/SPEC-other.md' }); },
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async t => {
    const { result } = await run(t, mutate);
    assert.equal(result.reason, 'primary-change-reverted', JSON.stringify(result));
    assert.equal(result.missingEvidence.rejected[0].reason, 'reviewed-parent-patch-differs');
  });
});

test('composed evidence still requires strict policy, finding coverage and HAM patch coverage', async t => {
  const nonStrict = await run(t, undefined, false);
  assert.equal(nonStrict.result.reason, 'primary-change-reverted');
  const wrongLines = await run(t, f => {
    // The cited line is inside the protected insertion, but the HAM patch
    // also removes the neighboring uncited line from that same insertion.
    f.review.body = f.review.body.replace('`10-11`\n  - **Problem:** Unsafe startup.', '`10-10`\n  - **Problem:** Unsafe startup.');
    f.job.reviewBody = f.review.body;
  });
  assert.deepEqual(wrongLines.evidence.reversalAuthorizations[0].sourceRemediationPaths, [spec]);
  assert.equal(wrongLines.result.missingEvidence.rejected[0].reason, 'not-covered-by-cited-finding');
  const wrongPatch = await run(t, f => {
    f.hammer.files[0].patch = f.hammer.files[0].patch.replace('-start_unsafe()', '-different_content()');
  });
  assert.equal(wrongPatch.result.reason, 'primary-change-reverted');
});

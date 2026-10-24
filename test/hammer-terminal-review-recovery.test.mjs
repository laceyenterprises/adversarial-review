import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maybeDispatchAmaClosureFor, resolveMergeAgentCoexistenceForWatcher } from '../src/ama-closure-orchestration.mjs';
import { publishPushedHammerAttestation } from '../src/ama/hammer-pushed-attestation.mjs';
import { proveCloserAuthoredStaleHead } from '../src/closer-authored-stale.mjs';
import { probeOrphanOwnership } from '../src/ama/orphan-watchdog.mjs';
import { updateAmaCloserDispatchRecord } from '../src/ama/dispatch-closer.mjs';
import { openReviewStateDb, ensureReviewStateSchema, requestReviewRereview } from '../src/review-state.mjs';
import { isOrphanHeadReviewRequested } from '../src/orphan-head-review-requested.mjs';

const reviewed = 'a'.repeat(40), published = 'b'.repeat(40), intermediate = 'c'.repeat(40);
const repo = 'fixture/project', prNumber = 7;
const body = '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nComment only';
const quiet = { log() {}, info() {}, warn() {} };

async function fixture(t, { bridge = false } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-terminal-review-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const db = openReviewStateDb(rootDir);
  t.after(() => db.close());
  ensureReviewStateSchema(db);
  db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,pr_state,
    review_status,reviewer_head_sha,revision_ref)
    VALUES (?,?,'2026-10-23','claude','open','posted',?,?)`).run(repo, prNumber, reviewed, published);
  const comments = [];
  await publishPushedHammerAttestation({ repo, prNumber, baseHead: bridge ? reviewed : intermediate,
    pushedHead: published, api: async (path, input) => {
      if (path === 'graphql') return { data: { viewer: { login: 'hammer-worker' } } };
      if (!input) return comments;
      const comment = { id: 1, author: 'hammer-worker', body: input.body };
      comments.push(comment);
      return comment;
    } });
  let status = 'succeeded', requests = 0, dispatches = 0;
  updateAmaCloserDispatchRecord(rootDir, { repo, prNumber, headSha: intermediate }, () => ({
    repo, prNumber, headSha: intermediate, state: 'dispatched', launchRequestId: 'synthetic-launch',
  }));
  const candidate = { headSha: published, prState: 'open', isDraft: false, riskClass: 'low',
    prAuthor: 'synthetic-builder', baseBranch: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
  const row = () => ({ ...db.prepare('SELECT * FROM reviewed_prs').get(), review_body: body });
  const args = { rootDir, repoPath: repo, prNumber, currentRevisionRef: published, candidate,
    labelNames: [], logger: quiet };
  const tick = (extra = {}) => resolveMergeAgentCoexistenceForWatcher({ ...args, reviewStateRow: row(),
    maybeDispatchAmaClosureForImpl: options => maybeDispatchAmaClosureFor({ ...options,
      loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true,
        branchProtection: { required: false } }), getOrchestrationMode: () => 'native' }),
      proveCloserAuthoredStaleHeadImpl: options => proveCloserAuthoredStaleHead({ ...options, comments }),
      resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed: true, reason: 'closer-commit-trailer' }),
      resolveHamTerminalRemediationEvidenceImpl: async () => ({ validated: false }),
      fetchLatestHeadReviewBodiesImpl: async (_repo, _pr, head) => head === reviewed ? [body] : [],
      liveReviewRetryDelaysMs: [],
      // The daemon's CI/read wait and the consumed background refusal must not
      // swallow the already-computed exact-head review decision.
      runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'not-taken', reason: 'not-eligible',
        ciMergePathPending: true, reasons: ['ci-not-green'] }),
      maybeDispatchAmaCloserImpl: async () => {
        dispatches++;
        return { dispatched: false, reason: 'not-eligible',
          reasons: ['stale-review-head', 'verdict-not-settled-success', 'blocking-findings-unknown'] };
      },
      observeClosureWaitImpl: async () => ({ exhausted: false, reason: 'required-checks-pending', retryAfterMs: 30000 }),
    }),
    orphanOptions: {
      hasOwnerImpl: options => probeOrphanOwnership({ ...options,
        readStatusImpl: async () => ({ ok: true, row: { status } }) }),
      requestRereviewImpl: options => { requests++; return requestReviewRereview({ ...options, db }); },
      pageImpl: () => assert.fail('fixture must not page'),
    },
    ...extra,
  });
  return { rootDir, comments, row, tick, setStatus: value => { status = value; },
    counts: () => ({ requests, dispatches }) };
}

test('HAMATTEST-03 settles: a recorded pushed edge without a reviewed-head bridge queues review next poll', async t => {
  const f = await fixture(t);
  assert.match(f.comments[0].body, /HAM-CI-Validated: false/);
  const result = await f.tick();
  assert.equal(result.amaClosureResult.closerAuthoredStale.decision, 'rereview-exact-head');
  assert.deepEqual(result.amaClosureResult.closerAuthoredStale.reasons, ['hammer-app-attestation-missing']);
  assert.equal(f.row().review_status, 'pending');
  assert.equal(isOrphanHeadReviewRequested(f.row(), published), true);
  assert.equal(result.amaClosureResult.closureOwner.owner, 'review');
});

test('HAMATTEST-03 no early re-review: running launch suppresses review until its terminal poll', async t => {
  const f = await fixture(t);
  f.setStatus('running');
  await f.tick();
  assert.equal(f.counts().requests, 0);
  assert.equal(f.row().review_status, 'posted');
  f.setStatus('succeeded');
  await f.tick();
  assert.equal(f.counts().requests, 1);
});

test('HAMATTEST-03 executed once: repeated terminal observations preserve one durable request for the head', async t => {
  const f = await fixture(t);
  await f.tick();
  const requestedAt = f.row().rereview_requested_at;
  await f.tick();
  await f.tick();
  assert.equal(f.counts().requests, 1);
  assert.ok(requestedAt);
  assert.equal(f.row().rereview_requested_at, requestedAt);
});

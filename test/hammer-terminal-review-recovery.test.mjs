import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maybeDispatchAmaClosureFor, resolveMergeAgentCoexistenceForWatcher } from '../src/ama-closure-orchestration.mjs';
import { publishPushedHammerAttestation } from '../src/ama/hammer-pushed-attestation.mjs';
import { proveCloserAuthoredStaleHead } from '../src/closer-authored-stale.mjs';
import { hasExactHeadReviewDecision, probeOrphanOwnership } from '../src/ama/orphan-watchdog.mjs';
import { updateAmaCloserDispatchRecord } from '../src/ama/dispatch-closer.mjs';
import { openReviewStateDb, ensureReviewStateSchema, requestReviewRereview } from '../src/review-state.mjs';
import { isOrphanHeadReviewRequested } from '../src/orphan-head-review-requested.mjs';
import { amaHammerBackgroundKey, createAmaHammerBackgroundQueue } from '../src/ama-hammer-background-dispatch.mjs';

const reviewed = 'a'.repeat(40), published = 'b'.repeat(40), intermediate = 'c'.repeat(40);
const repo = 'fixture/project', prNumber = 7;
const body = '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nComment only';
const quiet = { log() {}, info() {}, warn() {} };

async function fixture(t, { bridge = false, background = false } = {}) {
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
  const refusal = { dispatched: false, reason: 'not-eligible',
    reasons: ['stale-review-head', 'verdict-not-settled-success', 'blocking-findings-unknown'] };
  const queue = createAmaHammerBackgroundQueue({ logger: quiet });
  if (background) {
    queue.submit({ key: amaHammerBackgroundKey({ repo, prNumber, headSha: published }),
      run: async () => refusal });
    await queue.drain();
  }
  t.after(() => queue.drain());
  updateAmaCloserDispatchRecord(rootDir, { repo, prNumber, headSha: intermediate }, () => ({
    repo, prNumber, headSha: intermediate, state: 'dispatched', launchRequestId: 'synthetic-launch',
  }));
  const candidate = { headSha: published, prState: 'open', isDraft: false, riskClass: 'low',
    prAuthor: 'synthetic-builder', baseBranch: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
  const row = () => ({ ...db.prepare('SELECT * FROM reviewed_prs').get(), review_body: body });
  const args = { rootDir, repoPath: repo, prNumber, currentRevisionRef: published, candidate,
    labelNames: [], logger: quiet };
  const tick = (extra = {}, closureOverrides = {}) => resolveMergeAgentCoexistenceForWatcher({ ...args, reviewStateRow: row(),
    maybeDispatchAmaClosureForImpl: options => maybeDispatchAmaClosureFor({ ...options,
      loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true,
        branchProtection: { required: false } }), getOrchestrationMode: () => 'native' }),
      resolveAmaHammerDispatchModeImpl: () => background ? 'background' : 'inline',
      amaHammerBackgroundQueueImpl: () => queue,
      fetchCurrentPrStateImpl: async () => ({ state: 'OPEN', headSha: published, mergeable: 'MERGEABLE' }),
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
        return refusal;
      },
      observeClosureWaitImpl: async () => ({ exhausted: false, reason: 'required-checks-pending', retryAfterMs: 30000 }),
      ...closureOverrides,
    }),
    orphanOptions: {
      hasOwnerImpl: options => probeOrphanOwnership({ ...options,
        readStatusImpl: async () => ({ ok: true, row: { status } }) }),
      requestRereviewImpl: options => { requests++; return requestReviewRereview({ ...options, db }); },
      pageImpl: () => assert.fail('fixture must not page'),
    },
    ...extra,
  });
  return { rootDir, comments, row, tick, args, setStatus: value => { status = value; },
    counts: () => ({ requests, dispatches }) };
}

test('HAMATTEST-03 settles: a recorded pushed edge without a reviewed-head bridge retains Hammer ownership', async t => {
  const f = await fixture(t);
  assert.match(f.comments[0].body, /HAM-CI-Validated: false/);
  const result = await f.tick();
  assert.equal(result.amaClosureResult.closerAuthoredStale.decision, 'hammer-resume');
  assert.deepEqual(result.amaClosureResult.closerAuthoredStale.reasons, ['hammer-owned-head']);
  assert.equal(f.row().review_status, 'posted');
  assert.equal(isOrphanHeadReviewRequested(f.row(), published), false);
  assert.equal(result.amaClosureResult.closureOwner.owner, 'hammer');
  assert.equal(result.amaClosureResult.reason, 'not-eligible');
  assert.equal(result.amaClosureResult.nextAction.action, 'hammer');
  assert.equal(f.counts().dispatches, 1);
});

test('failed Hammer ownership lookup grants no ownership or verdict certification', async t => {
  const f = await fixture(t);
  const result = await f.tick({}, {
    resolveHeadCloserCommitSuppressionImpl: async () => { throw new Error('fixture ownership lookup unavailable'); },
  });
  assert.equal(result.amaClosureResult.closerAuthoredStale.carryForward, false);
  assert.equal(result.amaClosureResult.nextAction.action, 'review');
  assert.equal(f.counts().dispatches, 0);
  assert.equal(f.counts().requests, 1);
});

test('HAMATTEST-03 no early re-review: running and terminal launches both preserve Hammer recovery ownership', async t => {
  const f = await fixture(t);
  f.setStatus('running');
  const waiting = await f.tick();
  assert.equal(waiting.amaClosureResult.closureOwner.owner, 'hammer');
  assert.equal(waiting.amaClosureResult.closureOwner.reason, 'live-owner');
  assert.equal(f.counts().requests, 0);
  assert.equal(f.row().review_status, 'posted');
  f.setStatus('succeeded');
  await f.tick();
  assert.equal(f.counts().requests, 0);
});

test('HAMATTEST-03 repeated terminal observations never enqueue review for the owned head', async t => {
  const f = await fixture(t);
  await f.tick();
  await f.tick();
  await f.tick();
  assert.equal(f.counts().requests, 0);
  assert.equal(isOrphanHeadReviewRequested(f.row(), published), false);
  assert.equal(f.row().review_status, 'posted');
});

test('HAMATTEST-03 consumes a real background refusal without transferring ownership to review', async t => {
  const f = await fixture(t, { background: true });
  const result = await f.tick();
  assert.equal(f.counts().requests, 0);
  assert.equal(f.counts().dispatches, 0, 'apply the settled outcome without another dispatch');
  assert.equal(result.amaClosureResult.reason, 'not-eligible');
});

for (const stop of ['uncertain', 'held', 'foreign-head', 'operator']) {
  test(`HAMATTEST-03 does not take review ownership under ${stop} evidence`, async t => {
    const f = await fixture(t);
    const result = { amaEnabled: true, dispatched: false, reason: 'not-eligible',
      boundedWait: { exhausted: false, reason: 'required-checks-pending' },
      closerAuthoredStale: { decision: 'rereview-exact-head', reviewedHead: reviewed,
        currentHead: stop === 'foreign-head' ? intermediate : published },
      ...(stop === 'operator' ? { needsOperator: true, operatorReason: 'primary-change-needs-operator' } : {}) };
    await f.tick({ maybeDispatchAmaClosureForImpl: async () => result,
      labelNames: stop === 'held' ? ['no-merge'] : [],
      orphanOptions: { hasOwnerImpl: async () => ({ owned: false, uncertain: stop === 'uncertain' }),
        requestRereviewImpl: () => assert.fail('refused evidence cannot queue review'),
        pageImpl: () => assert.fail('fixture must not page') } });
    assert.equal(f.counts().requests, 0);
    assert.equal(f.row().review_status, 'posted');
  });
}

test('HAMATTEST-03 a complete authenticated bridge preserves the reviewed verdict and live-head checks', async t => {
  const f = await fixture(t, { bridge: true });
  let merges = 0;
  const result = await f.tick({}, { runDaemonCleanMergeAttemptImpl: async options => {
    merges++;
    assert.equal(options.reviewState.verdict, 'comment-only');
    assert.equal(options.currentPrHeadSha, published);
    assert.equal(options.candidate.statusCheckRollup[0].conclusion, 'SUCCESS');
    return { disposition: 'merged', reason: 'fixture-merged', merged: true, remoteMergedConfirmed: true };
  } });
  assert.equal(result.terminalReason, 'merged');
  assert.equal(result.amaClosureResult.closerAuthoredStale.carryForward, true);
  assert.equal(f.counts().requests, 0);
  assert.equal(merges, 1);
});

for (const exhausted of [false, true]) test(`HAMATTEST-03 a recorded bridge with unsettled evidence retains the shared Hammer owner, exhausted=${exhausted}`, async t => {
  const f = await fixture(t, { bridge: true });
  const result = await f.tick({}, { fetchLatestHeadReviewBodiesImpl: async () => [],
    resolveReviewCycleExhaustionImpl: () => ({ reviewCycleExhausted: exhausted,
      commentOnlyFinalRoundRevisionRefs: exhausted ? [reviewed] : [] }) });
  assert.equal(result.amaClosureResult.closerAuthoredStale.carryForward, false);
  assert.ok(result.amaClosureResult.closerAuthoredStale.reasons.includes('verdict-not-settled-success'));
  assert.equal(f.counts().requests, 0);
});

test('exact-head review admission requires the shared dispatch decision', () => {
  const nextAction = { head: published, action: 'review', actor: 'reviewer', queue: { intent: 'dispatch' } };
  const result = { nextAction };
  assert.equal(hasExactHeadReviewDecision(result, published), true);
  assert.equal(hasExactHeadReviewDecision(result, intermediate), false);
  assert.equal(hasExactHeadReviewDecision(result, ''), false);
  for (const patch of [{ head: reviewed }, { action: 'hammer' }, { actor: 'closure-recovery' },
    { queue: { intent: 'observe' } }, { queue: { intent: 'dispatch', deferredBy: 'drain' } }]) {
    assert.equal(hasExactHeadReviewDecision({ nextAction: { ...nextAction, ...patch } }, published), false);
  }
  for (const diagnostic of [{ closerAuthoredStale: { currentHead: published, reviewedHead: reviewed,
    decision: 'rereview-exact-head' } }, { selectedClosureOwner: { owner: 'review' } },
  { closureOwner: { owner: 'review', reason: 'exact-head-review' } }]) {
    assert.equal(hasExactHeadReviewDecision(diagnostic, published), false);
  }
});

for (const bridge of [false, true]) {
  for (const ownership of ['live', 'uncertain', 'absent']) {
    for (const exhausted of [false, true]) {
      test(`bounded owner remains truthful: bridge=${bridge}, ownership=${ownership}, exhausted=${exhausted}`, async t => {
        const f = await fixture(t, { bridge });
        const result = await f.tick({ orphanOptions: {
          hasOwnerImpl: async () => ({ owned: ownership === 'live', uncertain: ownership === 'uncertain' }),
          requestRereviewImpl: async () => assert.fail('Hammer ownership cannot enqueue review'),
          pageImpl: () => assert.fail('fixture must not page'),
        } }, {
          fetchLatestHeadReviewBodiesImpl: async () => [],
          observeClosureWaitImpl: async () => ({ exhausted, reason: 'required-checks-pending',
            boundedMs: 60000, retryAfterMs: 30000 }),
        });
        const selected = result.amaClosureResult.nextAction;
        assert.equal(selected.action, 'hammer');
        assert.equal(selected.actor, ownership === 'absent' ? 'hammer' : 'closure-recovery');
        assert.equal(result.amaClosureResult.closureOwner.actor, selected.actor);
        assert.notEqual(selected.action, 'operator-hold', 'overdue reporting cannot erase recovery ownership');
        assert.equal(f.row().review_status, 'posted');
      });
    }
  }
}

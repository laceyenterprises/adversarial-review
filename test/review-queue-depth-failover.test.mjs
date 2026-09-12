// RSP-01 — CFG-gated queue-depth trigger that spills first-pass review across
// worker classes.
//
// The mandated properties, one test each (see the ticket):
//   1. Below threshold: reviewer selection is byte-identical to today.
//   2. At/above threshold: spillover engages, passes run across classes.
//   3. Writer diversity holds under spillover, even when violating it is the
//      only way to satisfy the depth.
//   4. A quota-unavailable or unentitled fallback class is not selected.
//   5. Quota-triggered fallback still fires at low depth (triggers compose).
//   6. The engage/disengage transition is recorded with the causing depth.
// Plus the graded/minimum-spill and cost-reporting contracts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  FIRST_PASS_REVIEW_QUEUE_DEPTH_UNIT,
  REVIEW_QUEUE_DEPTH_FAILOVER_CFG_KEY,
  createFirstPassSpilloverController,
  firstPassSpilloverPlan,
  readFirstPassReviewQueueDepth,
  readReviewQueueDepthFailoverReport,
  resolveFirstPassReviewQueueDepthFailoverThreshold,
  reviewQueueDepthFailoverReportPath,
} from '../src/review-queue-depth.mjs';
import {
  applyReviewerWorkerClassFallbackToRoute,
  resolveReviewerWorkerClassWithFallback,
  reviewerWorkerClassEntitled,
  violatesWriterDiversity,
} from '../src/review-worker-class-fallback.mjs';
import { ENV_ALIASES } from '../src/config-loader.mjs';
import { resetRoleConfigCache } from '../src/role-config.mjs';

test.afterEach(() => {
  resetRoleConfigCache();
});

// ── fixtures ─────────────────────────────────────────────────────────────────

const CODEX_OK_CLAUDE_OK = [
  { provider: 'openai', authPath: 'oauth', state: 'ok' },
  { provider: 'anthropic', authPath: 'oauth', state: 'ok' },
];
const CODEX_EXHAUSTED_CLAUDE_OK = [
  { provider: 'openai', authPath: 'oauth', state: 'exhausted' },
  { provider: 'anthropic', authPath: 'oauth', state: 'ok' },
];
const CODEX_OK_CLAUDE_EXHAUSTED = [
  { provider: 'openai', authPath: 'oauth', state: 'ok' },
  { provider: 'anthropic', authPath: 'oauth', state: 'exhausted' },
];

// Every fallback class entitled: each reviewer worker class can only post if its
// GitHub reviewer bot token is present.
const ENTITLED_ENV = Object.freeze({
  GH_CLAUDE_REVIEWER_TOKEN: 'ghs_claude',
  GH_CODEX_REVIEWER_TOKEN: 'ghs_codex',
  GH_GEMINI_REVIEWER_TOKEN: 'ghs_gemini',
});

function fleetStatusStub(rows) {
  const stdout = JSON.stringify({ providerStatuses: rows });
  return async () => ({ stdout });
}

function tempRoot(prefix = 'rsp01-') {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function controller({ root, depth, threshold, now = () => new Date('2026-09-06T18:00:00.000Z') }) {
  return createFirstPassSpilloverController({
    rootDir: root,
    readDepth: () => depth,
    resolveThresholdImpl: () => threshold,
    logger: { warn() {}, error() {} },
    now,
  });
}

// ── 1. Below threshold: byte-identical to pre-RSP-01 ─────────────────────────

test('below threshold: reviewer selection is byte-identical to pre-RSP-01', async () => {
  const args = {
    authorClass: 'gemini',
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: fleetStatusStub(CODEX_OK_CLAUDE_OK),
    env: ENTITLED_ENV,
  };
  const root = tempRoot();
  try {
    // depth 5 against threshold 10 -> disengaged.
    const pressure = controller({ root, depth: 5, threshold: 10 }).depthPressure();
    assert.equal(pressure.engaged, false);

    const withLever = await resolveReviewerWorkerClassWithFallback({ ...args, depthPressure: pressure });
    const withoutLever = await resolveReviewerWorkerClassWithFallback(args);
    assert.deepEqual(withLever, withoutLever);
    assert.deepEqual(withLever, {
      workerClass: 'codex',
      fellBack: false,
      reason: 'primary-available',
      primaryState: 'ok',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('disarmed (threshold unset) is byte-identical to pre-RSP-01 even at huge depth', async () => {
  const args = {
    authorClass: 'claude-code',
    primary: 'gemini',
    fallbackWorkerClasses: ['codex'],
    execFileImpl: fleetStatusStub(CODEX_OK_CLAUDE_OK),
    env: ENTITLED_ENV,
  };
  const root = tempRoot();
  try {
    const pressure = controller({ root, depth: 9999, threshold: null }).depthPressure();
    assert.equal(pressure.engaged, false);
    const withLever = await resolveReviewerWorkerClassWithFallback({ ...args, depthPressure: pressure });
    const withoutLever = await resolveReviewerWorkerClassWithFallback(args);
    assert.deepEqual(withLever, withoutLever);
    // With the queue-depth lever disarmed, the resolver must preserve the
    // primary route and its ordinary no-fallback reason even under huge depth.
    assert.equal(withLever.reason, 'primary-not-grounded');
    assert.equal(withLever.fellBack, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 2. At/above threshold: spillover engages across classes ──────────────────

test('at threshold: a healthy gemini primary spills first-pass review to codex', async () => {
  const root = tempRoot();
  try {
    const ctl = controller({ root, depth: 10, threshold: 10 });
    const result = await resolveReviewerWorkerClassWithFallback({
      authorClass: 'claude-code',
      primary: 'gemini',
      fallbackWorkerClasses: ['codex'],
      depthPressure: ctl.depthPressure(),
      execFileImpl: fleetStatusStub(CODEX_OK_CLAUDE_OK),
      env: ENTITLED_ENV,
    });
    assert.equal(result.fellBack, true);
    assert.equal(result.workerClass, 'codex');
    assert.equal(result.reason, 'queue-depth-pressure');
    assert.equal(result.from, 'gemini');
    assert.equal(result.to, 'codex');
    assert.equal(result.queueDepth, 10);
    assert.equal(result.queueDepthThreshold, 10);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('spillover produces a usable route and passes run across multiple classes', async () => {
  const root = tempRoot();
  try {
    const ctl = controller({ root, depth: 20, threshold: 10 });
    // depth 20 / threshold 10 => 2 concurrent non-primary reviewers this tick.
    assert.equal(ctl.plan().spillSlots, 2);

    const routeByModel = {
      claude: { reviewerModel: 'claude', botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN' },
      codex: { reviewerModel: 'codex', botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN' },
    };
    const spilled = [];
    for (const authorClass of ['claude-code', 'codex', 'claude-code']) {
      const decision = await resolveReviewerWorkerClassWithFallback({
        authorClass,
        primary: 'gemini',
        fallbackWorkerClasses: ['codex', 'claude-code'],
        depthPressure: ctl.depthPressure(),
        execFileImpl: fleetStatusStub(CODEX_OK_CLAUDE_OK),
        env: ENTITLED_ENV,
      });
      if (!decision.fellBack) continue;
      const applied = applyReviewerWorkerClassFallbackToRoute({
        route: { reviewerModel: 'gemini', builderClass: authorClass },
        decision,
        reviewerRouteByModel: routeByModel,
        authorClass,
      });
      assert.equal(applied.applied, true);
      if (ctl.recordSpill({ fromWorkerClass: decision.from, toWorkerClass: decision.to })) {
        spilled.push(applied.route.reviewerWorkerClass);
      }
    }
    // Two slots, spent across TWO different classes — parallel across providers,
    // and the third PR is refused because the graded budget is exhausted.
    assert.deepEqual(spilled, ['codex', 'claude-code']);
    assert.equal(ctl.granted(), 2);
    assert.equal(ctl.depthPressure().engaged, false, 'budget spent => further PRs stay on the primary');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('graded response: spill slots scale one per full multiple of the threshold', () => {
  assert.equal(firstPassSpilloverPlan({ depth: 9, threshold: 10 }).engaged, false);
  assert.equal(firstPassSpilloverPlan({ depth: 9, threshold: 10 }).spillSlots, 0);
  assert.equal(firstPassSpilloverPlan({ depth: 10, threshold: 10 }).spillSlots, 1);
  assert.equal(firstPassSpilloverPlan({ depth: 19, threshold: 10 }).spillSlots, 1);
  assert.equal(firstPassSpilloverPlan({ depth: 20, threshold: 10 }).spillSlots, 2);
  assert.equal(firstPassSpilloverPlan({ depth: 35, threshold: 10 }).spillSlots, 3);
});

// ── 3. Writer diversity under spillover ──────────────────────────────────────

test('writer diversity holds under spillover even when it is the only way to satisfy the depth', async () => {
  const root = tempRoot();
  try {
    const ctl = controller({ root, depth: 500, threshold: 10 });
    const result = await resolveReviewerWorkerClassWithFallback({
      authorClass: 'claude-code',
      primary: 'gemini',
      // The ONLY configured fallback is the author's own class.
      fallbackWorkerClasses: ['claude-code'],
      depthPressure: ctl.depthPressure(),
      execFileImpl: fleetStatusStub(CODEX_OK_CLAUDE_OK),
      env: ENTITLED_ENV,
    });
    assert.equal(result.fellBack, false, 'a claude-code PR must never draw a claude-code reviewer');
    assert.equal(result.workerClass, 'gemini');
    assert.equal(result.reason, 'no-available-fallback');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writer diversity is writer-FAMILY aware, not a worker-class string compare', async () => {
  // clio-agent dispatches codex workers, so codex reviewing a clio-agent PR is
  // codex reviewing codex — string-unequal, diversity-dead.
  assert.equal(violatesWriterDiversity('clio-agent', 'codex'), true);
  assert.equal(violatesWriterDiversity('clio-agent', 'claude-code'), false);
  assert.equal(violatesWriterDiversity('claude-code', 'claude-code'), true);
  assert.equal(violatesWriterDiversity('gemini', 'codex'), false);

  const root = tempRoot();
  try {
    const ctl = controller({ root, depth: 500, threshold: 10 });
    const result = await resolveReviewerWorkerClassWithFallback({
      authorClass: 'clio-agent',
      primary: 'gemini',
      fallbackWorkerClasses: ['codex'],
      depthPressure: ctl.depthPressure(),
      execFileImpl: fleetStatusStub(CODEX_OK_CLAUDE_OK),
      env: ENTITLED_ENV,
    });
    assert.equal(result.fellBack, false);
    assert.equal(result.reason, 'no-available-fallback');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the route-application backstop refuses a same-writer swap it is handed directly', () => {
  const applied = applyReviewerWorkerClassFallbackToRoute({
    route: { reviewerModel: 'gemini' },
    decision: { fellBack: true, workerClass: 'codex', from: 'gemini', to: 'codex' },
    reviewerRouteByModel: { codex: { reviewerModel: 'codex', botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN' } },
    authorClass: 'clio-agent',
  });
  assert.equal(applied.applied, false);
  assert.equal(applied.reason, 'writer-diversity-violation');
});

// ── 4. Unentitled / quota-unavailable fallbacks are not selected ─────────────

test('a quota-unavailable fallback class is not selected under depth pressure', async () => {
  const root = tempRoot();
  try {
    const ctl = controller({ root, depth: 100, threshold: 10 });
    const result = await resolveReviewerWorkerClassWithFallback({
      authorClass: 'claude-code',
      primary: 'gemini',
      fallbackWorkerClasses: ['codex'],
      depthPressure: ctl.depthPressure(),
      // codex (openai) exhausted: spilling onto it turns a slow queue into a
      // stalled one.
      execFileImpl: fleetStatusStub(CODEX_EXHAUSTED_CLAUDE_OK),
      env: ENTITLED_ENV,
    });
    assert.equal(result.fellBack, false);
    assert.equal(result.workerClass, 'gemini');
    assert.equal(result.reason, 'no-available-fallback');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unentitled fallback class is not selected under depth pressure', async () => {
  assert.equal(reviewerWorkerClassEntitled('codex', ENTITLED_ENV), true);
  assert.equal(reviewerWorkerClassEntitled('codex', {}), false);

  const root = tempRoot();
  try {
    const ctl = controller({ root, depth: 100, threshold: 10 });
    const result = await resolveReviewerWorkerClassWithFallback({
      authorClass: 'claude-code',
      primary: 'gemini',
      fallbackWorkerClasses: ['codex'],
      depthPressure: ctl.depthPressure(),
      execFileImpl: fleetStatusStub(CODEX_OK_CLAUDE_OK),
      // codex has quota but NO reviewer bot token: it cannot post a review.
      env: { GH_CLAUDE_REVIEWER_TOKEN: 'ghs_claude' },
    });
    assert.equal(result.fellBack, false);
    assert.equal(result.reason, 'no-available-fallback');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unentitled class is skipped in favour of the next entitled, available one', async () => {
  const root = tempRoot();
  try {
    const ctl = controller({ root, depth: 100, threshold: 10 });
    const result = await resolveReviewerWorkerClassWithFallback({
      authorClass: 'gemini',
      primary: 'gemini',
      fallbackWorkerClasses: ['codex', 'claude-code'],
      depthPressure: ctl.depthPressure(),
      execFileImpl: fleetStatusStub(CODEX_OK_CLAUDE_OK),
      env: { GH_CLAUDE_REVIEWER_TOKEN: 'ghs_claude' },
    });
    assert.equal(result.fellBack, true);
    assert.equal(result.workerClass, 'claude-code');
    assert.equal(result.reason, 'queue-depth-pressure');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 5. The two triggers compose ──────────────────────────────────────────────

test('quota-triggered fallback still fires at low depth (the triggers compose)', async () => {
  const root = tempRoot();
  try {
    const ctl = controller({ root, depth: 0, threshold: 10 });
    assert.equal(ctl.depthPressure().engaged, false);
    const result = await resolveReviewerWorkerClassWithFallback({
      authorClass: 'gemini',
      primary: 'codex',
      fallbackWorkerClasses: ['claude-code'],
      depthPressure: ctl.depthPressure(),
      execFileImpl: fleetStatusStub(CODEX_EXHAUSTED_CLAUDE_OK),
      env: ENTITLED_ENV,
    });
    assert.equal(result.fellBack, true);
    assert.equal(result.workerClass, 'claude-code');
    assert.equal(result.reason, 'primary-grounded-fallback');
    assert.equal(result.primaryState, 'exhausted');
    // A quota fallback is unconditional and must NOT charge the depth budget.
    assert.equal(ctl.granted(), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a quota-grounded primary at HIGH depth still takes the quota path', async () => {
  const root = tempRoot();
  try {
    const ctl = controller({ root, depth: 100, threshold: 10 });
    const result = await resolveReviewerWorkerClassWithFallback({
      authorClass: 'gemini',
      primary: 'claude-code',
      fallbackWorkerClasses: ['codex'],
      depthPressure: ctl.depthPressure(),
      execFileImpl: fleetStatusStub(CODEX_OK_CLAUDE_EXHAUSTED),
      env: ENTITLED_ENV,
    });
    assert.equal(result.fellBack, true);
    assert.equal(result.reason, 'primary-grounded-fallback');
    assert.equal(ctl.granted(), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 6. Engage / disengage is recorded with the causing depth ─────────────────

test('the engage and disengage transitions are recorded with the depth that caused them', () => {
  const root = tempRoot();
  try {
    // Engage at depth 14, threshold 10.
    const engaged = controller({
      root, depth: 14, threshold: 10, now: () => new Date('2026-09-06T18:00:00.000Z'),
    });
    engaged.plan();
    engaged.recordSpill({ fromWorkerClass: 'gemini', toWorkerClass: 'codex' });

    let report = JSON.parse(readFileSync(reviewQueueDepthFailoverReportPath(root), 'utf8'));
    assert.equal(report.engaged, true);
    assert.equal(report.depth, 14);
    assert.equal(report.threshold, 10);
    assert.equal(report.lastTransition.event, 'engage');
    assert.equal(report.lastTransition.depth, 14, 'the transition names the depth that caused it');
    assert.equal(report.lastTransition.at, '2026-09-06T18:00:00.000Z');
    assert.equal(report.cost.spilloverReviewsTotal, 1);
    assert.deepEqual(report.cost.byWorkerClass, { codex: 1 });
    assert.equal(report.knob, REVIEW_QUEUE_DEPTH_FAILOVER_CFG_KEY);
    assert.equal(report.depthUnit, FIRST_PASS_REVIEW_QUEUE_DEPTH_UNIT);

    // Depth recovers below threshold on a later tick: the lever DISENGAGES —
    // it is a lever, not a ratchet — and reports what the engagement cost.
    const recovered = controller({
      root, depth: 3, threshold: 10, now: () => new Date('2026-09-06T18:30:00.000Z'),
    });
    assert.equal(recovered.plan().engaged, false);
    assert.equal(recovered.depthPressure().engaged, false);

    report = JSON.parse(readFileSync(reviewQueueDepthFailoverReportPath(root), 'utf8'));
    assert.equal(report.engaged, false);
    assert.equal(report.lastTransition.event, 'disengage');
    assert.equal(report.lastTransition.depth, 3);
    assert.equal(report.lastTransition.engagementSpilloverReviews, 1, 'the cost of the engagement that ended');
    assert.equal(report.cost.lastEngagementSpilloverReviews, 1);
    assert.equal(report.cost.spilloverReviewsTotal, 1, 'lifetime cost survives disengage');
    assert.deepEqual(report.transitions.map((t) => t.event), ['engage', 'disengage']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the transition log is emitted with the depth and the cost', () => {
  const root = tempRoot();
  const warnings = [];
  try {
    createFirstPassSpilloverController({
      rootDir: root,
      readDepth: () => 25,
      resolveThresholdImpl: () => 10,
      logger: { warn: (m) => warnings.push(String(m)) },
      now: () => new Date('2026-09-06T18:00:00.000Z'),
    }).plan();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /review-queue-depth-failover engage/);
    assert.match(warnings[0], /depth=25/);
    assert.match(warnings[0], /threshold=10/);
    assert.match(warnings[0], /spill_slots=2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('no report is written and no depth is read while the lever is disarmed', () => {
  const root = tempRoot();
  let depthReads = 0;
  try {
    const ctl = createFirstPassSpilloverController({
      rootDir: root,
      readDepth: () => { depthReads += 1; return 500; },
      resolveThresholdImpl: () => null,
      logger: { warn() {} },
    });
    assert.equal(ctl.plan().armed, false);
    assert.equal(ctl.depthPressure().engaged, false);
    assert.equal(depthReads, 0, 'a disarmed lever must not pay for a queue-depth count');
    assert.throws(() => readFileSync(reviewQueueDepthFailoverReportPath(root), 'utf8'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── fail-open + CFG plumbing ─────────────────────────────────────────────────

test('an unreadable depth leaves the lever disengaged rather than guessing', () => {
  const warnings = [];
  assert.equal(
    readFirstPassReviewQueueDepth(() => { throw new Error('db locked'); }, { logger: { warn: (m) => warnings.push(String(m)) } }),
    null
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /review-queue-depth read failed/);
  assert.equal(firstPassSpilloverPlan({ depth: null, threshold: 10 }).engaged, false);
  assert.equal(readFirstPassReviewQueueDepth(null), null);
});

test('an unreadable threshold stays disarmed rather than engaging', () => {
  const root = tempRoot();
  try {
    const ctl = createFirstPassSpilloverController({
      rootDir: root,
      readDepth: () => 500,
      resolveThresholdImpl: () => { throw new Error('config broken'); },
      logger: { warn() {} },
    });
    assert.equal(ctl.plan().armed, false);
    assert.equal(ctl.depthPressure().engaged, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the CFG knob defaults to disarmed and is registered in ENV_ALIASES', () => {
  assert.equal(
    resolveFirstPassReviewQueueDepthFailoverThreshold({ env: {}, topPath: '/dev/null' }),
    null,
    'a host that takes this change behaves exactly as it does today'
  );
  const alias = ENV_ALIASES[REVIEW_QUEUE_DEPTH_FAILOVER_CFG_KEY];
  assert.ok(alias, `missing ENV_ALIASES entry: ${REVIEW_QUEUE_DEPTH_FAILOVER_CFG_KEY}`);
  assert.equal(alias.canonical, 'AGENT_OS_WATCHER_FIRST_PASS_REVIEW_QUEUE_DEPTH_FAILOVER_THRESHOLD');
});

test('the knob arms from the canonical env alone (no shared config.yaml edit needed)', () => {
  assert.equal(
    resolveFirstPassReviewQueueDepthFailoverThreshold({
      env: { AGENT_OS_WATCHER_FIRST_PASS_REVIEW_QUEUE_DEPTH_FAILOVER_THRESHOLD: '12' },
      topPath: '/dev/null',
    }),
    12
  );
});

test('an empty report reads back as a well-formed disarmed report', () => {
  const root = tempRoot();
  try {
    const report = readReviewQueueDepthFailoverReport(root);
    assert.equal(report.engaged, false);
    assert.equal(report.cost.spilloverReviewsTotal, 0);
    assert.deepEqual(report.transitions, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the unit is the PRODUCTION counter, not a hand-rolled second definition ───
//
// Every test above injects a stub depth. This one wires the controller to the
// SAME function watcher.mjs injects (`countOpenPrsAwaitingFirstPassReview`) over
// a real review-state schema, so the number the lever thresholds on is provably
// the number the review-stall pager already reports — not a lookalike that can
// drift from it.

test('the lever thresholds on the production countOpenPrsAwaitingFirstPassReview', async () => {
  const { ensureReviewStateSchema, openReviewStateDb } = await import('../src/review-state.mjs');
  const { countOpenPrsAwaitingFirstPassReview } = await import('../src/review-state-db.mjs');

  const dbRoot = tempRoot('rsp01-db-');
  const reportRoot = tempRoot('rsp01-report-');
  const db = openReviewStateDb(dbRoot);
  let prSeq = 9000;
  const seed = (prState, reviewStatus, { revisionRef = null } = {}) => {
    const prNumber = prSeq++;
    db.prepare(
      'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, revision_ref)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'laceyenterprises/agent-os',
      prNumber,
      '2026-09-06T00:00:00.000Z',
      'gemini',
      prState,
      reviewStatus,
      revisionRef
    );
    return prNumber;
  };
  try {
    ensureReviewStateSchema(db);
    const ctl = () => createFirstPassSpilloverController({
      rootDir: reportRoot,
      readDepth: () => countOpenPrsAwaitingFirstPassReview(db),
      resolveThresholdImpl: () => 3,
      logger: { warn() {} },
    });

    // Two waiting + one in flight = depth 3 under the documented unit (in-flight
    // first passes COUNT: the PR still has no review).
    seed('open', 'pending');
    seed('open', 'pending');
    seed('open', 'reviewing');
    // Noise that must NOT inflate the depth.
    seed('merged', 'pending');
    seed('closed', 'pending');
    seed('open', 'malformed');
    seed('open', 'argus-security-queued');

    assert.equal(countOpenPrsAwaitingFirstPassReview(db), 3);
    const engagedPlan = ctl().plan();
    assert.equal(engagedPlan.depth, 3);
    assert.equal(engagedPlan.engaged, true);
    assert.equal(engagedPlan.spillSlots, 1);

    // A genuinely delivered review for the CURRENT head drops the depth under
    // threshold and disengages the lever.
    const delivered = seed('open', 'pending', { revisionRef: 'head-current' });
    const invalidated = seed('open', 'pending', { revisionRef: 'head-new' });
    db.prepare(
      'INSERT INTO reviewer_passes (repo, pr_number, attempt_number, reviewer_class, reviewer_model,'
      + ' pass_kind, started_at, ended_at, status, body_md, gh_comment_id, head_sha)'
      + " VALUES (?, ?, 1, 'gemini', 'gemini', 'first-pass', ?, ?, 'completed', 'body', ?, ?)"
    ).run(
      'laceyenterprises/agent-os',
      delivered,
      '2026-09-06T00:00:00.000Z',
      '2026-09-06T00:10:00.000Z',
      'RV_current_head',
      'head-current'
    );
    db.prepare(
      'INSERT INTO reviewer_passes (repo, pr_number, attempt_number, reviewer_class, reviewer_model,'
      + ' pass_kind, started_at, ended_at, status, body_md, gh_comment_id, head_sha)'
      + " VALUES (?, ?, 1, 'gemini', 'gemini', 'first-pass', ?, ?, 'completed', 'body', ?, ?)"
    ).run(
      'laceyenterprises/agent-os',
      invalidated,
      '2026-09-06T00:00:00.000Z',
      '2026-09-06T00:10:00.000Z',
      'RV_old_head',
      'head-old'
    );
    db.prepare('DELETE FROM reviewed_prs WHERE pr_number IN (9000, 9001)').run();

    assert.equal(
      countOpenPrsAwaitingFirstPassReview(db),
      2,
      'legacy in-flight row plus invalidated current-head row remain queued; current-head pass is excluded'
    );
    const { collectReviewPipelineHealth } = await import('../src/review-pipeline-health.mjs');
    const pipelineSnapshot = collectReviewPipelineHealth({
      rootDir: dbRoot,
      now: () => new Date('2026-09-06T00:30:00.000Z'),
      reconcileTerminalState: false,
    });
    assert.equal(pipelineSnapshot.firstPassQueue.depth, countOpenPrsAwaitingFirstPassReview(db));
    assert.equal(pipelineSnapshot.firstPassQueue.depthUnit, FIRST_PASS_REVIEW_QUEUE_DEPTH_UNIT);
    assert.equal(ctl().plan().engaged, false, 'depth recovered => lever disengages, review returns to agy');
  } finally {
    db.close();
    rmSync(dbRoot, { recursive: true, force: true });
    rmSync(reportRoot, { recursive: true, force: true });
  }
});

// ── wiring gates ─────────────────────────────────────────────────────────────
//
// The controller is exercised directly above, but its three call sites live
// inside `processReviewSubject` (a ~2000-line phase) and the watcher scheduler,
// where a unit test cannot reach them. These assert the plumbing exists, so a
// future refactor cannot silently leave a correct lever unwired — the failure
// mode would be an armed knob that does nothing, which is indistinguishable from
// the monoculture it replaces.

test('watcher.mjs builds the per-tick controller from the production depth counter', () => {
  const src = readFileSync(new URL('../src/watcher.mjs', import.meta.url), 'utf8');
  assert.match(src, /createFirstPassSpilloverController\(\{[^}]*readDepth: countOpenPrsAwaitingFirstPassReview/);
  assert.match(src, /^\s*firstPassSpilloverController,$/m, 'controller must be threaded into the per-PR ctx');
});

test('pollonce-phases passes depth pressure in and charges the cost ledger back', () => {
  const src = readFileSync(new URL('../src/pollonce-phases.mjs', import.meta.url), 'utf8');
  assert.match(src, /depthPressure: firstPassSpilloverController\?\.depthPressure\?\.\(\) \?\? null/);
  // Cost is charged only for a spill that actually landed on a route, and only
  // for the depth trigger — a quota fallback must not spend the depth budget.
  assert.match(
    src,
    /rwfDecision\.reason === 'queue-depth-pressure'\)\s*\{\s*firstPassSpilloverController\?\.recordSpill/
  );
  // The route swap gets the author so the diversity backstop can refuse.
  assert.match(src, /applyReviewerWorkerClassFallbackToRoute\(\{[^}]*authorClass: reviewerAuthorClass/);
});

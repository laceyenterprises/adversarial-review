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
  REREVIEW_QUEUE_DEPTH_FAILOVER_CFG_KEY,
  createFirstPassSpilloverController,
  firstPassSpilloverPlan,
  prepareQueueDepthSpillover,
  readFirstPassReviewQueueDepth,
  readReviewQueueDepthFailoverReport,
  resolveFirstPassReviewQueueDepthFailoverThreshold,
  resolveRereviewQueueDepthFailoverThreshold,
  reviewQueueDepthFailoverReportPath,
} from '../src/review-queue-depth.mjs';
import {
  applyReviewerWorkerClassFallbackToRoute,
  FLEET_QUOTA_STATUS_TICK_CACHE_TTL_MS,
  resolveReviewerWorkerClassWithFallback,
  reviewWorkerClassFallback,
  reviewerWorkerClassEntitled,
  violatesWriterDiversity,
} from '../src/review-worker-class-fallback.mjs';
import { ENV_ALIASES } from '../src/config-loader.mjs';
import { resetRoleConfigCache } from '../src/role-config.mjs';
import {
  SQL_HAS_COMPLETED_REVIEW_FOR_PR,
  SQL_HAS_GENUINE_POSTED_REVIEW_FOR_PR,
} from '../src/review-state-statements.mjs';
import {
  compareReviewerDispatchCandidates,
  createReviewerLaneState,
  runBoundedReviewerDispatchQueue,
  reviewerDispatchPassKind,
  reviewerSafetyPassKind,
} from '../src/watcher-reviewer-pool.mjs';

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

test('default spillover roster preserves cross-model review for codex-family authors', async () => {
  const root = tempRoot();
  try {
    const ctl = controller({ root, depth: 10, threshold: 10 });
    const decision = await resolveReviewerWorkerClassWithFallback({
      authorClass: 'codex',
      primary: 'gemini',
      fallbackWorkerClasses: reviewWorkerClassFallback({}),
      depthPressure: ctl.depthPressure(),
      execFileImpl: fleetStatusStub(CODEX_OK_CLAUDE_OK),
      env: ENTITLED_ENV,
    });
    assert.equal(decision.fellBack, true);
    assert.equal(decision.workerClass, 'claude-code');
    assert.equal(decision.reason, 'queue-depth-pressure');
    assert.equal(decision.from, 'gemini');
    assert.equal(decision.to, 'claude-code');
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

test('writer diversity also holds for rereview depth spillover', async () => {
  const root = tempRoot('rsprereview-diversity-');
  try {
    const ctl = createFirstPassSpilloverController({
      rootDir: root,
      readRereviewDepth: () => 17,
      resolveThresholdImpl: () => 2,
      resolveRereviewThresholdImpl: () => 2,
      logger: { warn() {} },
    });
    const result = await resolveReviewerWorkerClassWithFallback({
      authorClass: 'claude-code',
      primary: 'gemini',
      fallbackWorkerClasses: ['claude-code'],
      depthPressure: ctl.depthPressure('rereview'),
      execFileImpl: fleetStatusStub(CODEX_OK_CLAUDE_OK),
      env: ENTITLED_ENV,
    });
    assert.equal(result.fellBack, false);
    assert.equal(result.workerClass, 'gemini');
    assert.equal(result.reason, 'no-available-fallback');
    assert.equal(ctl.granted(), 0, 'a rejected same-writer route must not spend a spill slot');
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
    assert.equal(report.lastTransition.passKind, 'first-pass');
    assert.equal(report.lanes['first-pass'].engaged, true);
    assert.equal(report.lanes.rereview.engaged, false);
    assert.equal(report.cost.spilloverReviewsTotal, 1);
    assert.equal(report.lanes['first-pass'].cost.spilloverReviewsTotal, 1);
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
    assert.equal(report.lastTransition.passKind, 'first-pass');
    assert.equal(report.lastTransition.engagementSpilloverReviews, 1, 'the cost of the engagement that ended');
    assert.equal(report.cost.lastEngagementSpilloverReviews, 1);
    assert.equal(report.lanes['first-pass'].cost.lastEngagementSpilloverReviews, 1);
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
    assert.match(warnings[0], /pass_kind=first-pass/);
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

test('rereview threshold inherits first-pass, has an env mirror, and zero disables', () => {
  assert.equal(resolveRereviewQueueDepthFailoverThreshold({ env: {}, firstPassThreshold: null }), null);
  const inherited = [];
  assert.equal(resolveRereviewQueueDepthFailoverThreshold({
    env: {}, firstPassThreshold: 2, onInherited: (threshold) => inherited.push(threshold),
  }), 2);
  assert.deepEqual(inherited, [2]);
  assert.equal(resolveRereviewQueueDepthFailoverThreshold({
    env: { AGENT_OS_WATCHER_REREVIEW_QUEUE_DEPTH_FAILOVER_THRESHOLD: '3' },
    topPath: '/dev/null',
    firstPassThreshold: 2,
  }), 3);
  assert.equal(resolveRereviewQueueDepthFailoverThreshold({
    env: { AGENT_OS_WATCHER_REREVIEW_QUEUE_DEPTH_FAILOVER_THRESHOLD: '0' },
    topPath: '/dev/null',
    firstPassThreshold: 2,
  }), null);
  assert.equal(REREVIEW_QUEUE_DEPTH_FAILOVER_CFG_KEY, 'watcher.rereview_queue_depth_failover_threshold');
  assert.equal(
    ENV_ALIASES[REREVIEW_QUEUE_DEPTH_FAILOVER_CFG_KEY]?.canonical,
    'AGENT_OS_WATCHER_REREVIEW_QUEUE_DEPTH_FAILOVER_THRESHOLD'
  );
});

test('a failed first-lane report write does not erase its in-memory cost on the second lane', () => {
  const root = tempRoot('rsprereview-persist-');
  let writes = 0;
  let saved = null;
  try {
    const ctl = createFirstPassSpilloverController({
      rootDir: root,
      readDepth: () => 2,
      readRereviewDepth: () => 2,
      resolveThresholdImpl: () => 2,
      resolveRereviewThresholdImpl: () => 2,
      writeFileImpl(_path, data) {
        writes += 1;
        if (writes === 1) throw new Error('temporary disk failure');
        saved = JSON.parse(data);
      },
      logger: { warn() {} },
    });
    ctl.plan('first-pass');
    ctl.plan('rereview');
    assert.equal(saved.lanes['first-pass'].engaged, true);
    assert.equal(saved.lanes.rereview.engaged, true);
    assert.deepEqual(saved.transitions.map(({ passKind }) => passKind), ['first-pass', 'rereview']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('17 mixed deferred reviews at threshold 2 grant 8 lane-correct spill slots', () => {
  const root = tempRoot('rsprereview-mixed-');
  try {
    const ctl = createFirstPassSpilloverController({
      rootDir: root,
      readDepth: () => 9,
      readRereviewDepth: () => 8,
      resolveThresholdImpl: () => 2,
      resolveRereviewThresholdImpl: () => 2,
      logger: { warn() {} },
    });
    assert.equal(ctl.plan('first-pass').spillSlots, 4);
    assert.equal(ctl.plan('rereview').spillSlots, 4);
    for (let index = 0; index < 4; index += 1) {
      assert.equal(ctl.recordSpill({ repo: 'o/r', prNumber: index, passKind: 'first-pass' }), true);
      assert.equal(ctl.recordSpill({ repo: 'o/r', prNumber: 100 + index, passKind: 'rereview' }), true);
    }
    assert.equal(ctl.granted(), 8);
    assert.equal(ctl.depthPressure('first-pass').engaged, false);
    assert.equal(ctl.depthPressure('rereview').engaged, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an empty report reads back as a well-formed disarmed report', () => {
  const root = tempRoot();
  try {
    const report = readReviewQueueDepthFailoverReport(root);
    assert.equal(report.engaged, false);
    assert.equal(report.cost.spilloverReviewsTotal, 0);
    assert.deepEqual(Object.keys(report.lanes).sort(), ['first-pass', 'rereview']);
    assert.deepEqual(report.transitions, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lane report state does not flap when only first-pass spillover is engaged', () => {
  const root = tempRoot('rsprereview-lanes-');
  const warnings = [];
  const makeController = (now) => createFirstPassSpilloverController({
    rootDir: root,
    readDepth: () => 12,
    readRereviewDepth: () => 0,
    resolveThresholdImpl: () => 10,
    resolveRereviewThresholdImpl: () => null,
    logger: { warn: (message) => warnings.push(String(message)) },
    now,
  });
  try {
    const firstTick = makeController(() => new Date('2026-09-26T01:00:00.000Z'));
    assert.equal(firstTick.plan('first-pass').engaged, true);
    assert.equal(firstTick.plan('rereview').engaged, false);

    const secondTick = makeController(() => new Date('2026-09-26T01:01:00.000Z'));
    assert.equal(secondTick.plan('first-pass').engaged, true);
    assert.equal(secondTick.plan('rereview').engaged, false);

    const report = JSON.parse(readFileSync(reviewQueueDepthFailoverReportPath(root), 'utf8'));
    assert.equal(report.engaged, true);
    assert.equal(report.lanes['first-pass'].engaged, true);
    assert.equal(report.lanes.rereview.engaged, false);
    assert.deepEqual(report.lanes['first-pass'].transitions.map((t) => t.event), ['engage']);
    assert.deepEqual(report.lanes.rereview.transitions, []);
    assert.deepEqual(report.transitions.map((t) => `${t.passKind}:${t.event}`), ['first-pass:engage']);
    assert.equal(warnings.filter((line) => /review-queue-depth-failover/.test(line)).length, 1);
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
  const seed = (prState, reviewStatus) => {
    const prNumber = prSeq++;
    db.prepare(
      'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, review_status)'
      + ' VALUES (?, ?, ?, ?, ?, ?)'
    ).run('laceyenterprises/agent-os', prNumber, '2026-09-06T00:00:00.000Z', 'gemini', prState, reviewStatus);
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
    // Failed attempts are still awaiting a completed first review and count.
    seed('open', 'failed');
    seed('open', 'oauth-broken');
    // Noise that must NOT inflate the depth.
    seed('merged', 'pending');
    seed('closed', 'pending');
    seed('open', 'malformed');
    seed('open', 'argus-security-queued');
    const deliveredAsRereview = seed('open', 'pending');
    db.prepare(
      'INSERT INTO reviewer_passes (repo, pr_number, attempt_number, reviewer_class, reviewer_model,'
      + ' pass_kind, started_at, ended_at, status, body_md, gh_comment_id)'
      + " VALUES (?, ?, 1, 'gemini', 'gemini', 'rereview', ?, ?, 'completed', 'body', 'RV_rereview_first_delivery')"
    ).run(
      'laceyenterprises/agent-os',
      deliveredAsRereview,
      '2026-09-06T00:00:00.000Z',
      '2026-09-06T00:10:00.000Z',
    );

    assert.equal(countOpenPrsAwaitingFirstPassReview(db), 5);
    const engagedPlan = ctl().plan();
    assert.equal(engagedPlan.depth, 5);
    assert.equal(engagedPlan.engaged, true);
    assert.equal(engagedPlan.spillSlots, 1);

    // A genuinely delivered review (a reviewer_passes row carrying a GitHub
    // comment id) drops the depth under threshold and disengages the lever.
    const delivered = seed('open', 'pending');
    db.prepare(
      'INSERT INTO reviewer_passes (repo, pr_number, attempt_number, reviewer_class, reviewer_model,'
      + ' pass_kind, started_at, ended_at, status, body_md, gh_comment_id)'
      + " VALUES (?, ?, 1, 'gemini', 'gemini', 'first-pass', ?, ?, 'completed', 'body', 'RV_1')"
    ).run('laceyenterprises/agent-os', delivered, '2026-09-06T00:00:00.000Z', '2026-09-06T00:10:00.000Z');
    db.prepare('DELETE FROM reviewed_prs WHERE pr_number IN (9000, 9001, 9003, 9004)').run();

    assert.equal(countOpenPrsAwaitingFirstPassReview(db), 1);
    assert.equal(ctl().plan().engaged, false, 'depth recovered => lever disengages, review returns to agy');
  } finally {
    db.close();
    rmSync(dbRoot, { recursive: true, force: true });
    rmSync(reportRoot, { recursive: true, force: true });
  }
});

test('production rereview depth counts only open, eligible, durably requested rereviews', async () => {
  const { ensureReviewStateSchema, openReviewStateDb } = await import('../src/review-state.mjs');
  const { countOpenPrsAwaitingRereview } = await import('../src/review-state-db.mjs');
  const dbRoot = tempRoot('rsprereview-db-');
  const db = openReviewStateDb(dbRoot);
  try {
    ensureReviewStateSchema(db);
    const seed = (
      prNumber,
      {
        state = 'open',
        status = 'pending',
        requested = true,
        posted = null,
        priorPassKind = 'first-pass',
        failureMessage = null,
      } = {},
    ) => {
      db.prepare(
        'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, rereview_requested_at, posted_at, failure_message)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('o/r', prNumber, '2026-09-26T00:00:00Z', 'gemini', state, status,
        requested ? '2026-09-26T00:10:00Z' : null, posted, failureMessage);
      db.prepare(
        'INSERT INTO reviewer_passes (repo, pr_number, attempt_number, reviewer_class, reviewer_model,'
        + ' pass_kind, started_at, ended_at, status, body_md, gh_comment_id)'
        + " VALUES (?, ?, 1, 'gemini', 'gemini', ?, ?, ?, 'completed', 'body', ?)"
      ).run('o/r', prNumber, priorPassKind, '2026-09-26T00:00:00Z', '2026-09-26T00:05:00Z', `RV_${prNumber}`);
    };
    seed(1);
    seed(2, { state: 'merged' });
    seed(3, { requested: false, posted: '2026-09-26T00:05:00Z' });
    seed(4, { status: 'argus-security-queued' });
    seed(5, { requested: false }); // head-refresh path: posted_at was cleared
    seed(6, { priorPassKind: 'rereview' }); // first delivered review was stored as rereview
    seed(7, { status: 'reviewing' }); // already admitted; not awaiting admission
    seed(8, {
      status: 'failed',
      failureMessage: '[review-cycle-cap] automatic review paused',
    });
    seed(9, { status: 'failed', failureMessage: 'reviewer command failed' });
    seed(10, { status: 'pending-github-artifact' });
    seed(11, { status: 'posted', posted: null });
    seed(12); // a delivered review already exists on the current head
    db.prepare("UPDATE reviewed_prs SET revision_ref = 'current-head' WHERE repo = 'o/r' AND pr_number = 12").run();
    db.prepare("UPDATE reviewer_passes SET head_sha = 'current-head' WHERE repo = 'o/r' AND pr_number = 12").run();
    assert.equal(countOpenPrsAwaitingRereview(db), 3);
  } finally {
    db.close();
    rmSync(dbRoot, { recursive: true, force: true });
  }
});

test('an uncaptured completed pass still keeps rereview safety gates armed', async () => {
  const { ensureReviewStateSchema, openReviewStateDb } = await import('../src/review-state.mjs');
  const dbRoot = tempRoot('rsprereview-safety-');
  const db = openReviewStateDb(dbRoot);
  try {
    ensureReviewStateSchema(db);
    db.prepare(
      "INSERT INTO reviewer_passes (repo, pr_number, attempt_number, reviewer_class, reviewer_model, pass_kind, started_at, ended_at, status, body_md, gh_comment_id) "
      + "VALUES ('o/r', 12, 1, 'claude', 'claude', 'first-pass', '2026-09-26T00:00:00Z', '2026-09-26T00:05:00Z', 'completed', 'posted but capture missed', NULL)"
    ).run();
    const hasPriorPostedReview = Boolean(db.prepare(SQL_HAS_GENUINE_POSTED_REVIEW_FOR_PR).get('o/r', 12));
    const hasPriorCompletedReview = Boolean(db.prepare(SQL_HAS_COMPLETED_REVIEW_FOR_PR).get('o/r', 12));
    const candidate = {
      current: { posted_at: null, rereview_requested_at: null },
      hasPriorPostedReview,
      hasPriorCompletedReview,
      completedRemediationRounds: 1,
    };
    assert.equal(reviewerDispatchPassKind(candidate), 'first-pass', 'admission depth still requires delivery proof');
    assert.equal(reviewerSafetyPassKind(candidate), 'rereview', 'closer-head and ceiling gates must remain armed');
    assert.equal(reviewerSafetyPassKind({ ...candidate, completedRemediationRounds: 0 }), 'rereview');
  } finally {
    db.close();
    rmSync(dbRoot, { recursive: true, force: true });
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

test('watcher.mjs builds the per-tick controller from both production depth counters', () => {
  const src = readFileSync(new URL('../src/watcher.mjs', import.meta.url), 'utf8');
  assert.match(src, /createFirstPassSpilloverController\(\{[^}]*readDepth: countOpenPrsAwaitingFirstPassReview/);
  assert.match(src, /readRereviewDepth: countOpenPrsAwaitingRereview/);
  assert.match(src, /^\s*firstPassSpilloverController,$/m, 'controller must be threaded into the per-PR ctx');
});

test('watcher REVSLOT gate uses the delivered-pass-aware first-pass depth counter', () => {
  const src = readFileSync(new URL('../src/watcher.mjs', import.meta.url), 'utf8');
  assert.match(
    src,
    /reviewerDispatchCandidates\.every\(\(candidate\) => !reviewerDispatchIsFirstPass\(candidate\)\) && countOpenPrsAwaitingFirstPassReview\(\) > 0/,
  );
});

test('pollonce-phases passes depth pressure in and charges the cost ledger back', () => {
  const src = readFileSync(new URL('../src/pollonce-phases.mjs', import.meta.url), 'utf8');
  assert.match(src, /applyWorkerFallback\(firstPassSpilloverController\?\.depthPressure\?\.\(getDepthPassKind\(\)\) \?\? null\)/);
  assert.match(src, /passKind: getDepthPassKind\(\)/);
  // Cost is charged only for a spill that actually landed on a route, and only
  // for the depth trigger — a quota fallback must not spend the depth budget.
  assert.match(
    src,
    /rwfDecision\.reason === 'queue-depth-pressure'\)\s*\{\s*depthSpillReserved = firstPassSpilloverController\?\.recordSpill/
  );
  // The route swap gets the author so the diversity backstop can refuse.
  assert.match(src, /applyReviewerWorkerClassFallbackToRoute\(\{[^}]*authorClass: reviewerAuthorClass/);
  assert.match(src, /firstPassSpilloverController\?\.refundSpill\?\.\(\{/);
});

test('pollonce-phases keeps rereview safety independent from queue-depth admission', () => {
  const src = readFileSync(new URL('../src/pollonce-phases.mjs', import.meta.url), 'utf8');
  assert.match(src, /depthPassKind \?\?= reviewerDispatchPassKind\(/);
  assert.match(src, /const passKind = reviewerSafetyPassKind\(\{[\s\S]*?hasPriorCompletedReview: Boolean\(stmtHasCompletedReview\.get\(repoPath, prNumber\)\)/);
  assert.match(src, /if \(passKind === 'rereview'\) \{[\s\S]*?getHeadCloserCommitSuppressionWithBoundedRetry\(/);
});

test('CI-red reservations are refunded so spill slots reach later admissible PRs', () => {
  const root = tempRoot('rsp01-refund-');
  try {
    const ctl = controller({ root, depth: 100, threshold: 10 });
    const spillSlots = ctl.plan().spillSlots;
    for (let index = 0; index < spillSlots; index += 1) {
      assert.equal(ctl.recordSpill({ prNumber: 6900 + index, toWorkerClass: 'codex' }), true);
      assert.equal(ctl.refundSpill({
        prNumber: 6900 + index,
        toWorkerClass: 'codex',
        reason: 'ci-regression-requeued',
      }), true);
    }
    const admitted = Array.from({ length: spillSlots }, (_, index) =>
      ctl.recordSpill({ prNumber: 7000 + index, toWorkerClass: 'codex' }));
    assert.deepEqual(admitted, Array(spillSlots).fill(true));
    assert.equal(ctl.depthPressure().engaged, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pollonce-phases uses a bounded per-tick quota cache TTL', () => {
  assert.equal(FLEET_QUOTA_STATUS_TICK_CACHE_TTL_MS, 60_000);
  const watcherSrc = readFileSync(new URL('../src/watcher.mjs', import.meta.url), 'utf8');
  const pollonceSrc = readFileSync(new URL('../src/pollonce-phases.mjs', import.meta.url), 'utf8');
  assert.match(watcherSrc, /reviewerTickCaches = \{ fleetQuotaStatus: new Map\(\) \}/);
  assert.match(watcherSrc, /reviewerFleetQuotaStatusCache: reviewerTickCaches\.fleetQuotaStatus/);
  assert.match(watcherSrc, /ok=\$\{Boolean\(pollResult\?\.ok\)\} timed_out=\$\{Boolean\(pollResult\?\.timedOut\)\}/);
  assert.match(pollonceSrc, /fleetQuotaStatusCache: reviewerFleetQuotaStatusCache/);
  assert.match(pollonceSrc, /fleetQuotaStatusCacheTtlMs: FLEET_QUOTA_STATUS_TICK_CACHE_TTL_MS/);
  assert.doesNotMatch(pollonceSrc, /fleetQuotaStatusCacheTtlMs: Number\.MAX_SAFE_INTEGER/);
});

// REVIEWFAILOVER-01: use the production drain preparation and fallback resolver.
function spillCandidate(ctl, prNumber, createdAt, {
  builderClass = 'codex', rereview = false, wakePriority = false,
} = {}) {
  return {
    prNumber, repoPath: 'o/r', reviewerModel: 'gemini', wakePriority,
    subject: { createdAt, builderClass }, hasPriorPostedReview: rereview,
    current: { review_status: 'pending', reviewer_model: 'gemini' },
    depthPassKind: rereview ? 'rereview' : 'first-pass',
    async reevaluateDepthSpill() {
      const passKind = rereview ? 'rereview' : 'first-pass';
      const decision = await resolveReviewerWorkerClassWithFallback({
        primary: this.reviewerModel, authorClass: builderClass,
        fallbackWorkerClasses: ['claude-code', 'codex'],
        depthPressure: ctl.depthPressure(passKind), env: ENTITLED_ENV,
        execFileImpl: fleetStatusStub(CODEX_OK_CLAUDE_OK),
      });
      if (decision.fellBack && ctl.recordSpill({ repo: 'o/r', prNumber,
        fromWorkerClass: decision.from, toWorkerClass: decision.to, passKind })) {
        this.reviewerModel = decision.workerClass;
      }
    },
  };
}

async function prepareSpills(ctl, candidates, options = {}) {
  const dispatchOptions = {
    controller: ctl, geminiCredentialConcurrency: 1, maxConcurrent: 6,
    activeReviewerCounts: new Map([['gemini', 1], ['__total__', 1]]),
    compareCandidates: compareReviewerDispatchCandidates, logger: {}, ...options,
  };
  const ordered = await prepareQueueDepthSpillover(candidates, dispatchOptions);
  const releases = [];
  const started = [];
  for (const candidate of ordered) candidate.run = () => new Promise((resolve) => {
    started.push(candidate.prNumber);
    releases.push(() => resolve({ dispatched: true }));
  });
  const result = await runBoundedReviewerDispatchQueue(ordered, {
    ...dispatchOptions, singleWave: true, singleWaveSettleGraceMs: 1,
  });
  for (const release of releases) release();
  ordered.started = started;
  ordered.dispatchResult = result;
  return ordered;
}

test('saturated spill follows the pool wake priority and preserves the per-tick budget', async () => {
  const root = tempRoot();
  try {
    const ctl = controller({ root, depth: 6, threshold: 6 });
    const older = spillCandidate(ctl, 7743, '2026-10-05T01:55:00Z');
    const newer = spillCandidate(ctl, 7750, '2026-10-05T02:30:00Z', { wakePriority: true });
    const rereview = spillCandidate(ctl, 7702, '2026-10-04T01:00:00Z', { rereview: true });
    const order = await prepareSpills(ctl, [newer, rereview, older]);
    assert.deepEqual(order.map((c) => c.prNumber), [7750, 7743, 7702]);
    assert.equal(older.reviewerModel, 'gemini');
    assert.equal(newer.reviewerModel, 'claude-code', 'the pool gives the wake candidate priority');
    assert.deepEqual(order.started, [7750]);
    const report = readReviewQueueDepthFailoverReport(root);
    assert.equal(report.engagementSpilloverReviews, ctl.granted());
    assert.equal(report.cost.currentEngagementSpilloverReviews, ctl.granted());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('free Gemini slot keeps preferred reviewer; the next saturated PR spills', async () => {
  const root = tempRoot();
  try {
    const ctl = controller({ root, depth: 6, threshold: 2 });
    const oldest = spillCandidate(ctl, 7743, '2026-10-05T01:55:00Z');
    const newer = spillCandidate(ctl, 7750, '2026-10-05T02:30:00Z');
    await prepareSpills(ctl, [newer, oldest], { activeReviewerCounts: new Map() });
    assert.equal(oldest.reviewerModel, 'gemini');
    assert.equal(newer.reviewerModel, 'claude-code');
    assert.equal(ctl.granted(), 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('every drain re-evaluates sticky Gemini and skips builder-equals-fallback', async () => {
  const root = tempRoot();
  try {
    const ctl = controller({ root, depth: 6, threshold: 2 });
    const candidate = spillCandidate(ctl, 7743, '2026-10-05T01:55:00Z', { builderClass: 'claude-code' });
    await prepareSpills(ctl, [candidate], { activeReviewerCounts: new Map() });
    assert.equal(candidate.reviewerModel, 'gemini');
    await prepareSpills(ctl, [candidate]);
    assert.equal(candidate.reviewerModel, 'codex');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unknown Gemini capacity keeps one preferred slot and spills the rest with oldest-age logging', async () => {
  const root = tempRoot();
  try {
    const ctl = controller({ root, depth: 6, threshold: 2 });
    const oldest = spillCandidate(ctl, 7743, '2026-10-05T01:55:00Z');
    const newer = spillCandidate(ctl, 7750, '2026-10-05T02:30:00Z');
    const logs = [];
    const ordered = await prepareSpills(ctl, [newer, oldest], {
      geminiCredentialConcurrency: null, activeReviewerCounts: new Map(),
      nowMs: Date.parse('2026-10-05T02:55:00Z'), logger: { log: (line) => logs.push(line) },
    });
    assert.equal(oldest.reviewerModel, 'gemini');
    assert.equal(newer.reviewerModel, 'claude-code');
    assert.equal(ctl.granted(), 1);
    assert.deepEqual(ordered.started, [7743, 7750]);
    assert.match(logs[0], /oldest_first_pass_age_ms=3600000/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unknown Gemini capacity spills when the degraded single slot is already occupied', async () => {
  const root = tempRoot();
  try {
    const ctl = controller({ root, depth: 2, threshold: 2 });
    const candidate = spillCandidate(ctl, 1, '2026-10-05T01:55:00Z');
    const ordered = await prepareSpills(ctl, [candidate], { geminiCredentialConcurrency: null });
    assert.equal(candidate.reviewerModel, 'claude-code');
    assert.deepEqual(ordered.started, [1]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pool protects the wake Gemini slot when its fallback is refused', async () => {
  const root = tempRoot();
  try {
    const ctl = controller({ root, depth: 2, threshold: 2 });
    const older = spillCandidate(ctl, 1, '2026-10-05T01:55:00Z');
    const wake = spillCandidate(ctl, 2, '2026-10-05T02:30:00Z', { wakePriority: true });
    wake.reevaluateDepthSpill = async () => assert.fail('free Gemini seat must not spill');
    const ordered = await prepareSpills(ctl, [older, wake], { activeReviewerCounts: new Map() });
    assert.equal(wake.reviewerModel, 'gemini');
    assert.equal(older.reviewerModel, 'claude-code');
    assert.deepEqual(ordered.started, [2, 1]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('non-Gemini pipeline seats consume preferred capacity before the next spill', async () => {
  const root = tempRoot();
  try {
    const ctl = controller({ root, depth: 2, threshold: 2 });
    const pipeline = spillCandidate(ctl, 1, '2026-10-05T01:55:00Z');
    pipeline.reviewerModel = 'codex';
    pipeline.pipelineGeminiSeats = 1;
    const next = spillCandidate(ctl, 2, '2026-10-05T02:30:00Z');
    const ordered = await prepareSpills(ctl, [next, pipeline], { activeReviewerCounts: new Map() });
    assert.equal(next.reviewerModel, 'claude-code');
    assert.deepEqual(ordered.started, [1, 2]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Gemini pipeline seats keep their route and leave the spill slot for a plain candidate', async () => {
  const root = tempRoot();
  try {
    const ctl = controller({ root, depth: 2, threshold: 2 });
    const pipeline = spillCandidate(ctl, 1, '2026-10-05T01:55:00Z');
    pipeline.pipelineGeminiSeats = 1;
    pipeline.reevaluateDepthSpill = async () => assert.fail('pipeline spill cannot free a Gemini seat');
    const next = spillCandidate(ctl, 2, '2026-10-05T02:30:00Z');
    const ordered = await prepareSpills(ctl, [next, pipeline]);
    assert.equal(pipeline.reviewerModel, 'gemini');
    assert.equal(next.reviewerModel, 'claude-code');
    assert.deepEqual(ordered.started, [2]);
    assert.deepEqual(ordered.dispatchResult.deferredCandidates, [pipeline]);
    assert.equal(ctl.granted(), 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spill honors the pool rereview floor and uses the same lane for pressure and charging', async () => {
  const root = tempRoot();
  try {
    const ctl = createFirstPassSpilloverController({ rootDir: root, readDepth: () => 2,
      readRereviewDepth: () => 2, resolveThresholdImpl: () => 2, resolveRereviewThresholdImpl: () => 2, logger: {} });
    const first = spillCandidate(ctl, 1, '2026-10-05T01:55:00Z');
    const rereview = spillCandidate(ctl, 2, '2026-10-05T02:30:00Z', { rereview: true });
    const laneState = createReviewerLaneState({ firstPassBurstLimit: 1 });
    laneState.firstPassStartsSinceRereview = 1;
    const ordered = await prepareSpills(ctl, [first, rereview], {
      activeReviewerCounts: new Map(), laneState,
    });
    assert.equal(rereview.reviewerModel, 'gemini');
    assert.equal(first.reviewerModel, 'claude-code');
    assert.deepEqual(ordered.started, [2, 1]);
    assert.equal(readReviewQueueDepthFailoverReport(root).lanes['first-pass'].cost.spilloverReviewsTotal, 1);
    assert.equal(readReviewQueueDepthFailoverReport(root).lanes.rereview.cost.spilloverReviewsTotal, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('per-tick spill budget drains a saturated backlog across consecutive ticks', async () => {
  const root = tempRoot();
  try {
    let waiting = [1, 2, 3, 4, 5, 6];
    for (let tick = 0; tick < 3 && waiting.length >= 2; tick += 1) {
      const ctl = controller({ root, depth: waiting.length, threshold: 2 });
      const candidates = waiting.map((number) => spillCandidate(ctl, number,
        `2026-10-05T01:0${number}:00Z`));
      await prepareSpills(ctl, candidates.reverse());
      const admitted = candidates.filter((c) => c.reviewerModel !== 'gemini');
      assert.ok(admitted.length > 0);
      for (const candidate of admitted) ctl.commitSpill({ repo: 'o/r', prNumber: candidate.prNumber });
      waiting = candidates.filter((c) => c.reviewerModel === 'gemini').map((c) => c.prNumber);
    }
    assert.deepEqual(waiting, [6], 'three ticks spill the oldest five; the preferred lane drains the tail');
    const ctl = controller({ root, depth: 1, threshold: 2 });
    const tail = spillCandidate(ctl, 6, '2026-10-05T01:06:00Z');
    await prepareSpills(ctl, [tail], { activeReviewerCounts: new Map() });
    assert.equal(tail.reviewerModel, 'gemini');
    assert.equal(readReviewQueueDepthFailoverReport(root).cost.spilloverReviewsTotal, 5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('refund corrects the live engagement report and frees a slot for the next drain', async () => {
  const root = tempRoot();
  try {
    const ctl = controller({ root, depth: 2, threshold: 2 });
    const candidate = spillCandidate(ctl, 7743, '2026-10-05T01:55:00Z');
    await prepareSpills(ctl, [candidate]);
    assert.equal(readReviewQueueDepthFailoverReport(root).engagementSpilloverReviews, 1);
    ctl.refundSpill({ repo: 'o/r', prNumber: 7743 });
    candidate.reviewerModel = 'gemini';
    assert.equal(readReviewQueueDepthFailoverReport(root).engagementSpilloverReviews, 0);
    await prepareSpills(ctl, [candidate]);
    assert.equal(candidate.reviewerModel, 'claude-code');
    assert.equal(readReviewQueueDepthFailoverReport(root).engagementSpilloverReviews, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spill pressure uses the explicit charge lane when row markers have been cleared', async () => {
  const root = tempRoot();
  try {
    const ctl = createFirstPassSpilloverController({ rootDir: root, readDepth: () => 0,
      readRereviewDepth: () => 2, resolveThresholdImpl: () => 2, resolveRereviewThresholdImpl: () => 2, logger: {} });
    const candidate = spillCandidate(ctl, 1, '2026-10-05T01:55:00Z', { rereview: true });
    delete candidate.hasPriorPostedReview;
    await prepareSpills(ctl, [candidate]);
    assert.equal(candidate.reviewerModel, 'claude-code');
    assert.equal(readReviewQueueDepthFailoverReport(root).lanes.rereview.cost.spilloverReviewsTotal, 1);
    assert.equal(readReviewQueueDepthFailoverReport(root).lanes['first-pass'].cost.spilloverReviewsTotal, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

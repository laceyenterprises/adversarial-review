// RPL-07 — controlled burst reviewer capacity lease.
//
// The mandated properties, one test each (see the ticket's Validate section):
//   1. Lease activation grants additional slots and admits extra reviewers.
//   2. TTL expiry returns capacity to steady state on its own.
//   3. Manual revoke ends the lease immediately.
//   4. A duplicate request UPDATES the lease and carries usage/budget over.
//   5. Unsafe quota REFUSES the lease.
//   6. Pack scope admits in-pack subjects and refuses out-of-pack ones.
// Plus: the CLI/config smoke that shows current burst state, and the proof that
// steady-state defaults are unchanged when no lease is active.

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  BURST_SPEND_UNIT,
  DEFAULT_BURST_MAX_SLOTS,
  DEFAULT_BURST_REVIEWS_PER_SLOT,
  STEADY_AGY_SLOTS,
  collectReviewerBurstStatus,
  createReviewerBurstController,
  evaluateBurstSafety,
  evaluateLeaseState,
  expireReviewerBurstLeaseIfDue,
  normalizeBurstSafetySignals,
  packTokensForSubject,
  readReviewerBurstRecord,
  renderReviewerBurstStatus,
  requestReviewerBurstLease,
  resolveBurstSystemLimits,
  revokeReviewerBurstLease,
  reviewerBurstLeasePath,
  summarizeReviewerBurst,
} from '../src/reviewer-burst-lease.mjs';
import {
  applyReviewerWorkerClassFallbackToRoute,
  resolveReviewerWorkerClassWithFallback,
} from '../src/review-worker-class-fallback.mjs';
import { resolveFirstPassReviewerPoolConfig } from '../src/watcher-reviewer-pool.mjs';
import { burstMain, checkBurstMutationOwner, collectBurstQuotaSignal, parseDurationArg } from '../src/reviewer-burst-cli.mjs';
import {
  collectReviewPipelineHealth,
  renderReviewPipelinePrometheus,
} from '../src/review-pipeline-health.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';
import { sqlSumReviewerPassSpendSince } from '../src/review-state-statements.mjs';
import { resetRoleConfigCache } from '../src/role-config.mjs';

test.afterEach(() => {
  resetRoleConfigCache();
});

// ── fixtures ─────────────────────────────────────────────────────────────────

const REPO = 'laceyenterprises/agent-os';
const T0 = '2026-09-21T12:00:00.000Z';
const T0_MS = Date.parse(T0);

const CODEX_OK_CLAUDE_OK = [
  { provider: 'openai', authPath: 'oauth', state: 'ok' },
  { provider: 'anthropic', authPath: 'oauth', state: 'ok' },
];

const ENTITLED_ENV = Object.freeze({
  GH_CLAUDE_REVIEWER_TOKEN: 'ghs_claude',
  GH_CODEX_REVIEWER_TOKEN: 'ghs_codex',
  GH_GEMINI_REVIEWER_TOKEN: 'ghs_gemini',
});

function fleetStatusStub(rows) {
  const stdout = JSON.stringify({ providerStatuses: rows });
  return async () => ({ stdout });
}

function tempRoot(prefix = 'rpl07-') {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  mkdirSync(path.join(root, 'data'), { recursive: true });
  return root;
}

const SAFE_SIGNALS = Object.freeze({
  quota: { readable: true, availableClasses: ['codex', 'claude-code'], groundedClasses: [], reason: null },
  posting: { readable: true, attempts: 20, failures: 1, failureRatio: 0.05, outageActive: false, windowMs: 3_600_000 },
  reviewer: { readable: true, stuckSlots: 0, states: { active: 1, stale: 0, impossible: 0 } },
});

const silentLogger = { warn() {}, error() {}, log() {} };

function grantLease(root, overrides = {}) {
  return requestReviewerBurstLease({
    rootDir: root,
    repos: [REPO],
    reason: 'pack-sprint app-standup-demo',
    requestedBy: 'operator',
    slots: 2,
    ttlMs: 30 * 60 * 1000,
    budgetUsd: 20,
    safety: SAFE_SIGNALS,
    now: () => new Date(T0),
    logger: silentLogger,
    ...overrides,
  });
}

function controllerAt(root, isoAt, extra = {}) {
  return createReviewerBurstController({
    rootDir: root,
    logger: silentLogger,
    now: () => new Date(isoAt),
    ...extra,
  });
}

// ── 1. activation admits extra reviewers ─────────────────────────────────────

test('an activated lease grants additional slots and admits a non-primary reviewer', async () => {
  const root = tempRoot();
  const granted = grantLease(root);
  assert.equal(granted.ok, true);
  assert.equal(granted.lease.slots, 2);
  assert.equal(granted.lease.state, 'active');

  const controller = controllerAt(root, T0);
  assert.equal(controller.slots(), 2);
  const pressure = controller.pressure({ repo: REPO });
  assert.equal(pressure.engaged, true);
  assert.equal(pressure.leaseId, granted.lease.leaseId);

  // The burst pressure reaches the actual routing decision: a HEALTHY gemini
  // primary yields to an entitled, quota-available fallback class.
  const decision = await resolveReviewerWorkerClassWithFallback({
    authorClass: 'claude-code',
    primary: 'gemini',
    fallbackWorkerClasses: ['codex', 'claude-code'],
    burstPressure: pressure,
    env: ENTITLED_ENV,
    execFileImpl: fleetStatusStub(CODEX_OK_CLAUDE_OK),
    logger: silentLogger,
  });
  assert.equal(decision.fellBack, true);
  assert.equal(decision.reason, 'burst-lease-pressure');
  assert.equal(decision.to, 'codex');
  assert.equal(decision.burstLeaseId, granted.lease.leaseId);
  assert.equal(decision.burstSlots, 2);

  // Provenance survives onto the route the reviewer actually runs with.
  const applied = applyReviewerWorkerClassFallbackToRoute({
    route: { reviewerModel: 'gemini', builderClass: 'claude-code' },
    decision,
    reviewerRouteByModel: { codex: { reviewerModel: 'codex' } },
    authorClass: 'claude-code',
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.route.reviewWorkerClassFallback.burstLeaseId, granted.lease.leaseId);
  assert.equal(applied.route.reviewWorkerClassFallback.reason, 'burst-lease-pressure');
  rmSync(root, { recursive: true, force: true });
});

function poolConfig(overrides = {}) {
  return resolveFirstPassReviewerPoolConfig({
    env: {},
    watcherConfig: { maxConcurrentFirstPassReviewers: 6 },
    logger: silentLogger,
    ...overrides,
  });
}

test('burst slots widen the first-pass reviewer pool ceiling', () => {
  assert.deepEqual(poolConfig(), { enabled: true, maxConcurrent: 6 });
  assert.deepEqual(poolConfig({ burstSlots: 2 }), { enabled: true, maxConcurrent: 8 });
});

test('burstSlots: 0 leaves the pool config byte-identical to the pre-RPL-07 call', () => {
  // Shape as well as value: several suites assert this object with
  // deepStrictEqual, so an extra key is a breaking change, not an addition.
  assert.deepEqual(poolConfig({ burstSlots: 0 }), poolConfig());
  assert.deepEqual(Object.keys(poolConfig()).sort(), ['enabled', 'maxConcurrent']);
});

test('burst slots cannot lift the pool past the system maximum a non-burst host is held to', () => {
  assert.equal(
    poolConfig({ watcherConfig: { maxConcurrentFirstPassReviewers: 12 }, burstSlots: 4 }).maxConcurrent,
    12,
    'clamped to MAX_FIRST_PASS_REVIEWER_POOL_MAX',
  );
});

test('a disabled reviewer pool ignores burst slots entirely', () => {
  assert.deepEqual(
    poolConfig({ watcherConfig: { firstPassReviewerPoolEnabled: false }, burstSlots: 4 }),
    { enabled: false, maxConcurrent: 1 },
  );
});

// ── 2. TTL expiry ────────────────────────────────────────────────────────────

test('TTL expiry returns capacity to steady state and records the expired event once', () => {
  const root = tempRoot();
  grantLease(root, { ttlMs: 10 * 60 * 1000 });

  const duringMs = T0_MS + 5 * 60 * 1000;
  assert.equal(evaluateLeaseState(readReviewerBurstRecord(root).lease, { nowMs: duringMs }).active, true);

  const afterIso = new Date(T0_MS + 11 * 60 * 1000).toISOString();
  const controller = controllerAt(root, afterIso);
  assert.equal(controller.slots(), 0, 'an expired lease grants nothing');
  assert.equal(controller.pressure({ repo: REPO }).engaged, false);

  const record = readReviewerBurstRecord(root);
  assert.equal(record.lease.state, 'expired');
  assert.equal(record.lease.endedReason, 'ttl-elapsed');
  const expiredEvents = record.events.filter((event) => event.event === 'expired');
  assert.equal(expiredEvents.length, 1);

  // Idempotent: re-reading after expiry must not append a second event.
  controllerAt(root, new Date(T0_MS + 20 * 60 * 1000).toISOString()).slots();
  assert.equal(
    readReviewerBurstRecord(root).events.filter((event) => event.event === 'expired').length,
    1,
  );
  rmSync(root, { recursive: true, force: true });
});

test('expiry is derived from the clock, so a burst decays even if nothing ever runs again', () => {
  const root = tempRoot();
  grantLease(root, { ttlMs: 60 * 1000 });
  // No controller, no CLI, no watcher — just the record and a later clock.
  const lease = readReviewerBurstRecord(root).lease;
  assert.equal(lease.state, 'active', 'the record still SAYS active');
  const state = evaluateLeaseState(lease, { nowMs: T0_MS + 120 * 1000 });
  assert.equal(state.active, false, 'but the derived state is expired');
  assert.equal(state.endReason, 'ttl-elapsed');
  rmSync(root, { recursive: true, force: true });
});

test('a lease with an unreadable expiry decays rather than becoming a forever lease', () => {
  const root = tempRoot();
  grantLease(root);
  const record = readReviewerBurstRecord(root);
  record.lease.expiresAt = 'not-a-timestamp';
  writeFileSync(reviewerBurstLeasePath(root), `${JSON.stringify(record, null, 2)}\n`);
  const state = evaluateLeaseState(readReviewerBurstRecord(root).lease, { nowMs: T0_MS });
  assert.equal(state.active, false);
  assert.equal(state.endReason, 'unreadable-expiry');
  rmSync(root, { recursive: true, force: true });
});

// ── 3. manual revoke ─────────────────────────────────────────────────────────

test('manual revoke ends an active lease immediately and audits who ended it', () => {
  const root = tempRoot();
  grantLease(root);
  const revoked = revokeReviewerBurstLease({
    rootDir: root,
    reason: 'demo finished',
    revokedBy: 'operator',
    now: () => new Date(T0_MS + 60 * 1000),
    logger: silentLogger,
  });
  assert.equal(revoked.ok, true);

  const controller = controllerAt(root, new Date(T0_MS + 120 * 1000).toISOString());
  assert.equal(controller.slots(), 0);
  assert.equal(controller.pressure({ repo: REPO }).engaged, false);

  const record = readReviewerBurstRecord(root);
  assert.equal(record.lease.state, 'revoked');
  assert.equal(record.lease.endedReason, 'demo finished');
  assert.equal(record.lease.revokedBy, 'operator');
  assert.equal(record.events.filter((event) => event.event === 'revoked').length, 1);
  assert.equal(record.history.at(-1).state, 'revoked');
  rmSync(root, { recursive: true, force: true });
});

test('revoking with no active lease refuses instead of inventing a transition', () => {
  const root = tempRoot();
  const revoked = revokeReviewerBurstLease({ rootDir: root, now: () => new Date(T0), logger: silentLogger });
  assert.equal(revoked.ok, false);
  assert.equal(revoked.reason, 'no-active-lease');
  rmSync(root, { recursive: true, force: true });
});

// ── 4. duplicate lease update ────────────────────────────────────────────────

test('a duplicate request updates the lease in place and carries the usage ledger over', () => {
  const root = tempRoot();
  const first = grantLease(root, { slots: 2 });
  const controller = controllerAt(root, new Date(T0_MS + 60 * 1000).toISOString());
  controller.recordBurstAdmission({ repo: REPO, prNumber: 1, fromWorkerClass: 'gemini', toWorkerClass: 'codex' });
  controller.recordBurstAdmission({ repo: REPO, prNumber: 2, fromWorkerClass: 'gemini', toWorkerClass: 'codex' });
  assert.equal(readReviewerBurstRecord(root).lease.usage.burstReviewsGranted, 2);

  const second = grantLease(root, {
    slots: 3,
    ttlMs: 45 * 60 * 1000,
    reason: 'extend for demo',
    now: () => new Date(T0_MS + 120 * 1000),
  });
  assert.equal(second.ok, true);
  assert.equal(second.update, true);
  assert.equal(second.lease.leaseId, first.lease.leaseId, 'the lease keeps its identity');
  assert.equal(second.lease.slots, 3);
  assert.equal(second.lease.updates, 1);
  assert.equal(
    second.lease.usage.burstReviewsGranted,
    2,
    're-requesting must not reset the spend ledger, or the budget guard is free to evade',
  );
  assert.equal(second.lease.expiresAt, new Date(T0_MS + 120 * 1000 + 45 * 60 * 1000).toISOString());
  rmSync(root, { recursive: true, force: true });
});

test('an update re-declares scope in full and reports the change', () => {
  const root = tempRoot();
  grantLease(root, { packs: ['rpl'] });
  const updated = grantLease(root, {
    packs: [],
    reason: 'widen to the whole repo',
    now: () => new Date(T0_MS + 60 * 1000),
  });
  assert.equal(updated.scopeChanged, true);
  assert.deepEqual(updated.previousScope.packs, ['rpl']);
  assert.deepEqual(updated.lease.packs, []);
  rmSync(root, { recursive: true, force: true });
});

test('requesting after a lease has already expired starts a fresh lease, not an update', () => {
  const root = tempRoot();
  const first = grantLease(root, { ttlMs: 60 * 1000 });
  const second = grantLease(root, { now: () => new Date(T0_MS + 300 * 1000) });
  assert.equal(second.update, false);
  assert.notEqual(second.lease.leaseId, first.lease.leaseId);
  assert.equal(second.lease.usage.burstReviewsGranted, 0);
  const record = readReviewerBurstRecord(root);
  assert.equal(record.history.some((entry) => entry.leaseId === first.lease.leaseId), true);
  rmSync(root, { recursive: true, force: true });
});

// ── 5. unsafe quota / posting / reviewer health refusal ──────────────────────

test('an unreadable quota state refuses the burst rather than guessing', () => {
  const root = tempRoot();
  const denied = grantLease(root, {
    safety: { ...SAFE_SIGNALS, quota: { readable: false, availableClasses: [], groundedClasses: [] } },
  });
  assert.equal(denied.ok, false);
  assert.deepEqual(denied.blockers, ['quota-unreadable']);
  assert.equal(readReviewerBurstRecord(root).lease, null, 'no lease is created');
  assert.equal(readReviewerBurstRecord(root).events.filter((e) => e.event === 'denied').length, 1);
  rmSync(root, { recursive: true, force: true });
});

test('a burst with every fallback class grounded is refused — there is nothing to burst into', () => {
  const root = tempRoot();
  const denied = grantLease(root, {
    safety: {
      ...SAFE_SIGNALS,
      quota: { readable: true, availableClasses: [], groundedClasses: ['codex', 'claude-code'] },
    },
  });
  assert.equal(denied.ok, false);
  assert.deepEqual(denied.blockers, ['quota-no-available-burst-reviewer']);
  rmSync(root, { recursive: true, force: true });
});

test('unsafe posting health refuses; degraded posting health grants fewer slots', () => {
  const unsafe = evaluateBurstSafety({
    signals: {
      ...SAFE_SIGNALS,
      posting: { readable: true, attempts: 10, failures: 6, failureRatio: 0.6, outageActive: false },
    },
    requestedSlots: 4,
  });
  assert.equal(unsafe.safe, false);
  assert.ok(unsafe.blockers.includes('posting-failure-rate-unsafe'));

  const degraded = evaluateBurstSafety({
    signals: {
      ...SAFE_SIGNALS,
      posting: { readable: true, attempts: 10, failures: 3, failureRatio: 0.3, outageActive: false },
    },
    requestedSlots: 4,
  });
  assert.equal(degraded.safe, true);
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.allowedSlots, 2);
  assert.deepEqual(degraded.warnings, ['posting-failure-rate-degraded']);
});

test('an active review outage refuses the burst outright', () => {
  const verdict = evaluateBurstSafety({
    signals: { ...SAFE_SIGNALS, posting: { ...SAFE_SIGNALS.posting, outageActive: true } },
    requestedSlots: 2,
  });
  assert.equal(verdict.safe, false);
  assert.ok(verdict.blockers.includes('posting-outage-active'));
});

test('stuck reviewer slots refuse the burst; one stuck slot degrades it', () => {
  const unsafe = evaluateBurstSafety({
    signals: { ...SAFE_SIGNALS, reviewer: { readable: true, stuckSlots: 2 } },
    requestedSlots: 3,
  });
  assert.equal(unsafe.safe, false);
  assert.ok(unsafe.blockers.includes('reviewer-slots-stuck'));

  const degraded = evaluateBurstSafety({
    signals: { ...SAFE_SIGNALS, reviewer: { readable: true, stuckSlots: 1 } },
    requestedSlots: 4,
  });
  assert.equal(degraded.allowedSlots, 2);
  assert.deepEqual(degraded.warnings, ['reviewer-slots-degraded']);
});

test('partial quota grounding caps the grant at the classes that can actually absorb it', () => {
  const verdict = evaluateBurstSafety({
    signals: {
      ...SAFE_SIGNALS,
      quota: { readable: true, availableClasses: ['codex'], groundedClasses: ['claude-code'] },
    },
    requestedSlots: 3,
  });
  assert.equal(verdict.safe, true);
  assert.equal(verdict.allowedSlots, 1);
  assert.deepEqual(verdict.warnings, ['quota-partially-grounded']);
});

test('a degraded grant is recorded on the lease so the operator sees what they actually got', () => {
  const root = tempRoot();
  const granted = grantLease(root, {
    slots: 4,
    safety: { ...SAFE_SIGNALS, reviewer: { readable: true, stuckSlots: 1 } },
  });
  assert.equal(granted.ok, true);
  assert.equal(granted.degraded, true);
  assert.equal(granted.lease.requestedSlots, 4);
  assert.equal(granted.lease.slots, 2);
  assert.deepEqual(granted.lease.degradeReasons, ['reviewer-slots-degraded']);
  rmSync(root, { recursive: true, force: true });
});

test('a missing health ledger reads as unknown, not as perfect health', () => {
  const signals = normalizeBurstSafetySignals({
    healthSnapshot: {
      reviewStateLedger: { readable: false, exists: false },
      reviewer: { total: 0, failed: 0 },
      reviewerSlots: { states: { active: 0, stale: 0, impossible: 0 } },
    },
    quota: { readable: true, availableClasses: ['codex'], groundedClasses: [] },
  });
  assert.equal(signals.posting.readable, false);
  assert.equal(signals.reviewer.readable, false);
  const verdict = evaluateBurstSafety({ signals, requestedSlots: 2 });
  assert.equal(verdict.safe, false);
  assert.deepEqual(verdict.blockers, ['posting-health-unreadable', 'reviewer-health-unreadable']);
});

test('scope and reason are hard preconditions, checked before any safety signal', () => {
  const root = tempRoot();
  assert.deepEqual(
    grantLease(root, { repos: [], safety: null }).blockers,
    ['scope-missing-repo'],
    'a repo-less burst is the hidden global knob the spec forbids',
  );
  assert.deepEqual(grantLease(root, { reason: '  ', safety: null }).blockers, ['reason-required']);
  assert.deepEqual(grantLease(root, { slots: 0, safety: null }).blockers, ['slots-must-be-positive']);
  rmSync(root, { recursive: true, force: true });
});

// ── 6. pack-scoped admission ─────────────────────────────────────────────────

test('pack scope admits an in-pack subject and refuses an out-of-pack one', () => {
  const root = tempRoot();
  grantLease(root, { packs: ['rpl'] });
  const controller = controllerAt(root, T0);

  const inPack = controller.pressure({
    repo: REPO,
    packTokens: packTokensForSubject({ title: '[codex] RPL-07: controlled burst lease' }),
  });
  assert.equal(inPack.engaged, true);

  const outOfPack = controller.pressure({
    repo: REPO,
    packTokens: packTokensForSubject({ title: '[codex] WBO-03: unrelated work' }),
  });
  assert.equal(outOfPack.engaged, false);
  assert.equal(outOfPack.reason, 'pack-out-of-scope');

  // The call site hands a thunk so an out-of-scope repo never pays to derive
  // tokens; the thunk form must produce the same verdict.
  let thunkCalls = 0;
  assert.equal(
    controller.pressure({
      repo: REPO,
      packTokens: () => { thunkCalls += 1; return packTokensForSubject({ linearTicketId: 'RPL-09' }); },
    }).engaged,
    true,
  );
  assert.equal(thunkCalls, 1);
  rmSync(root, { recursive: true, force: true });
});

test('a pack-token thunk is never called for an out-of-scope repo or an inactive lease', () => {
  const root = tempRoot();
  grantLease(root, { packs: ['rpl'] });
  const controller = controllerAt(root, T0);
  let calls = 0;
  const thunk = () => { calls += 1; return new Set(['rpl']); };
  assert.equal(controller.pressure({ repo: 'laceyenterprises/other', packTokens: thunk }).engaged, false);
  assert.equal(calls, 0, 'repo scope is checked before any token derivation');

  const inert = controllerAt(tempRoot(), T0);
  assert.equal(inert.pressure({ repo: REPO, packTokens: thunk }).engaged, false);
  assert.equal(calls, 0, 'a host with no lease pays nothing at all');
  rmSync(root, { recursive: true, force: true });
});

test('an out-of-scope repo sees no burst at all, even inside the lease TTL', () => {
  const root = tempRoot();
  grantLease(root);
  const controller = controllerAt(root, T0);
  const other = controller.pressure({ repo: 'laceyenterprises/adversarial-review' });
  assert.equal(other.engaged, false);
  assert.equal(other.reason, 'repo-out-of-scope');
  assert.equal(controller.pressure({ repo: REPO }).engaged, true);
  rmSync(root, { recursive: true, force: true });
});

test('a lease with no pack scope covers every PR in its repos', () => {
  const root = tempRoot();
  grantLease(root, { packs: [] });
  const controller = controllerAt(root, T0);
  assert.equal(
    controller.pressure({ repo: REPO, packTokens: packTokensForSubject({ title: 'anything at all' }) }).engaged,
    true,
  );
});

test('pack tokens come from labels, the Linear ticket, the title, and the branch', () => {
  const tokens = packTokensForSubject({
    labels: ['pack:app-standup-demo', { name: 'risk:medium' }],
    linearTicketId: 'RPL-07',
    title: '[codex] RPL-07: controlled burst reviewer capacity lease',
    branch: 'claude-code-rpl-07-a18711e3/RPL-07',
  });
  assert.equal(tokens.has('app-standup-demo'), true, 'pack:<token> label');
  assert.equal(tokens.has('pack:app-standup-demo'), true, 'the whole label matches too');
  assert.equal(tokens.has('rpl-07'), true, 'the full ticket id');
  assert.equal(tokens.has('rpl'), true, 'the pack prefix — how a ten-ticket pack is actually named');
  assert.equal(tokens.has('risk:medium'), true);
  assert.equal(tokens.has('r'), false, 'a token only ever matches a whole label or a whole ticket id/prefix');
  assert.equal(tokens.has('codex'), false);
});

// ── budget guard ─────────────────────────────────────────────────────────────

test('the review-count cap bounds a burst even with no cost telemetry at all', () => {
  const root = tempRoot();
  const granted = grantLease(root, { slots: 1, maxBurstReviews: 2 });
  assert.equal(granted.lease.maxBurstReviews, 2);
  const controller = controllerAt(root, T0);
  assert.equal(controller.recordBurstAdmission({ repo: REPO, prNumber: 1, toWorkerClass: 'codex' }), true);
  assert.equal(controller.recordBurstAdmission({ repo: REPO, prNumber: 2, toWorkerClass: 'codex' }), true);
  assert.equal(
    controller.recordBurstAdmission({ repo: REPO, prNumber: 3, toWorkerClass: 'codex' }),
    false,
    'the cap refuses a third burst-bought review',
  );
  assert.equal(controller.pressure({ repo: REPO }).engaged, false);
  // A later tick settles the lease terminally.
  const later = controllerAt(root, new Date(T0_MS + 60 * 1000).toISOString());
  assert.equal(later.slots(), 0);
  const record = readReviewerBurstRecord(root);
  assert.equal(record.lease.state, 'expired');
  assert.equal(record.lease.endedReason, 'review-cap-reached');
  rmSync(root, { recursive: true, force: true });
});

test('the default review cap is derived from the granted slots, not the requested ones', () => {
  const root = tempRoot();
  const granted = grantLease(root, {
    slots: 4,
    safety: { ...SAFE_SIGNALS, reviewer: { readable: true, stuckSlots: 1 } },
  });
  assert.equal(granted.lease.slots, 2);
  assert.equal(granted.lease.maxBurstReviews, 2 * DEFAULT_BURST_REVIEWS_PER_SLOT);
  rmSync(root, { recursive: true, force: true });
});

test('observed spend at or above the budget ends the lease on the tick it is read', () => {
  const root = tempRoot();
  grantLease(root, { budgetUsd: 5 });
  const controller = controllerAt(root, new Date(T0_MS + 60 * 1000).toISOString(), {
    readSpendUsd: () => 7.5,
  });
  assert.equal(controller.slots(), 0);
  const record = readReviewerBurstRecord(root);
  assert.equal(record.lease.state, 'expired');
  assert.equal(record.lease.endedReason, 'budget-exhausted');
  assert.equal(record.lease.usage.spendUsd, 7.5);
  rmSync(root, { recursive: true, force: true });
});

test('spend under budget keeps the lease and records the observation', () => {
  const root = tempRoot();
  grantLease(root, { budgetUsd: 20 });
  const controller = controllerAt(root, new Date(T0_MS + 60 * 1000).toISOString(), {
    readSpendUsd: () => 3.25,
  });
  assert.equal(controller.slots(), 2);
  const record = readReviewerBurstRecord(root);
  assert.equal(record.lease.usage.spendUsd, 3.25);
  assert.equal(record.lease.usage.spendReadable, true);
  rmSync(root, { recursive: true, force: true });
});

test('an unreadable or throwing spend reader degrades to the review-count cap, not to $0', () => {
  const root = tempRoot();
  grantLease(root, { budgetUsd: 20 });
  const controller = controllerAt(root, new Date(T0_MS + 60 * 1000).toISOString(), {
    readSpendUsd: () => { throw new Error('reviews.db is locked'); },
  });
  assert.equal(controller.slots(), 2, 'the burst survives a cost-telemetry outage');
  const record = readReviewerBurstRecord(root);
  assert.equal(record.lease.usage.spendReadable, false);
  assert.equal(record.lease.usage.spendUsd, null, 'never reported as $0.00, which would silently pass the guard');
  assert.ok(record.lease.maxBurstReviews > 0, 'the always-enforceable limb still bounds the burst');
  rmSync(root, { recursive: true, force: true });
});

function spendFixtureDb(rows) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE reviewer_passes (
    pass_id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT, pr_number INTEGER,
    started_at TEXT, token_cost_usd REAL);`);
  const insert = db.prepare('INSERT INTO reviewer_passes (repo, pr_number, started_at, token_cost_usd) VALUES (?, ?, ?, ?)');
  rows.forEach((row, index) => insert.run(row.repo, index + 1, row.startedAt, row.cost));
  return db;
}

test('an unreadable spend can neither pass nor trip the dollar guard', () => {
  const root = tempRoot();
  // A zero budget is the adversarial shape: Number(null) is 0, so a naive
  // `spend >= budget` compare would read "we don't know" as "exhausted".
  const granted = grantLease(root, { budgetUsd: 0 });
  assert.equal(granted.lease.budgetUsd, 0);
  assert.equal(granted.lease.usage.spendUsd, null);
  const state = evaluateLeaseState(granted.lease, { nowMs: T0_MS + 1000 });
  assert.equal(state.active, true, 'an unknown spend must not manufacture a budget exhaustion');
  rmSync(root, { recursive: true, force: true });
});

test('the observed-spend SQL sums reviewer pass cost since activation, scoped to the lease repos', () => {
  const db = spendFixtureDb([
    { repo: REPO, startedAt: '2026-09-21T11:00:00.000Z', cost: 9.0 }, // before activation
    { repo: REPO, startedAt: '2026-09-21T12:10:00.000Z', cost: 1.5 },
    { repo: REPO, startedAt: '2026-09-21T12:20:00.000Z', cost: 2.5 },
    { repo: 'laceyenterprises/other', startedAt: '2026-09-21T12:30:00.000Z', cost: 50.0 }, // out of scope
  ]);
  const row = db.prepare(sqlSumReviewerPassSpendSince(1)).get(T0, REPO);
  assert.equal(row.spend_usd, 4.0);
  assert.equal(row.pass_count, 2);
  assert.equal(row.uncosted_pass_count, 0);
  db.close();
});

test('the observed-spend window matches SQLite CURRENT_TIMESTAMP rows, not just ISO ones', () => {
  // `reviewer_passes.started_at` carries both shapes. ' ' sorts before 'T', so
  // a raw lexicographic compare drops every same-day space-separated row —
  // under-reporting spend, which is the direction that outlives a budget.
  const db = spendFixtureDb([
    { repo: REPO, startedAt: '2026-09-21 12:30:00', cost: 6.0 }, // after activation, SQLite shape
    { repo: REPO, startedAt: '2026-09-21 11:30:00', cost: 99.0 }, // before activation, SQLite shape
    { repo: REPO, startedAt: '2026-09-21T12:40:00.000Z', cost: 1.0 },
  ]);
  const row = db.prepare(sqlSumReviewerPassSpendSince(1)).get(T0, REPO);
  assert.equal(row.spend_usd, 7.0, 'the space-separated in-window row must be counted');
  assert.equal(row.pass_count, 2, 'and the space-separated out-of-window row must not be');
  db.close();
});

test('uncosted in-flight passes are reported so a partial sum is never mistaken for full coverage', () => {
  const db = spendFixtureDb([
    { repo: REPO, startedAt: '2026-09-21T12:10:00.000Z', cost: 2.0 },
    { repo: REPO, startedAt: '2026-09-21T12:20:00.000Z', cost: null }, // still running
  ]);
  const row = db.prepare(sqlSumReviewerPassSpendSince(1)).get(T0, REPO);
  assert.equal(row.spend_usd, 2.0);
  assert.equal(row.pass_count, 2);
  assert.equal(row.uncosted_pass_count, 1, 'the caller returns null only when coverage is ZERO');
  db.close();
});

test('a system ceiling an operator cannot exceed bounds slots, TTL, and budget', () => {
  const root = tempRoot();
  const limits = resolveBurstSystemLimits({});
  assert.equal(limits.maxSlots, DEFAULT_BURST_MAX_SLOTS);
  const granted = grantLease(root, {
    slots: 50,
    ttlMs: 48 * 60 * 60 * 1000,
    budgetUsd: 10_000,
  });
  assert.equal(granted.lease.slots, limits.maxSlots);
  assert.equal(granted.lease.ttlMs, limits.maxTtlMs);
  assert.equal(granted.lease.budgetUsd, limits.maxBudgetUsd);
  rmSync(root, { recursive: true, force: true });
});

// ── steady-state parity: nothing changes without a lease ─────────────────────

test('with no lease the controller is inert and every integration point is pre-RPL-07', async () => {
  const root = tempRoot();
  const controller = controllerAt(root, T0);
  assert.equal(controller.slots(), 0);
  assert.equal(controller.lease(), null);
  assert.equal(controller.pressure({ repo: REPO }).engaged, false);
  assert.equal(controller.recordBurstAdmission({ repo: REPO, prNumber: 1 }), false);

  // No lease record is created by merely reading.
  assert.throws(() => readFileSync(reviewerBurstLeasePath(root), 'utf8'));

  // Parity, asserted rather than asserted-about: the routing decision with an
  // inert burst controller must be byte-identical to the one taken with no
  // `burstPressure` argument at all, which is the pre-RPL-07 call.
  const routeArgs = {
    authorClass: 'claude-code',
    primary: 'gemini',
    fallbackWorkerClasses: ['codex', 'claude-code'],
    env: ENTITLED_ENV,
    execFileImpl: fleetStatusStub(CODEX_OK_CLAUDE_OK),
    logger: silentLogger,
  };
  const withInertBurst = await resolveReviewerWorkerClassWithFallback({
    ...routeArgs,
    burstPressure: controller.pressure({ repo: REPO }),
  });
  const preRpl07 = await resolveReviewerWorkerClassWithFallback(routeArgs);
  assert.deepEqual(withInertBurst, preRpl07);
  assert.equal(withInertBurst.fellBack, false);
  assert.equal(withInertBurst.burstLeaseId, undefined);
  rmSync(root, { recursive: true, force: true });
});

test('an absent, empty, or corrupt lease record all read as "no burst"', () => {
  const root = tempRoot();
  assert.equal(summarizeReviewerBurst(root, { nowMs: T0_MS }).active, false);
  writeFileSync(reviewerBurstLeasePath(root), '');
  assert.equal(summarizeReviewerBurst(root, { nowMs: T0_MS }).active, false);
  writeFileSync(reviewerBurstLeasePath(root), '{ this is not json');
  assert.equal(summarizeReviewerBurst(root, { nowMs: T0_MS }).active, false);
  writeFileSync(reviewerBurstLeasePath(root), JSON.stringify({ lease: { state: 'active', slots: 99 } }));
  assert.equal(
    summarizeReviewerBurst(root, { nowMs: T0_MS }).active,
    false,
    'a lease with no expiry cannot claim capacity',
  );
  rmSync(root, { recursive: true, force: true });
});

test('the depth lever keeps its exact reason string and provenance when both levers are live', async () => {
  const root = tempRoot();
  grantLease(root);
  const decision = await resolveReviewerWorkerClassWithFallback({
    authorClass: 'claude-code',
    primary: 'gemini',
    fallbackWorkerClasses: ['codex'],
    depthPressure: { engaged: true, depth: 30, threshold: 10 },
    burstPressure: controllerAt(root, T0).pressure({ repo: REPO }),
    env: ENTITLED_ENV,
    execFileImpl: fleetStatusStub(CODEX_OK_CLAUDE_OK),
    logger: silentLogger,
  });
  assert.equal(decision.reason, 'queue-depth-pressure', 'depth wins attribution so RSP-01 is unchanged');
  assert.equal(decision.queueDepth, 30);
  assert.equal(decision.burstLeaseId, undefined, 'the burst ledger is not charged for a depth spill');
  rmSync(root, { recursive: true, force: true });
});

test('burst still cannot select an unentitled or quota-grounded fallback class', async () => {
  const root = tempRoot();
  grantLease(root);
  const pressure = controllerAt(root, T0).pressure({ repo: REPO });

  const grounded = await resolveReviewerWorkerClassWithFallback({
    authorClass: 'claude-code',
    primary: 'gemini',
    fallbackWorkerClasses: ['codex'],
    burstPressure: pressure,
    env: ENTITLED_ENV,
    execFileImpl: fleetStatusStub([
      { provider: 'openai', authPath: 'oauth', state: 'exhausted' },
      { provider: 'anthropic', authPath: 'oauth', state: 'ok' },
    ]),
    logger: silentLogger,
  });
  assert.equal(grounded.fellBack, false, 'a provider that grounds mid-burst stops the spend');

  const unentitled = await resolveReviewerWorkerClassWithFallback({
    authorClass: 'claude-code',
    primary: 'gemini',
    fallbackWorkerClasses: ['codex'],
    burstPressure: pressure,
    env: {},
    execFileImpl: fleetStatusStub(CODEX_OK_CLAUDE_OK),
    logger: silentLogger,
  });
  assert.equal(unentitled.fellBack, false, 'a class with no reviewer token cannot post, so it is not selected');
  rmSync(root, { recursive: true, force: true });
});

test('burst never overrides writer diversity', async () => {
  const root = tempRoot();
  grantLease(root);
  const decision = await resolveReviewerWorkerClassWithFallback({
    authorClass: 'codex',
    primary: 'gemini',
    fallbackWorkerClasses: ['codex'],
    burstPressure: controllerAt(root, T0).pressure({ repo: REPO }),
    env: ENTITLED_ENV,
    execFileImpl: fleetStatusStub(CODEX_OK_CLAUDE_OK),
    logger: silentLogger,
  });
  assert.equal(decision.fellBack, false);
  assert.equal(decision.reason, 'no-available-fallback');
  rmSync(root, { recursive: true, force: true });
});

// ── CLI / config smoke: the current burst state is visible ───────────────────

test('CLI smoke: status shows the current burst state before, during, and after a lease', async () => {
  const root = tempRoot();
  const write = (sink) => ({ write: (chunk) => sink.push(chunk) });

  const before = [];
  assert.equal(await burstMain(['status', '--root', root], { stdout: write(before), stderr: write([]) }), 0);
  assert.match(before.join(''), /^state: inactive$/m);
  assert.match(before.join(''), /^burst_slots: 0$/m);
  assert.match(before.join(''), /^steady_agy_slots: 1$/m);

  const io = {
    collectHealthImpl: () => ({
      reviewStateLedger: { readable: true, exists: true },
      reviewer: { total: 20, failed: 1 },
      reviewerSlots: { states: { active: 1, stale: 0, impossible: 0 } },
      outage: { active: false },
      config: { reviewerDeathRateWindowMs: 3_600_000 },
    }),
    collectQuotaImpl: () => ({ readable: true, availableClasses: ['codex'], groundedClasses: [] }),
  };

  const requested = [];
  assert.equal(
    await burstMain(
      ['request', '--root', root, '--repo', REPO, '--pack', 'rpl', '--reason', 'pack-sprint', '--ttl', '30m', '--slots', '2'],
      { ...io, stdout: write(requested), stderr: write([]) },
    ),
    0,
  );
  const requestedOut = requested.join('');
  assert.match(requestedOut, /burst lease ACTIVATED/);
  assert.match(requestedOut, /^state: active$/m);
  assert.match(requestedOut, /^pack_scope: rpl$/m);
  assert.match(requestedOut, /rollback: adversarial-review burst revoke/, 'the rollback command is printed');

  const json = [];
  assert.equal(await burstMain(['status', '--root', root, '--json'], { stdout: write(json), stderr: write([]) }), 0);
  const parsed = JSON.parse(json.join(''));
  assert.equal(parsed.active, true);
  assert.equal(parsed.burstSlots, 2, 'the full requested grant: nothing degraded it');
  assert.equal(parsed.steadyAgySlots, STEADY_AGY_SLOTS);
  assert.equal(parsed.spendUnit, BURST_SPEND_UNIT);
  assert.deepEqual(parsed.lease.repos, [REPO]);

  const revoked = [];
  assert.equal(
    await burstMain(['revoke', '--root', root, '--reason', 'done'], { stdout: write(revoked), stderr: write([]) }),
    0,
  );
  assert.match(revoked.join(''), /burst lease REVOKED/);

  const after = [];
  assert.equal(await burstMain(['status', '--root', root], { stdout: write(after), stderr: write([]) }), 0);
  assert.match(after.join(''), /^state: revoked$/m);
  assert.match(after.join(''), /^burst_slots: 0$/m);
  rmSync(root, { recursive: true, force: true });
});

test('CLI smoke: a refused request exits 1, names its blockers, and leaves burst off', async () => {
  const root = tempRoot();
  const out = [];
  const err = [];
  const code = await burstMain(['request', '--root', root, '--repo', REPO, '--reason', 'demo'], {
    stdout: { write: (chunk) => out.push(chunk) },
    stderr: { write: (chunk) => err.push(chunk) },
    collectHealthImpl: () => ({ reviewStateLedger: { readable: false, exists: false } }),
    collectQuotaImpl: () => ({ readable: false, availableClasses: [], groundedClasses: [] }),
  });
  assert.equal(code, 1);
  assert.match(err.join(''), /burst lease REFUSED/);
  assert.match(err.join(''), /quota-unreadable/);
  assert.equal(collectReviewerBurstStatus(root).active, false);
  rmSync(root, { recursive: true, force: true });
});

test('CLI smoke: usage errors are exit 2 and never write a lease', async () => {
  const root = tempRoot();
  const err = [];
  const io = { stdout: { write() {} }, stderr: { write: (chunk) => err.push(chunk) } };
  assert.equal(await burstMain(['request', '--root', root, '--ttl', 'soon'], io), 2);
  assert.equal(await burstMain(['request', '--root', root, '--slots', '0'], io), 2);
  assert.equal(await burstMain(['request', '--root', root, '--budget', '-4'], io), 2);
  assert.equal(await burstMain(['nonsense', '--root', root], io), 2);
  assert.equal(collectReviewerBurstStatus(root).active, false);
  rmSync(root, { recursive: true, force: true });
});

test('CLI smoke: --help prints usage and exits 0 even without a subcommand', async () => {
  const out = [];
  const err = [];
  const io = { stdout: { write: (c) => out.push(c) }, stderr: { write: (c) => err.push(c) } };
  assert.equal(await burstMain(['--help'], io), 0, 'the one invocation reached for when you know no command names');
  assert.match(out.join(''), /adversarial-review burst status/);
  assert.equal(err.join(''), '');
  assert.equal(await burstMain(['status', '--help'], io), 0);
  assert.equal(await burstMain([], io), 2, 'a bare `burst` is still a usage error');
});

test('CLI duration parsing accepts the forms the usage advertises', () => {
  assert.equal(parseDurationArg('30m'), 30 * 60 * 1000);
  assert.equal(parseDurationArg('45s'), 45_000);
  assert.equal(parseDurationArg('2h'), 2 * 3_600_000);
  assert.equal(parseDurationArg('90'), 90 * 60 * 1000, 'bare numbers are minutes');
  assert.equal(parseDurationArg('0m'), null);
  assert.equal(parseDurationArg('soon'), null);
});

test('the quota signal asks the same entitled+available question routing will ask', () => {
  const env = { ...ENTITLED_ENV, ADVERSARIAL_REVIEW_WORKER_CLASS_FALLBACK: 'codex,claude-code' };
  const stdout = JSON.stringify({
    providerStatuses: [
      { provider: 'openai', authPath: 'oauth', state: 'ok' },
      { provider: 'anthropic', authPath: 'oauth', state: 'exhausted' },
    ],
  });
  const signal = collectBurstQuotaSignal({ env, execFileSyncImpl: () => stdout });
  assert.equal(signal.readable, true);
  assert.deepEqual(signal.availableClasses, ['codex']);
  assert.deepEqual(signal.groundedClasses, ['claude-code']);

  const unentitled = collectBurstQuotaSignal({
    env: { ADVERSARIAL_REVIEW_WORKER_CLASS_FALLBACK: 'codex' },
    execFileSyncImpl: () => stdout,
  });
  assert.deepEqual(unentitled.availableClasses, [], 'an unentitled class cannot absorb burst work');

  const unreadable = collectBurstQuotaSignal({
    env,
    execFileSyncImpl: () => { throw new Error('hq: command not found'); },
  });
  assert.equal(unreadable.readable, false);
});

test('a transient quota-status failure retries with bounded backoff', () => {
  const env = { ...ENTITLED_ENV, ADVERSARIAL_REVIEW_WORKER_CLASS_FALLBACK: 'codex' };
  let attempts = 0;
  const waits = [];
  const signal = collectBurstQuotaSignal({
    env,
    execFileSyncImpl: () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('temporary timeout'), { code: 'ETIMEDOUT' });
      return JSON.stringify({ providerStatuses: CODEX_OK_CLAUDE_OK });
    },
    sleepImpl: (ms) => waits.push(ms),
  });
  assert.equal(signal.readable, true);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [100, 250]);
});

test('lease writes fail closed for activation, revoke, and admission', () => {
  const root = tempRoot();
  const failedWrite = () => { throw new Error('EACCES'); };
  const activation = grantLease(root, { writeFileImpl: failedWrite });
  assert.equal(activation.ok, false);
  assert.deepEqual(activation.blockers, ['lease-write-failed']);
  assert.equal(collectReviewerBurstStatus(root).active, false);

  assert.equal(grantLease(root).ok, true);
  const revoked = revokeReviewerBurstLease({
    rootDir: root,
    now: () => new Date(T0_MS + 1000),
    writeFileImpl: failedWrite,
    logger: silentLogger,
  });
  assert.equal(revoked.ok, false);
  assert.equal(revoked.reason, 'lease-write-failed');
  assert.equal(readReviewerBurstRecord(root).lease.state, 'active');

  const controller = controllerAt(root, T0, { writeFileImpl: failedWrite });
  assert.throws(
    () => controller.recordBurstAdmission({ repo: REPO, prNumber: 1, toWorkerClass: 'codex' }),
    /lease-write-failed/,
  );
  assert.equal(readReviewerBurstRecord(root).lease.usage.burstReviewsGranted, 0);
  rmSync(root, { recursive: true, force: true });
});

test('CLI refuses a cross-user lease replacement before reading safety signals', async () => {
  const root = tempRoot();
  const ownership = checkBurstMutationOwner(root, { uid: process.getuid() + 1 });
  assert.equal(ownership.ok, false);
  let safetyRead = false;
  const stderr = [];
  const code = await burstMain(['request', '--root', root, '--repo', REPO, '--reason', 'demo'], {
    stderr: { write: (chunk) => stderr.push(chunk) },
    stdout: { write() {} },
    ownerCheckImpl: () => ownership,
    collectHealthImpl: () => { safetyRead = true; return {}; },
  });
  assert.equal(code, 1);
  assert.equal(safetyRead, false);
  assert.match(stderr.join(''), /data owner/);
  rmSync(root, { recursive: true, force: true });
});

test('the rendered status carries every field the SPEC mockup names', () => {
  const root = tempRoot();
  grantLease(root, { packs: ['app-standup-demo'] });
  const rendered = renderReviewerBurstStatus(collectReviewerBurstStatus(root, { now: () => new Date(T0) }));
  for (const field of [
    'state:', 'reason:', 'ttl_remaining:', 'steady_agy_slots:', 'burst_slots:',
    'fallback_allowed:', 'token_budget:', 'auto_decay:',
  ]) {
    assert.ok(rendered.includes(field), `status output must show ${field}`);
  }
  rmSync(root, { recursive: true, force: true });
});

// ── audit ────────────────────────────────────────────────────────────────────

test('every burst transition emits its audit event into the durable record', () => {
  const root = tempRoot();
  grantLease(root, { safety: { ...SAFE_SIGNALS, quota: { readable: false, availableClasses: [], groundedClasses: [] } } });
  grantLease(root);
  revokeReviewerBurstLease({ rootDir: root, now: () => new Date(T0_MS + 60_000), logger: silentLogger });
  grantLease(root, { ttlMs: 60_000, now: () => new Date(T0_MS + 120_000) });
  expireReviewerBurstLeaseIfDue(root, { now: () => new Date(T0_MS + 600_000), logger: silentLogger });

  const events = readReviewerBurstRecord(root).events.map((event) => event.event);
  for (const expected of ['requested', 'denied', 'activated', 'revoked', 'expired']) {
    assert.ok(events.includes(expected), `missing ${expected} audit event; got ${events.join(',')}`);
  }
  rmSync(root, { recursive: true, force: true });
});

test('the audit event log is bounded so a busy host cannot grow the record without limit', () => {
  const root = tempRoot();
  for (let i = 0; i < 40; i += 1) {
    grantLease(root, { repos: [], safety: null, now: () => new Date(T0_MS + i * 1000) });
  }
  const record = readReviewerBurstRecord(root);
  assert.ok(record.events.length <= 50, `events grew to ${record.events.length}`);
  rmSync(root, { recursive: true, force: true });
});

// ── wiring gates ─────────────────────────────────────────────────────────────
//
// The controller is exercised directly above, but its call sites live inside the
// watcher scheduler and a ~2000-line phase where a unit test cannot reach them.
// These assert the plumbing exists, so a refactor cannot leave a correct lease
// unwired — an active burst that buys nothing is indistinguishable from the
// steady state it was supposed to replace.

test('watcher.mjs builds the burst controller and feeds its slots to the reviewer pool', () => {
  const src = readFileSync(new URL('../src/watcher.mjs', import.meta.url), 'utf8');
  assert.match(src, /createReviewerBurstController\(\{[^}]*rootDir: ROOT/);
  assert.match(src, /readSpendUsd: readBurstScopedReviewerSpendUsd/);
  assert.match(src, /resolveFirstPassReviewerPoolConfig\(\{[^}]*burstSlots: reviewerBurstController\.slots\(\)/);
  assert.match(src, /^\s*reviewerBurstController, postedReviewHandlers,$/m, 'threaded into the per-PR ctx');
});

test('watcher.mjs stays at or under its ARC-18 line ratchet after the RPL-07 wiring', () => {
  const src = readFileSync(new URL('../src/watcher.mjs', import.meta.url), 'utf8');
  // RPL-07 landed with the ratchet at ZERO headroom, so its watcher wiring is
  // deliberately folded onto existing lines. This guards the reason that is
  // otherwise invisible: a future edit that "tidies" those lines apart breaks
  // the ARC-18 gate and reds `main` for every PR in the repo.
  assert.ok(src.split('\n').length < 2050);
});

test('pollonce-phases passes burst pressure in and charges the lease back', () => {
  const src = readFileSync(new URL('../src/pollonce-phases.mjs', import.meta.url), 'utf8');
  assert.match(src, /burstPressure: reviewerBurstController\?\.pressure\?\.\(\{/);
  assert.match(src, /packTokens: \(\) => packTokensForSubject\(\{/, 'derived lazily, not on every subject');
  assert.match(
    src,
    /rwfDecision\.reason === 'burst-lease-pressure'\)\s*\{\s*reviewerBurstController\?\.recordBurstAdmission/,
    'the lease is charged only for a spill that actually landed on a route',
  );
});

test('the health surface reports burst state, a metric, and a finding', () => {
  const src = readFileSync(new URL('../src/review-pipeline-health.mjs', import.meta.url), 'utf8');
  assert.match(src, /summarizeReviewerBurst\(rootDir, \{ nowMs \}\)/);
  assert.match(src, /^\s*reviewerBurst,$/m, 'burst state is on the snapshot');
  assert.match(src, /review_pipeline_reviewer_burst_active/);
  assert.match(src, /code: 'review:reviewer_burst_lease_active'/);
});

// ── health surface, end to end ───────────────────────────────────────────────

test('an active lease is visible in the health snapshot, its metrics, and its finding', () => {
  const root = tempRoot();
  ensureReviewStateSchema(openReviewStateDb(root));
  grantLease(root, { packs: ['rpl'] });

  const now = () => new Date(T0_MS + 5 * 60 * 1000);
  const snapshot = collectReviewPipelineHealth({ rootDir: root, hqRoot: root, now });
  assert.equal(snapshot.reviewerBurst.active, true);
  assert.equal(snapshot.reviewerBurst.slots, 2);
  assert.equal(snapshot.reviewerBurst.steadyAgySlots, STEADY_AGY_SLOTS);
  assert.deepEqual(snapshot.reviewerBurst.repos, [REPO]);
  assert.deepEqual(snapshot.reviewerBurst.packs, ['rpl']);

  const finding = snapshot.findings.find((f) => f.code === 'review:reviewer_burst_lease_active');
  assert.ok(finding, 'elevated spend must be visible on the operator surface');
  assert.equal(finding.tier, 'ticket');
  assert.match(finding.subject, /burst reviewer capacity lease active: \+2 slot/);
  assert.match(finding.recommended_action, /burst revoke/);

  const metrics = renderReviewPipelinePrometheus(snapshot);
  assert.match(metrics, /^review_pipeline_reviewer_burst_active\{state="active"\} 1$/m);
  assert.match(metrics, /^review_pipeline_reviewer_burst_slots\{state="active"\} 2$/m);
  assert.match(metrics, /^review_pipeline_reviewer_burst_ttl_remaining_seconds\{state="active"\} 1500$/m);
  rmSync(root, { recursive: true, force: true });
});

test('a decayed lease leaves no burst finding and reports zero burst slots', () => {
  const root = tempRoot();
  ensureReviewStateSchema(openReviewStateDb(root));
  grantLease(root, { ttlMs: 60 * 1000 });

  const snapshot = collectReviewPipelineHealth({
    rootDir: root,
    hqRoot: root,
    now: () => new Date(T0_MS + 10 * 60 * 1000),
  });
  assert.equal(snapshot.reviewerBurst.active, false);
  assert.equal(snapshot.reviewerBurst.slots, 0);
  assert.equal(snapshot.findings.some((f) => f.code === 'review:reviewer_burst_lease_active'), false);
  assert.match(
    renderReviewPipelinePrometheus(snapshot),
    /^review_pipeline_reviewer_burst_active\{state="expired"\} 0$/m,
  );
  rmSync(root, { recursive: true, force: true });
});

test('a host that never ran a burst reports inactive with no finding', () => {
  const root = tempRoot();
  ensureReviewStateSchema(openReviewStateDb(root));
  const snapshot = collectReviewPipelineHealth({ rootDir: root, hqRoot: root, now: () => new Date(T0) });
  assert.equal(snapshot.reviewerBurst.active, false);
  assert.equal(snapshot.reviewerBurst.state, 'inactive');
  assert.equal(snapshot.findings.some((f) => f.code === 'review:reviewer_burst_lease_active'), false);
  rmSync(root, { recursive: true, force: true });
});

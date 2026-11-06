import './helpers/registry-session-fixture.mjs';
import './helpers/load-aware-timeout-fixture.mjs';
// GEMINIREMEDIATE-01: Gemini is the always-on reviewer, so the remediator
// fallback's `reviews-next-round:gemini` refusal meant it could never
// remediate. Gemini now remediates when another reviewer model can take the
// next round, and every later review of that PR excludes Gemini. All fixtures
// are synthetic and offline.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GEMINI_REMEDIATED_HEAD_REASON,
  alternateReviewerForGeminiRemediation,
  geminiRemediatedReviewerExclusions,
  jobHasGeminiRemediation,
} from '../src/gemini-remediated-head.mjs';
import {
  nextRoundReviewerModels,
  remediatorFallbackAudit,
  resolveClaimedRemediatorRouting,
  resolveRemediationWorkerClassWithFallback,
} from '../src/remediation-worker-class-fallback.mjs';
import { afhReviewerFallbackDecision, geminiFallbackEligibility } from '../src/afh-reviewer-fallback.mjs';
import { applyGeminiReviewerRoute, routeSubject } from '../src/adapters/subject/github-pr/routing.mjs';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const HERMETIC = { topPath: '/dev/null' };
const OPENAI_CAPPED = { provider: 'openai', authPath: 'oauth', state: 'exhausted', resetAtUtc: '2026-11-09T00:00:00.000Z' };
const OPENAI_OK = { provider: 'openai', authPath: 'oauth', state: 'ok' };
const ANTHROPIC_OK = { provider: 'anthropic', authPath: 'oauth', state: 'ok' };
const ANTHROPIC_CAPPED = { provider: 'anthropic', authPath: 'oauth', state: 'exhausted', resetAtUtc: '2026-11-09T00:00:00.000Z' };
const GOOGLE_OK = { provider: 'google', authPath: 'agy', state: 'ok' };

const fleet = (rows) => async () => ({ stdout: JSON.stringify({ providerStatuses: rows }) });

function resolveWith({ builderTag, rows, reviewerModels, primary = 'codex', fallbackWorkerClasses = ['gemini', 'claude-code'] }) {
  return resolveRemediationWorkerClassWithFallback({
    codexAccountPolicy: 'pinned', primary, fallbackWorkerClasses, reviewerModels, nowMs: NOW,
    job: { builderTag, reviewerModel: 'gemini' },
    execFileImpl: fleet(rows),
  });
}

// ── remediator side ──────────────────────────────────────────────────────────

test('codex capped and gemini always-on: gemini remediates and the next round is reviewed by claude', async () => {
  // [codex]-built PR: claude is its cross-model reviewer, gemini the always-on one.
  const result = await resolveWith({
    builderTag: 'codex', rows: [OPENAI_CAPPED, ANTHROPIC_OK, GOOGLE_OK], reviewerModels: ['gemini', 'claude'],
    fallbackWorkerClasses: ['gemini'],
  });
  assert.equal(result.workerClass, 'gemini');
  assert.equal(result.fellBack, true);
  assert.equal(result.hold, false);
  assert.equal(result.reviewerReassignment.from, 'gemini');
  assert.equal(result.reviewerReassignment.to, 'claude');
  assert.equal(result.reviewerReassignment.reason, GEMINI_REMEDIATED_HEAD_REASON);
  assert.equal(result.reviewerReassignment.builderClass, 'codex');
  assert.deepEqual(result.skipped, []);
  // The decision is written to the worker audit, where a later round reads why.
  assert.deepEqual(remediatorFallbackAudit(result).reviewerReassignment, result.reviewerReassignment);
});

test('the claim-time path selects gemini end to end with the always-on route in force', async () => {
  const warnings = [];
  const env = { AGENT_OS_REVIEWER_GEMINI_MODE: 'always-on', AGENT_OS_ROLES_REMEDIATOR_FALLBACK: 'gemini' };
  const job = { builderTag: 'codex', reviewerModel: 'gemini' };
  // Always-on makes gemini the only next-round reviewer: the case that used to refuse.
  assert.deepEqual(nextRoundReviewerModels(job, { env, ...HERMETIC }), ['gemini']);
  const routing = await resolveClaimedRemediatorRouting({
    job, primary: 'codex', env, nowMs: NOW, ...HERMETIC, log: { warn: (line) => warnings.push(line) },
    resolveImpl: (args) => resolveRemediationWorkerClassWithFallback({
      // Pinned: this fixture is about the next-round rule, not Codex account order.
      ...args, codexAccountPolicy: 'pinned', execFileImpl: fleet([OPENAI_CAPPED, ANTHROPIC_OK, GOOGLE_OK]),
    }),
  });
  assert.equal(routing.workerClass, 'gemini');
  assert.equal(routing.reviewerReassignment.to, 'claude');
  assert.ok(warnings.some((line) => /reviewer-reassignment: gemini remediates .*gemini -> claude \(gemini-remediated-head\)/.test(line)));
});

test('a [claude-code] build whose only alternate reviewer (codex) is capped keeps the refusal and says why', async () => {
  const result = await resolveWith({
    builderTag: 'claude-code', rows: [OPENAI_CAPPED, ANTHROPIC_OK, GOOGLE_OK], reviewerModels: ['gemini', 'codex'],
    fallbackWorkerClasses: ['gemini'],
  });
  assert.equal(result.hold, true);
  assert.equal(result.reason, 'no-available-fallback');
  assert.equal(result.reviewerReassignment, undefined);
  assert.deepEqual(result.skipped, [{ workerClass: 'gemini', reason:
    'reviews-next-round:gemini;no-alternate-reviewer:claude=builder-family,codex=capped:provider-grounded' }]);
});

test('a [codex] build whose alternate reviewer (claude) is capped keeps the refusal and says why', async () => {
  const result = await resolveWith({
    builderTag: 'codex', rows: [OPENAI_CAPPED, ANTHROPIC_CAPPED, GOOGLE_OK], reviewerModels: ['gemini', 'claude'],
    fallbackWorkerClasses: ['gemini'],
  });
  assert.equal(result.hold, true);
  assert.deepEqual(result.skipped, [{ workerClass: 'gemini', reason:
    'reviews-next-round:gemini;no-alternate-reviewer:claude=capped:provider-grounded,codex=builder-family' }]);
});

test('claude-code stays refused behind gemini when claude would review the next round (no new waiver)', async () => {
  const result = await resolveWith({
    builderTag: 'codex', rows: [OPENAI_CAPPED, ANTHROPIC_OK, GOOGLE_OK], reviewerModels: ['gemini', 'claude'],
    fallbackWorkerClasses: ['claude-code'],
  });
  assert.equal(result.hold, true);
  assert.deepEqual(result.skipped, [{ workerClass: 'claude-code', reason: 'reviews-next-round:claude' }]);
});

test('without a builder to judge the alternate by, today\'s refusal is unchanged', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({
    codexAccountPolicy: 'pinned', primary: 'codex', fallbackWorkerClasses: ['gemini'],
    reviewerModels: ['gemini'], nowMs: NOW, execFileImpl: fleet([OPENAI_CAPPED, GOOGLE_OK]),
  });
  assert.equal(result.hold, true);
  assert.deepEqual(result.skipped, [{ workerClass: 'gemini', reason: 'reviews-next-round:gemini' }]);
});

test('non-capped behaviour is unchanged: the routed primary keeps the job and no reviewer moves', async () => {
  const result = await resolveWith({
    builderTag: 'codex', rows: [OPENAI_OK, ANTHROPIC_OK, GOOGLE_OK], reviewerModels: ['gemini', 'claude'],
    fallbackWorkerClasses: ['gemini'],
  });
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.fellBack, false);
  assert.equal(result.reviewerReassignment, undefined);
  assert.equal(remediatorFallbackAudit(result).reviewerReassignment, undefined);
});

test('an unreadable fleet status leaves the alternate unverified, so gemini stays selectable', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({
    codexAccountPolicy: 'pinned', primary: 'codex', fallbackWorkerClasses: ['gemini'], reviewerModels: ['gemini', 'claude'],
    nowMs: NOW, job: { builderTag: 'codex', reviewerModel: 'gemini', remediationPlan: { retryHistory: [{
      round: 1, requeuedAt: '2026-11-06T10:00:00.000Z',
      retryMetadata: { code: 'quota-exhausted', harness: 'codex', resetAt: '2026-11-09T00:00:00.000Z',
        providerResetAt: '2026-11-09T00:00:00.000Z', source: 'provider-reported', maxUnvalidatedHoldMs: 3600000 },
      worker: { model: 'codex', state: 'spawned' } }] } },
    execFileImpl: async () => { throw new Error('hq unavailable'); },
  });
  assert.equal(result.workerClass, 'gemini');
  assert.equal(result.reviewerReassignment.to, 'claude');
});

test('alternate selection: corporate Claude counts, an unverified corporate account does not', () => {
  const cap = (table) => (harness) => table[harness] || { available: null };
  assert.equal(alternateReviewerForGeminiRemediation({ builderClass: 'codex', capOf: cap({
    'claude-code': { capped: true, capSource: 'provider-grounded', available: false },
    'remediator-claude-corp': { capped: false, available: true },
  }) }).available, true);
  assert.equal(alternateReviewerForGeminiRemediation({ builderClass: 'codex', capOf: cap({
    'claude-code': { capped: true, capSource: 'provider-grounded', available: false },
  }) }).available, false);
  assert.equal(alternateReviewerForGeminiRemediation({ builderClass: 'gemini', capOf: cap({}) }).reviewerModel, 'claude');
  assert.equal(alternateReviewerForGeminiRemediation({ builderClass: 'unknown-tool', capOf: cap({}) }).reason, 'unknown-builder-class');
});

// ── review side ──────────────────────────────────────────────────────────────

const route = (builderClass, options = {}) => routeSubject({ builderClass }, {
  env: { AGENT_OS_REVIEWER_GEMINI_MODE: 'always-on', ...(options.env || {}) }, ...HERMETIC, ...options,
});

test('an always-on route reviews with gemini until gemini remediates, then reviews with the cross-model reviewer', () => {
  assert.equal(route('codex').reviewerModel, 'gemini');
  assert.equal(route('claude-code').reviewerModel, 'gemini');
  const reassigned = route('codex', { excludedReviewerModels: ['gemini'] });
  assert.equal(reassigned.reviewerModel, 'claude');
  assert.equal(reassigned.botTokenEnv, 'GH_CLAUDE_REVIEWER_TOKEN');
  assert.deepEqual(reassigned.reviewerReassignment, {
    from: 'gemini', to: 'claude', reason: GEMINI_REMEDIATED_HEAD_REASON, mode: 'always-on',
  });
  assert.equal(route('claude-code', { excludedReviewerModels: ['gemini'] }).reviewerModel, 'codex');
  assert.equal(route('codex', { excludedReviewerModels: ['gemini'] }).geminiReviewerSelection, undefined);
});

test('fallback mode reassigns only when gemini would have been selected', () => {
  const env = { AGENT_OS_REVIEWER_GEMINI_MODE: 'fallback' };
  assert.equal(route('codex', { env, excludedReviewerModels: ['gemini'] }).reviewerReassignment, undefined);
  const capped = route('codex', { env, excludedReviewerModels: ['gemini'], primaryReviewerQuotaCapped: true });
  assert.equal(capped.reviewerModel, 'claude');
  assert.equal(capped.reviewerReassignment.mode, 'fallback');
});

test('an operator gemini pin cannot put gemini back on a head it remediated', () => {
  const env = { AGENT_OS_ROLES_REVIEWER: 'gemini' };
  assert.equal(route('codex', { env }).reviewerModel, 'gemini');
  const pinned = route('codex', { env, excludedReviewerModels: ['gemini'] });
  assert.equal(pinned.reviewerModel, 'claude');
  assert.equal(pinned.reviewerReassignment.reason, GEMINI_REMEDIATED_HEAD_REASON);
});

test('the gemini-never-reviews-gemini guard still holds, with or without the exclusion', () => {
  for (const excludedReviewerModels of [[], ['gemini']]) {
    const built = route('gemini', { env: { AGENT_OS_ROLES_REVIEWER: 'gemini' }, excludedReviewerModels });
    assert.equal(built.reviewerModel, 'codex');
    assert.equal(built.geminiIntegrityGuard.blockedReviewerModel, 'gemini');
    assert.equal(route('gemini', { excludedReviewerModels }).reviewerModel, 'codex');
  }
  const guarded = applyGeminiReviewerRoute({
    builderClass: 'gemini', mode: 'always-on',
    baseRoute: { builderClass: 'gemini', reviewerModel: 'gemini', botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN' },
  });
  assert.equal(guarded.reviewerModel, 'codex');
});

test('routes without an exclusion are byte-identical to the previous behaviour', () => {
  for (const builderClass of ['codex', 'claude-code', 'clio-agent', 'gemini']) {
    assert.deepEqual(route(builderClass, { excludedReviewerModels: [] }), route(builderClass));
    assert.equal(route(builderClass).excludedReviewerModels, undefined);
    assert.equal(route(builderClass).reviewerReassignment, undefined);
  }
});

test('the AFH fallback never selects gemini for a head gemini remediated', () => {
  const excluded = route('codex', { excludedReviewerModels: ['gemini'] });
  assert.deepEqual(excluded.excludedReviewerModels, ['gemini']);
  assert.deepEqual(geminiFallbackEligibility({ builderClass: 'codex', geminiReviewerMode: 'always-on',
    excludedReviewerModels: ['gemini'] }), { eligible: false, reason: 'gemini-remediated-head' });
  assert.equal(geminiFallbackEligibility({ builderClass: 'codex', geminiReviewerMode: 'always-on' }).eligible, true);
  const grounding = { available: true, providers: { anthropic: { state: 'exhausted', hardGrounded: true } } };
  const decision = afhReviewerFallbackDecision({
    builderClass: 'codex', baseRoute: excluded, grounding, geminiReviewerMode: 'always-on',
  });
  assert.equal(decision.considered.find((entry) => entry.reviewerModel === 'gemini')?.selected ?? false, false);
  assert.notEqual(decision.to, 'gemini');
});

// ── the marker both sides share ──────────────────────────────────────────────

test('only a gemini worker that actually ran marks the PR', () => {
  assert.equal(jobHasGeminiRemediation({ remediationWorker: { workerClass: 'gemini', spawnedAt: '2026-11-06T11:00:00.000Z' } }), true);
  assert.equal(jobHasGeminiRemediation({ remediationWorker: { model: 'remediator-gemini', spawnedAt: 'x' } }), true);
  assert.equal(jobHasGeminiRemediation({ remediationPlan: { rounds: [
    { worker: { workerClass: 'codex', spawnedAt: 'x' } }, { worker: { workerClass: 'gemini', spawnedAt: 'y' } },
  ] } }), true);
  assert.equal(jobHasGeminiRemediation({ remediationWorker: { workerClass: 'gemini' } }), false, 'held before spawn');
  assert.equal(jobHasGeminiRemediation({ remediationWorker: { workerClass: 'codex', spawnedAt: 'x' } }), false);
  assert.equal(jobHasGeminiRemediation({}), false);
});

test('exclusions come from any job state of the PR and fail closed on an unreadable store', () => {
  const geminiJob = { remediationWorker: { workerClass: 'gemini', spawnedAt: 'x' } };
  const byState = (state) => (_root, key) => (key === state ? [{ job: geminiJob }] : []);
  assert.deepEqual(geminiRemediatedReviewerExclusions({ rootDir: '/x', repo: 'o/r', prNumber: 1, listJobsImpl: byState('completed') }), ['gemini']);
  assert.deepEqual(geminiRemediatedReviewerExclusions({ rootDir: '/x', repo: 'o/r', prNumber: 1, listJobsImpl: byState('inProgress') }), ['gemini']);
  assert.deepEqual(geminiRemediatedReviewerExclusions({ rootDir: '/x', repo: 'o/r', prNumber: 1, listJobsImpl: () => [] }), []);
  const warnings = [];
  assert.deepEqual(geminiRemediatedReviewerExclusions({
    rootDir: '/x', repo: 'o/r', prNumber: 1, log: { warn: (line) => warnings.push(line) },
    listJobsImpl: () => { throw new Error('corrupt job file'); },
  }), ['gemini']);
  assert.match(warnings[0], /gemini-remediated-head check failed for o\/r#1/);
});

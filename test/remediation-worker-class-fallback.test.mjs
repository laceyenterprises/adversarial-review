import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  nextRoundReviewerModels,
  remediatorFallbackAudit,
  resolveClaimedRemediatorRouting,
  resolveRemediationWorkerClassWithFallback,
  remediationWorkerClassFallback,
} from '../src/remediation-worker-class-fallback.mjs';

function fleetStatusStub(rows) {
  // Shape parsed by parseHqFleetQuotaStatus: { providerStatuses: [{provider, authPath, state}] }
  const stdout = JSON.stringify({ providerStatuses: rows });
  return async () => ({ stdout });
}

const CODEX_EXHAUSTED_CLAUDE_OK = [
  { provider: 'openai', authPath: 'oauth', state: 'exhausted' },
  { provider: 'anthropic', authPath: 'oauth', state: 'ok' },
];
const CODEX_OK = [
  { provider: 'openai', authPath: 'oauth', state: 'ok' },
  { provider: 'anthropic', authPath: 'oauth', state: 'ok' },
];

test('falls back codex -> claude-code when the routed codex harness provider is exhausted', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: fleetStatusStub(CODEX_EXHAUSTED_CLAUDE_OK),
  });
  assert.equal(result.workerClass, 'claude-code');
  assert.equal(result.fellBack, true);
  assert.equal(result.reason, 'primary-grounded-fallback');
  assert.equal(result.primaryState, 'exhausted');
});

test('keeps the routed codex harness when codex has quota (auto-revert on recovery)', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: fleetStatusStub(CODEX_OK),
  });
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.fellBack, false);
  assert.equal(result.reason, 'primary-available');
});

test('never grounds on a soft/unknown signal (does not fall back when codex is only degraded)', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: fleetStatusStub([
      { provider: 'openai', authPath: 'oauth', state: 'degraded' },
      { provider: 'anthropic', authPath: 'oauth', state: 'ok' },
    ]),
  });
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.fellBack, false);
});

test('no fallback configured -> keeps the primary', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({
    primary: 'codex',
    fallbackWorkerClasses: [],
    execFileImpl: fleetStatusStub(CODEX_EXHAUSTED_CLAUDE_OK),
  });
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.fellBack, false);
  assert.equal(result.reason, 'no-fallback-configured');
});

test('fail-open: an unreadable fleet-quota status keeps the primary (never guesses a cap)', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: async () => {
      throw new Error('hq unavailable');
    },
  });
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.fellBack, false);
  assert.equal(result.reason, 'fleet-quota-status-unavailable');
});

// Hermetic config cascade: the checked-in module config.yaml plus no top-level
// file, so the host's ~/agent-os/config.yaml cannot leak into the fallback list.
const HERMETIC_CONFIG = { topPath: '/dev/null' };

test('falls back claude-code -> codex when Claude is grounded and Codex is available', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({
    primary: 'claude-code',
    fallbackWorkerClasses: remediationWorkerClassFallback({}, HERMETIC_CONFIG),
    execFileImpl: fleetStatusStub([
      { provider: 'openai', authPath: 'oauth', state: 'ok' },
      { provider: 'anthropic', authPath: 'oauth', state: 'exhausted' },
    ]),
  });
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.fellBack, true);
  assert.equal(result.primaryState, 'exhausted');
});

test('remediationWorkerClassFallback reads the declared roles.remediator_fallback and honors the env aliases', () => {
  assert.deepEqual(remediationWorkerClassFallback({}, HERMETIC_CONFIG), ['claude-code', 'codex']);
  assert.deepEqual(
    remediationWorkerClassFallback(
      { ADVERSARIAL_REVIEW_REMEDIATOR_WORKER_CLASS_FALLBACK: 'claude-code, gemini' },
      HERMETIC_CONFIG,
    ),
    ['claude-code', 'gemini'],
  );
  assert.deepEqual(
    remediationWorkerClassFallback({ AGENT_OS_ROLES_REMEDIATOR_FALLBACK: 'gemini' }, HERMETIC_CONFIG),
    ['gemini'],
  );
  assert.deepEqual(
    remediationWorkerClassFallback({ ADVERSARIAL_REVIEW_REMEDIATOR_WORKER_CLASS_FALLBACK: '' }, HERMETIC_CONFIG),
    [],
  );
});

test('the fallback list is config, never a code constant: a declared order is returned verbatim', () => {
  const declared = remediationWorkerClassFallback({}, {
    loaderImpl: () => ({ get: (key) => (key === 'roles.remediator_fallback' ? ['gemini', 'claude-code', 'gemini'] : undefined) }),
  });
  assert.deepEqual(declared, ['gemini', 'claude-code']);
});

// ── REMFALLBACK-01: model-level, AFH soft, and job-local cap evidence ─────────

const NOW = Date.parse('2026-09-29T02:45:15.389Z');
const CODEX_MODEL = 'gpt-6-sol';
const modelForClass = (workerClass) => (workerClass === 'codex' ? CODEX_MODEL : null);

// The live agent-os#7325 shape (2026-09-29): gpt-6-sol exhausted until
// 2026-10-04, projected onto the provider row as `unknown` + model_only_exhaustion.
const OPENAI_MODEL_ONLY_EXHAUSTION = {
  provider: 'openai',
  authPath: 'oauth',
  state: 'unknown',
  lastErrorSignature: 'model_only_exhaustion',
  lastGoodAt: '2026-09-27T12:52:00.000Z',
  models: [
    { model: CODEX_MODEL, state: 'exhausted', resetAtUtc: '2026-10-04T12:52:00.000Z', lastGoodAt: '2026-09-27T12:52:00.000Z' },
  ],
};
const ANTHROPIC_OK = { provider: 'anthropic', authPath: 'oauth', state: 'ok', lastGoodAt: '2026-09-29T02:40:00.000Z' };

// A job whose last codex attempt hit the weekly cap: the retry entry the
// reconcile quota hold writes, as found on the live #7325 job.
function jobHeldOnCodex({ providerResetAt, requeuedAt = '2026-09-29T01:45:15.389Z', extra = {} } = {}) {
  return {
    builderTag: 'claude-code',
    reviewerModel: 'gemini',
    remediationPlan: {
      retryHistory: [{
        round: 1,
        requeuedAt,
        retryAfter: '2026-09-29T02:45:15.389Z',
        retryMetadata: {
          code: 'quota-exhausted',
          harness: 'codex',
          resetAt: providerResetAt,
          providerResetAt,
          source: 'provider-reported',
          maxUnvalidatedHoldMs: 3600000,
        },
        worker: { model: 'codex', state: 'spawned' },
      }],
    },
    ...extra,
  };
}

test('model_only_exhaustion of the routed codex model counts as capped (provider reads unknown)', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code', 'codex'],
    nowMs: NOW,
    modelForClass,
    execFileImpl: fleetStatusStub([OPENAI_MODEL_ONLY_EXHAUSTION, ANTHROPIC_OK]),
  });
  assert.equal(result.workerClass, 'claude-code');
  assert.equal(result.fellBack, true);
  assert.equal(result.capSource, 'model-exhausted');
  assert.equal(result.primaryState, 'unknown');
  assert.equal(result.resetAt, '2026-10-04T12:52:00.000Z');
});

test('the model_only_exhaustion signature caps codex even when the payload carries no models[] rows', async () => {
  const signatureOnly = { ...OPENAI_MODEL_ONLY_EXHAUSTION };
  delete signatureOnly.models;
  const result = await resolveRemediationWorkerClassWithFallback({
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    nowMs: NOW,
    execFileImpl: fleetStatusStub([signatureOnly, ANTHROPIC_OK]),
  });
  assert.equal(result.workerClass, 'claude-code');
  assert.equal(result.capSource, 'model-exhausted');
});

test('a provider projected ok still caps codex when its routed model row is exhausted', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    nowMs: NOW,
    modelForClass,
    execFileImpl: fleetStatusStub([
      {
        provider: 'openai',
        authPath: 'oauth',
        state: 'ok',
        models: [
          { model: CODEX_MODEL, state: 'exhausted', resetAtUtc: '2026-10-04T12:52:00.000Z' },
          { model: 'gpt-6-mini', state: 'ok' },
        ],
      },
      ANTHROPIC_OK,
    ]),
  });
  assert.equal(result.workerClass, 'claude-code');
  assert.equal(result.capSource, 'model-exhausted');
});

test('another model being exhausted does not cap a routed model whose own row is ok', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    nowMs: NOW,
    modelForClass,
    execFileImpl: fleetStatusStub([
      {
        provider: 'openai',
        authPath: 'oauth',
        state: 'ok',
        models: [
          { model: CODEX_MODEL, state: 'ok' },
          { model: 'gpt-6-mini', state: 'exhausted' },
        ],
      },
      ANTHROPIC_OK,
    ]),
  });
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.fellBack, false);
  assert.equal(result.reason, 'primary-available');
});

test('AFH soft grounding re-routes the remediator (the lane now sees AFH-02)', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    nowMs: NOW,
    execFileImpl: fleetStatusStub([
      {
        provider: 'openai',
        authPath: 'oauth',
        state: 'unknown',
        afhGrounding: { grounded: true, signals: 4, threshold: 3, reason: 'quota_exhausted_kills' },
      },
      ANTHROPIC_OK,
    ]),
  });
  assert.equal(result.workerClass, 'claude-code');
  assert.equal(result.fellBack, true);
  assert.equal(result.capSource, 'afh-soft-grounded');
});

test('a soft-grounded candidate is never the fallback: capped primary with no other class holds', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    nowMs: NOW,
    execFileImpl: fleetStatusStub([
      { provider: 'openai', authPath: 'oauth', state: 'exhausted' },
      { provider: 'anthropic', authPath: 'oauth', state: 'ok', afhGrounding: { grounded: true, signals: 3, threshold: 3 } },
    ]),
  });
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.fellBack, false);
  assert.equal(result.hold, true);
  assert.equal(result.reason, 'no-available-fallback');
  assert.deepEqual(result.skipped, [{ workerClass: 'claude-code', reason: 'capped:afh-soft-grounded' }]);
});

test('job-local evidence: a provider reset 5 days out caps codex even when fleet status is unreadable', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code', 'codex'],
    job: jobHeldOnCodex({ providerResetAt: '2026-10-04T12:52:00.000Z' }),
    nowMs: NOW,
    execFileImpl: async () => {
      throw new Error('session-ledger runtime open failed');
    },
  });
  assert.equal(result.workerClass, 'claude-code');
  assert.equal(result.fellBack, true);
  assert.equal(result.capSource, 'provider-reset-past-hold-window');
  assert.equal(result.resetAt, '2026-10-04T12:52:00.000Z');
  assert.equal(result.candidateState, 'unverified');
});

test('job-local evidence: a good probe after the hold clears it (cap lifted early, codex returns)', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    job: jobHeldOnCodex({ providerResetAt: '2026-10-04T12:52:00.000Z' }),
    nowMs: NOW,
    modelForClass,
    execFileImpl: fleetStatusStub([
      {
        provider: 'openai',
        authPath: 'oauth',
        state: 'ok',
        lastGoodAt: '2026-09-29T02:30:00.000Z',
        models: [{ model: CODEX_MODEL, state: 'ok', lastGoodAt: '2026-09-29T02:30:00.000Z' }],
      },
      ANTHROPIC_OK,
    ]),
  });
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.fellBack, false);
  assert.equal(result.reason, 'primary-available');
});

test('job-local evidence: an ok probe from BEFORE the hold does not clear it', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    job: jobHeldOnCodex({ providerResetAt: '2026-10-04T12:52:00.000Z' }),
    nowMs: NOW,
    execFileImpl: fleetStatusStub([
      { provider: 'openai', authPath: 'oauth', state: 'ok', lastGoodAt: '2026-09-29T01:00:00.000Z' },
      ANTHROPIC_OK,
    ]),
  });
  assert.equal(result.workerClass, 'claude-code');
  assert.equal(result.capSource, 'provider-reset-past-hold-window');
});

test('job-local evidence: a reset that has passed is no evidence (codex is routed again)', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    job: jobHeldOnCodex({ providerResetAt: '2026-09-29T02:30:00.000Z' }),
    nowMs: NOW,
    execFileImpl: null,
  });
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.fellBack, false);
  assert.equal(result.hold, false);
});

test('a candidate with its own job-local cap is skipped', async () => {
  const job = jobHeldOnCodex({ providerResetAt: '2026-10-04T12:52:00.000Z' });
  job.remediationPlan.retryHistory.push({
    round: 1,
    requeuedAt: '2026-09-29T02:00:00.000Z',
    retryMetadata: { code: 'quota-exhausted', harness: 'claude', providerResetAt: '2026-10-01T00:00:00.000Z' },
    worker: { model: 'claude-code' },
  });
  const result = await resolveRemediationWorkerClassWithFallback({
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    job,
    nowMs: NOW,
    execFileImpl: null,
  });
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.hold, true);
  assert.deepEqual(result.skipped, [{ workerClass: 'claude-code', reason: 'capped:provider-reset-past-hold-window' }]);
});

test('remediatorFallbackAudit records fallbackFrom and the reason, and nothing when the routed class ran', async () => {
  const fellBack = await resolveRemediationWorkerClassWithFallback({
    primary: 'codex',
    fallbackWorkerClasses: ['claude-code'],
    nowMs: NOW,
    modelForClass,
    execFileImpl: fleetStatusStub([OPENAI_MODEL_ONLY_EXHAUSTION, ANTHROPIC_OK]),
  });
  const audit = remediatorFallbackAudit(fellBack);
  assert.equal(audit.fallbackFrom, 'codex');
  assert.equal(audit.fallbackReason, 'model-exhausted');
  assert.equal(audit.fallbackResolution.reason, 'primary-grounded-fallback');
  assert.equal(audit.fallbackResolution.resetAt, '2026-10-04T12:52:00.000Z');
  assert.equal(audit.fallbackResolution.candidateState, 'ok');
  assert.deepEqual(remediatorFallbackAudit({ workerClass: 'codex', fellBack: false }), {});
});

test('resolveClaimedRemediatorRouting reads the declared list and, unwired, uses job-local evidence only', async () => {
  const warnings = [];
  const routing = await resolveClaimedRemediatorRouting({
    job: jobHeldOnCodex({ providerResetAt: '2026-10-04T12:52:00.000Z' }),
    primary: 'codex',
    env: {},
    nowMs: NOW,
    topPath: '/dev/null',
    log: { warn: (line) => warnings.push(line) },
  });
  assert.equal(routing.workerClass, 'claude-code');
  assert.equal(routing.fellBack, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /routed=codex -> claude-code .*provider-reset-past-hold-window, resets 2026-10-04T12:52:00.000Z/);

  // `[]` declared: no class can take it, so the capped primary holds.
  const disabled = await resolveClaimedRemediatorRouting({
    job: jobHeldOnCodex({ providerResetAt: '2026-10-04T12:52:00.000Z' }),
    primary: 'codex',
    env: { AGENT_OS_ROLES_REMEDIATOR_FALLBACK: '' },
    nowMs: NOW,
    topPath: '/dev/null',
    log: { warn() {} },
  });
  assert.equal(disabled.workerClass, 'codex');
  assert.equal(disabled.hold, true);
  assert.equal(disabled.reason, 'no-fallback-configured');
});

// ── REMFALLBACK-01 item 4: cross-model review stays intact ───────────────────

const GOOGLE_OK = { provider: 'google', authPath: 'agy', state: 'ok' };

test('a fallback whose model family reviews the next round is skipped (reviewer-selection rule)', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({
    primary: 'codex',
    fallbackWorkerClasses: ['gemini', 'claude-code'],
    reviewerModels: ['gemini', 'codex'],
    nowMs: NOW,
    execFileImpl: fleetStatusStub([
      { provider: 'openai', authPath: 'oauth', state: 'exhausted' },
      ANTHROPIC_OK,
      GOOGLE_OK,
    ]),
  });
  assert.equal(result.workerClass, 'claude-code');
  assert.equal(result.fellBack, true);
  assert.deepEqual(result.skipped, [{ workerClass: 'gemini', reason: 'reviews-next-round:gemini' }]);
});

test('claude-code is refused as a fallback when claude reviews the PR (codex-built PR)', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({
    primary: 'gemini',
    fallbackWorkerClasses: ['claude-code', 'codex'],
    reviewerModels: ['claude'],
    nowMs: NOW,
    execFileImpl: fleetStatusStub([
      { provider: 'google', authPath: 'agy', state: 'exhausted' },
      ANTHROPIC_OK,
      { provider: 'openai', authPath: 'oauth', state: 'ok' },
    ]),
  });
  assert.equal(result.workerClass, 'codex');
  assert.deepEqual(result.skipped, [{ workerClass: 'claude-code', reason: 'reviews-next-round:claude' }]);
});

test('with only same-model-as-reviewer fallbacks left, the capped remediator holds instead', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({
    primary: 'codex',
    fallbackWorkerClasses: ['gemini'],
    reviewerModels: ['gemini'],
    nowMs: NOW,
    execFileImpl: fleetStatusStub([{ provider: 'openai', authPath: 'oauth', state: 'exhausted' }, GOOGLE_OK]),
  });
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.fellBack, false);
  assert.equal(result.hold, true);
  assert.equal(result.reason, 'no-available-fallback');
});

test('nextRoundReviewerModels combines the last reviewer with the builder route, with and without the gemini fallback layer', () => {
  const hermetic = { topPath: '/dev/null' };
  // agent-os#7325: [claude-code] PR, reviewed by gemini while codex was capped.
  assert.deepEqual(
    nextRoundReviewerModels({ builderTag: 'claude-code', reviewerModel: 'gemini' }, { env: {}, ...hermetic }).sort(),
    ['codex', 'gemini'],
  );
  assert.deepEqual(
    nextRoundReviewerModels({ builderTag: 'codex', reviewerModel: 'claude' }, { env: {}, ...hermetic }),
    ['claude'],
  );
  assert.deepEqual(
    nextRoundReviewerModels(
      { builderTag: 'codex', reviewerModel: 'claude' },
      { env: { AGENT_OS_REVIEWER_GEMINI_MODE: 'fallback' }, ...hermetic },
    ).sort(),
    ['claude', 'gemini'],
  );
  // An operator reviewer pin is the route reviewer selection would use.
  assert.deepEqual(
    nextRoundReviewerModels(
      { builderTag: 'codex', reviewerModel: 'claude' },
      { env: { AGENT_OS_ROLES_REVIEWER: 'gemini' }, ...hermetic },
    ).sort(),
    ['claude', 'gemini'],
  );
  // No builder tag: the recorded reviewer is the whole constraint.
  assert.deepEqual(nextRoundReviewerModels({ reviewerModel: 'codex' }, { env: {}, ...hermetic }), ['codex']);
});

test('claim-time routing applies the rule: a declared gemini fallback is passed over while gemini reviews', async () => {
  const routing = await resolveClaimedRemediatorRouting({
    job: jobHeldOnCodex({ providerResetAt: '2026-10-04T12:52:00.000Z' }),
    primary: 'codex',
    env: { AGENT_OS_ROLES_REMEDIATOR_FALLBACK: 'gemini,claude-code' },
    nowMs: NOW,
    topPath: '/dev/null',
    log: { warn() {} },
  });
  assert.equal(routing.workerClass, 'claude-code');
  assert.deepEqual(routing.skipped, [{ workerClass: 'gemini', reason: 'reviews-next-round:gemini' }]);
});

// AFH-04 — reviewer ordered fallback: codex-reviewer → gemini-reviewer →
// claude-reviewer (LAST RESORT).
//
// The contract under test (SPEC §3 AFH-04 / §6 diversity-collapse mitigation):
//   1. a grounded primary reviewer (hard OR AFH-02 soft) routes to gemini;
//   2. claude-reviewer is selected ONLY when the primary AND gemini are both
//      grounded — a `[claude-code]`-built PR is never claude-reviewed while
//      gemini is available;
//   3. all providers ok → the configured primary, no fallback;
//   4. every failure mode of the `hq fleet quota status --json` read (throw,
//      non-zero exit, timeout, malformed JSON, missing `afhGrounding`) either
//      retries/stale-serves a recent good snapshot or fails open to the
//      configured route with no uncaught exception;
//   5. when the provider un-grounds, the next attempt returns to the primary.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AFH_REVIEWER_MODEL_PROVIDER,
  AFH_FLEET_QUOTA_STATUS_RETRY_TIMEOUT_FRACTION,
  afhGroundingSnapshotFromStdout,
  afhReviewerFallbackDecision,
  applyAfhReviewerFallback,
  createAfhReviewerGroundingCache,
  describeAfhReviewerFallback,
  geminiFallbackEligibility,
  providerForReviewerModel,
  readAfhReviewerGrounding,
  reviewerModelGrounding,
} from '../src/afh-reviewer-fallback.mjs';
import { applyGeminiReviewerRoute, routeSubject } from '../src/adapters/subject/github-pr/routing.mjs';
import { selectReviewerRouteForAttempt } from '../src/reviewer-route-selection.mjs';
import { parseHqFleetQuotaStatus } from '../src/fleet-quota-status.mjs';

const HERMETIC = { env: {}, topPath: '/dev/null' };

function baseRouteFor(builderClass) {
  return routeSubject({ builderClass }, { ...HERMETIC, geminiReviewerMode: 'off' });
}

// Route as the watcher builds it: cross-model base + the gemini layer.
function effectiveRouteFor(builderClass, mode = 'off') {
  return applyGeminiReviewerRoute({
    builderClass,
    baseRoute: baseRouteFor(builderClass),
    mode,
  });
}

const OK = { state: 'ok', grounded: false, reason: 'below_threshold', signals: 0 };

// Build an `hq fleet quota status --json` payload. `spec` maps provider →
// { state, grounded, reason, signals } (hard state + AFH-02 soft verdict), or
// `null` to emit a row with NO `afhGrounding` key at all (the pre-AFH-02 / ledger
// -read-failure shape).
function fleetStatusJson(spec) {
  return JSON.stringify({
    providerStatuses: Object.entries(spec).map(([provider, entry]) => ({
      provider,
      authPath: 'oauth',
      state: entry === null ? 'ok' : (entry.state || 'ok'),
      lastProbeAt: '2026-08-06T12:00:00Z',
      ...(entry === null
        ? {}
        : {
            afhGrounding: {
              grounded: Boolean(entry.grounded),
              signals: entry.signals ?? 0,
              threshold: 3,
              reason: entry.reason || 'below_threshold',
              quotaExhaustedKills: entry.signals ?? 0,
              suspendedLrqDepth: 0,
            },
          }),
    })),
  });
}

function groundingFor(spec) {
  return afhGroundingSnapshotFromStdout(fleetStatusJson(spec));
}

const ALL_OK = () => groundingFor({ openai: OK, anthropic: OK, google: OK });
// codex soft-grounded: the hard STATE is still `unknown` (the flapping provider
// AFH-02 exists to catch), only the soft verdict fires.
const CODEX_SOFT_GROUNDED = () =>
  groundingFor({
    openai: { state: 'unknown', grounded: true, reason: 'sustained_provider_quota_exhausted_kills', signals: 3 },
    anthropic: OK,
    google: OK,
  });
const CODEX_HARD_GROUNDED = () =>
  groundingFor({ openai: { state: 'exhausted', grounded: false }, anthropic: OK, google: OK });
const CODEX_AND_GEMINI_GROUNDED = () =>
  groundingFor({
    openai: { state: 'unknown', grounded: true, reason: 'suspended_lrq_depth', signals: 4 },
    anthropic: OK,
    google: { state: 'exhausted', grounded: false },
  });

// ── 1. grounded codex-reviewer → gemini-reviewer ───────────────────────────

test('AFH-04: soft-grounded codex-reviewer routes to gemini (cross-model preserved)', () => {
  for (const mode of ['fallback', 'always-on']) {
    const baseRoute = effectiveRouteFor('claude-code', mode);
    const route = applyAfhReviewerFallback({
      builderClass: 'claude-code',
      baseRoute,
      grounding: CODEX_SOFT_GROUNDED(),
      geminiReviewerMode: mode,
    });
    assert.equal(route.reviewerModel, 'gemini', `mode=${mode} → gemini`);
    assert.equal(route.botTokenEnv, 'GH_GEMINI_REVIEWER_TOKEN');
    if (mode === 'fallback') {
      // always-on already routes gemini before AFH runs; fallback mode is where
      // the AFH signal itself does the switching.
      assert.equal(route.afhReviewerFallback.fromReviewerModel, 'codex');
      assert.equal(route.afhReviewerFallback.toReviewerModel, 'gemini');
      assert.equal(route.afhReviewerFallback.primarySoftGrounded, true);
      assert.equal(route.afhReviewerFallback.primaryHardGrounded, false);
      assert.equal(route.afhReviewerFallback.lastResort, false);
    }
  }
});

test('AFH-04: hard-grounded codex-reviewer routes to gemini too (hard OR soft)', () => {
  const route = applyAfhReviewerFallback({
    builderClass: 'claude-code',
    baseRoute: effectiveRouteFor('claude-code', 'fallback'),
    grounding: CODEX_HARD_GROUNDED(),
    geminiReviewerMode: 'fallback',
  });
  assert.equal(route.reviewerModel, 'gemini');
  assert.equal(route.afhReviewerFallback.primaryHardGrounded, true);
  assert.equal(route.afhReviewerFallback.primarySoftGrounded, false);
  assert.equal(route.afhReviewerFallback.primaryState, 'exhausted');
});

// ── 2. codex AND gemini grounded → claude-reviewer, LAST RESORT ────────────

test('AFH-04: codex + gemini both grounded routes to claude-reviewer (last resort)', () => {
  const args = {
    builderClass: 'claude-code',
    baseRoute: effectiveRouteFor('claude-code', 'always-on'),
    grounding: CODEX_AND_GEMINI_GROUNDED(),
    geminiReviewerMode: 'always-on',
  };
  const decision = afhReviewerFallbackDecision(args);
  const route = applyAfhReviewerFallback(args);
  assert.equal(route.reviewerModel, 'claude');
  assert.equal(route.botTokenEnv, 'GH_CLAUDE_REVIEWER_TOKEN');
  assert.equal(route.afhReviewerFallback.toReviewerModel, 'claude');
  assert.equal(route.afhReviewerFallback.lastResort, true, 'claude reviewing a claude-built PR is flagged');
  // always-on already selected gemini, so gemini IS the grounded primary here;
  // the cross-model codex primary is the candidate that was tried and rejected
  // before claude became reachable.
  assert.equal(route.afhReviewerFallback.fromReviewerModel, 'gemini');
  assert.equal(route.afhReviewerFallback.primaryProvider, 'google');
  const skipped = route.afhReviewerFallback.considered.filter((entry) => !entry.selected);
  assert.ok(
    skipped.some((entry) => entry.reviewerModel === 'codex' && /grounded/.test(entry.reason)),
    'the cross-model primary was tried first and recorded as grounded'
  );

  // …and from a `fallback`-mode deployment, where codex is the live primary,
  // gemini itself appears in the rejected-candidate audit.
  const fromCodex = applyAfhReviewerFallback({
    builderClass: 'claude-code',
    baseRoute: effectiveRouteFor('claude-code', 'fallback'),
    grounding: CODEX_AND_GEMINI_GROUNDED(),
    geminiReviewerMode: 'fallback',
  });
  assert.equal(fromCodex.reviewerModel, 'claude');
  assert.equal(fromCodex.afhReviewerFallback.fromReviewerModel, 'codex');
  assert.equal(fromCodex.afhReviewerFallback.lastResort, true);
  assert.ok(
    fromCodex.afhReviewerFallback.considered.some(
      (entry) => entry.reviewerModel === 'gemini' && !entry.selected && /grounded/.test(entry.reason)
    ),
    'gemini was tried and rejected before claude was reachable'
  );
  assert.match(describeAfhReviewerFallback(decision), /LAST RESORT/);
  assert.match(describeAfhReviewerFallback(decision), /gemini -> claude/);
});

test('AFH-04: gemini disabled (mode=off) makes claude the last resort for a grounded codex', () => {
  // `reviewer.gemini.mode: off` means the operator has told us gemini is not a
  // usable reviewer — routing a fallback into it would orphan the PR.
  const route = applyAfhReviewerFallback({
    builderClass: 'claude-code',
    baseRoute: effectiveRouteFor('claude-code', 'off'),
    grounding: CODEX_SOFT_GROUNDED(),
    geminiReviewerMode: 'off',
  });
  assert.equal(route.reviewerModel, 'claude');
  assert.equal(route.afhReviewerFallback.lastResort, true);
  assert.ok(
    route.afhReviewerFallback.considered.some(
      (entry) => entry.reviewerModel === 'gemini' && entry.reason === 'gemini-reviewer-mode-off'
    ),
    'the audit records WHY gemini was skipped'
  );
});

// ── DIVERSITY ASSERTION ────────────────────────────────────────────────────

test('AFH-04 diversity guard: a [claude-code] PR never routes to claude while gemini is available', () => {
  const geminiUpCases = [
    ['openai soft-grounded', CODEX_SOFT_GROUNDED()],
    ['openai hard-exhausted', CODEX_HARD_GROUNDED()],
    [
      'openai grounded + anthropic healthy + google merely degraded',
      groundingFor({
        openai: { state: 'exhausted', grounded: true, reason: 'suspended_lrq_depth', signals: 9 },
        anthropic: OK,
        google: { state: 'degraded', grounded: false },
      }),
    ],
    [
      'openai grounded + google row absent entirely',
      groundingFor({ openai: { state: 'exhausted', grounded: true }, anthropic: OK }),
    ],
  ];
  for (const mode of ['fallback', 'always-on']) {
    for (const [label, grounding] of geminiUpCases) {
      const route = applyAfhReviewerFallback({
        builderClass: 'claude-code',
        baseRoute: effectiveRouteFor('claude-code', mode),
        grounding,
        geminiReviewerMode: mode,
      });
      assert.notEqual(
        route.reviewerModel,
        'claude',
        `mode=${mode} / ${label}: claude must not review a claude-built PR while gemini is up`
      );
      assert.equal(route.reviewerModel, 'gemini', `mode=${mode} / ${label} → gemini`);
    }
  }
});

test('AFH-04: a [gemini]-built PR never falls back onto gemini (integrity guard holds)', () => {
  const route = applyAfhReviewerFallback({
    builderClass: 'gemini',
    baseRoute: effectiveRouteFor('gemini', 'always-on'), // primary = codex
    grounding: CODEX_SOFT_GROUNDED(),
    geminiReviewerMode: 'always-on',
  });
  assert.equal(route.reviewerModel, 'claude', 'cross-model claude, not gemini-on-gemini');
  assert.equal(route.afhReviewerFallback.lastResort, false, 'claude vs a gemini builder is still cross-model');
  assert.ok(
    route.afhReviewerFallback.considered.some(
      (entry) => entry.reviewerModel === 'gemini' && entry.reason === 'gemini-integrity-guard'
    )
  );
});

// ── 3. all providers ok → configured primary ───────────────────────────────

test('AFH-04: all providers ok keeps the configured primary route untouched', () => {
  for (const [builderClass, mode, expected] of [
    ['claude-code', 'off', 'codex'],
    ['claude-code', 'fallback', 'codex'],
    ['claude-code', 'always-on', 'gemini'],
    ['codex', 'off', 'claude'],
    ['codex', 'always-on', 'gemini'],
  ]) {
    const baseRoute = effectiveRouteFor(builderClass, mode);
    const route = applyAfhReviewerFallback({
      builderClass,
      baseRoute,
      grounding: ALL_OK(),
      geminiReviewerMode: mode,
    });
    assert.equal(route.reviewerModel, expected, `${builderClass}/${mode} → ${expected}`);
    assert.equal(route.afhReviewerFallback, undefined, 'no AFH stamp when nothing is grounded');
    assert.deepEqual(route, baseRoute, 'the configured route object is returned unchanged');
  }
});

test('AFH-04: a grounded gemini falls BACK to a healthy codex, not forward to claude', () => {
  // always-on deployments route gemini first; when google grounds and openai is
  // healthy the ordered chain returns to the cross-model primary.
  const route = applyAfhReviewerFallback({
    builderClass: 'claude-code',
    baseRoute: effectiveRouteFor('claude-code', 'always-on'),
    grounding: groundingFor({
      openai: OK,
      anthropic: OK,
      google: { state: 'unknown', grounded: true, reason: 'suspended_lrq_depth', signals: 3 },
    }),
    geminiReviewerMode: 'always-on',
  });
  assert.equal(route.reviewerModel, 'codex');
  assert.equal(route.afhReviewerFallback.fromReviewerModel, 'gemini');
  assert.equal(route.afhReviewerFallback.lastResort, false);
});

test('AFH-04: every candidate grounded keeps the primary (no doomed reshuffle)', () => {
  const baseRoute = effectiveRouteFor('claude-code', 'always-on');
  const decision = afhReviewerFallbackDecision({
    builderClass: 'claude-code',
    baseRoute,
    grounding: groundingFor({
      openai: { state: 'exhausted', grounded: true },
      anthropic: { state: 'exhausted', grounded: true },
      google: { state: 'exhausted', grounded: true },
    }),
    geminiReviewerMode: 'always-on',
  });
  assert.equal(decision.applied, false);
  assert.equal(decision.reason, 'all-candidates-grounded');
  assert.deepEqual(applyAfhReviewerFallback({
    builderClass: 'claude-code',
    baseRoute,
    grounding: groundingFor({
      openai: { state: 'exhausted', grounded: true },
      anthropic: { state: 'exhausted', grounded: true },
      google: { state: 'exhausted', grounded: true },
    }),
    geminiReviewerMode: 'always-on',
  }), baseRoute);
});

test('AFH-04: an explicit operator reviewer pin outranks the AFH fallback', () => {
  const baseRoute = { ...effectiveRouteFor('claude-code', 'off'), operatorPinnedReviewer: true };
  const decision = afhReviewerFallbackDecision({
    builderClass: 'claude-code',
    baseRoute,
    grounding: CODEX_SOFT_GROUNDED(),
    geminiReviewerMode: 'always-on',
  });
  assert.equal(decision.applied, false);
  assert.equal(decision.reason, 'operator-pinned-reviewer');
});

// ── 4. unreadable `hq fleet quota status --json` fails open ────────────────

const HQ_FAILURE_MODES = [
  {
    label: 'command throws (hq not installed)',
    execFileImpl: async () => {
      const err = new Error('spawn hq ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
    reason: 'fleet-quota-status-unavailable',
  },
  {
    label: 'non-zero exit',
    execFileImpl: async () => {
      const err = new Error('Command failed: hq fleet quota status --json');
      err.code = 2;
      err.stderr = 'boom';
      throw err;
    },
    reason: 'fleet-quota-status-unavailable',
  },
  {
    label: 'timeout kill',
    execFileImpl: async () => {
      const err = new Error('Command timed out');
      err.killed = true;
      err.signal = 'SIGTERM';
      throw err;
    },
    reason: 'fleet-quota-status-unavailable',
  },
  {
    label: 'malformed JSON',
    execFileImpl: async () => ({ stdout: 'not json at all <<<' }),
    reason: 'fleet-quota-status-unreadable',
  },
  {
    label: 'empty stdout',
    execFileImpl: async () => ({ stdout: '' }),
    reason: 'fleet-quota-status-unreadable',
  },
  {
    label: 'JSON without providerStatuses',
    execFileImpl: async () => ({ stdout: JSON.stringify({ ok: true }) }),
    reason: 'no-provider-statuses',
  },
];

test('AFH-04: every hq failure mode fails open with no uncaught exception', async () => {
  for (const mode of HQ_FAILURE_MODES) {
    const grounding = await readAfhReviewerGrounding({
      hqPath: 'hq',
      execFileImpl: mode.execFileImpl,
      env: {},
      retryDelaysMs: [],
    });
    assert.equal(grounding.available, false, `${mode.label}: snapshot marked unavailable`);
    assert.equal(grounding.reason, mode.reason, `${mode.label}: reason recorded for the audit trail`);

    for (const geminiReviewerMode of ['off', 'fallback', 'always-on']) {
      const baseRoute = effectiveRouteFor('claude-code', geminiReviewerMode);
      const route = applyAfhReviewerFallback({
        builderClass: 'claude-code',
        baseRoute,
        grounding,
        geminiReviewerMode,
      });
      assert.deepEqual(
        route,
        baseRoute,
        `${mode.label}/${geminiReviewerMode}: configured route kept`
      );
    }
  }
});

test('AFH-04: a real missing `hq` binary degrades instead of rejecting', async () => {
  // No DI here on purpose: this exercises the actual child_process path the
  // watcher takes, so a spawn error can never surface as an unhandled rejection.
  const grounding = await readAfhReviewerGrounding({
    hqPath: '/nonexistent/afh-04/hq',
    env: {},
    timeoutMs: 5_000,
  });
  assert.equal(grounding.available, false);
  assert.equal(grounding.reason, 'fleet-quota-status-unavailable');
  assert.match(String(grounding.error), /ENOENT|not found/i);
});

test('AFH-04: transient hq quota-status failures retry before failing open', async () => {
  assert.equal(AFH_FLEET_QUOTA_STATUS_RETRY_TIMEOUT_FRACTION, 0.25);
  let calls = 0;
  const timeouts = [];
  const grounding = await readAfhReviewerGrounding({
    hqPath: 'hq',
    execFileImpl: async (_cmd, _args, options) => {
      calls += 1;
      timeouts.push(options.timeout);
      if (calls === 1) {
        const err = new Error('TLS handshake timeout while reading fleet quota status');
        err.code = 'ETIMEDOUT';
        throw err;
      }
      return { stdout: fleetStatusJson({ openai: OK, anthropic: OK, google: OK }) };
    },
    env: {},
    retryDelaysMs: [0],
    sleepImpl: async () => {},
  });
  assert.equal(calls, 2, 'the transient failure was retried once');
  assert.deepEqual(timeouts, [10_000, 2_500], 'retry attempts use a shorter child timeout');
  assert.equal(grounding.available, true);
  assert.equal(grounding.reason, 'ok');
});

test('AFH-04: a provider row with NO afhGrounding verdict yields no soft signal', () => {
  // pre-AFH-02 `hq`, or AFH-02's own documented ledger-read fail-open (verdict
  // null). Neither may be read as "grounded".
  const grounding = groundingFor({ openai: null, anthropic: null, google: null });
  assert.equal(grounding.available, true);
  assert.equal(grounding.verdictPresent, false);
  assert.equal(reviewerModelGrounding(grounding, 'codex').softGrounded, false);
  assert.equal(reviewerModelGrounding(grounding, 'codex').grounded, false);

  const baseRoute = effectiveRouteFor('claude-code', 'fallback');
  assert.deepEqual(
    applyAfhReviewerFallback({
      builderClass: 'claude-code',
      baseRoute,
      grounding,
      geminiReviewerMode: 'fallback',
    }),
    baseRoute,
    'missing verdict → configured primary'
  );
});

test('AFH-04: a hard-exhausted provider still grounds when the afhGrounding key is absent', () => {
  const grounding = afhGroundingSnapshotFromStdout(
    JSON.stringify({
      providerStatuses: [
        { provider: 'openai', authPath: 'oauth', state: 'exhausted' },
        { provider: 'google', authPath: 'oauth', state: 'ok' },
      ],
    })
  );
  const route = applyAfhReviewerFallback({
    builderClass: 'claude-code',
    baseRoute: effectiveRouteFor('claude-code', 'fallback'),
    grounding,
    geminiReviewerMode: 'fallback',
  });
  assert.equal(route.reviewerModel, 'gemini', 'the pre-AFH hard signal is unchanged, not weakened');
});

test('AFH-04: a non-boolean afhGrounding.grounded is discarded, not coerced', () => {
  const grounding = afhGroundingSnapshotFromStdout(
    JSON.stringify({
      providerStatuses: [
        { provider: 'openai', authPath: 'oauth', state: 'ok', afhGrounding: { grounded: 'yes' } },
      ],
    })
  );
  assert.equal(reviewerModelGrounding(grounding, 'codex').grounded, false);
  assert.equal(parseHqFleetQuotaStatus(
    JSON.stringify({ providerStatuses: [{ provider: 'openai', afhGrounding: { grounded: 'yes' } }] })
  )[0].afhGrounding, null);
});

test('AFH-04: missing afhGrounding counts stay null instead of coercing to 0', () => {
  const [status] = parseHqFleetQuotaStatus(
    JSON.stringify({
      providerStatuses: [
        {
          provider: 'openai',
          afhGrounding: {
            grounded: true,
            signals: null,
            threshold: '',
            quotaExhaustedKills: '   ',
            suspendedLrqDepth: false,
          },
        },
      ],
    })
  );
  assert.equal(status.afhGrounding.grounded, true);
  assert.equal(status.afhGrounding.signals, null, 'explicit null stays unknown, not 0');
  assert.equal(status.afhGrounding.threshold, null, 'empty string stays unknown, not 0');
  assert.equal(status.afhGrounding.quotaExhaustedKills, null, 'blank string stays unknown, not 0');
  assert.equal(status.afhGrounding.suspendedLrqDepth, null, 'false stays unknown, not 0');

  const [observed] = parseHqFleetQuotaStatus(
    JSON.stringify({
      providerStatuses: [
        {
          provider: 'openai',
          afhGrounding: { grounded: true, signals: 0, threshold: '3', quotaExhaustedKills: 2 },
        },
      ],
    })
  );
  assert.equal(observed.afhGrounding.signals, 0, 'a real observed zero is preserved');
  assert.equal(observed.afhGrounding.threshold, 3, 'numeric strings still parse');
  assert.equal(observed.afhGrounding.quotaExhaustedKills, 2);
  assert.equal(observed.afhGrounding.suspendedLrqDepth, null, 'absent stays unknown');
});

test('AFH-04: the fallback can be disabled outright without a subprocess', async () => {
  let called = 0;
  const grounding = await readAfhReviewerGrounding({
    execFileImpl: async () => {
      called += 1;
      return { stdout: fleetStatusJson({ openai: { state: 'exhausted', grounded: true } }) };
    },
    env: { ADVERSARIAL_AFH_REVIEWER_FALLBACK: '0' },
  });
  assert.equal(called, 0, 'kill switch short-circuits before spawning hq');
  assert.equal(grounding.available, false);
  assert.equal(grounding.reason, 'afh-reviewer-fallback-disabled');
});

test('AFH-04: the per-tick cache reads hq once per TTL and never rejects', async () => {
  let reads = 0;
  let now = 1_000_000;
  const getGrounding = createAfhReviewerGroundingCache({
    ttlMs: 60_000,
    nowFn: () => now,
    readImpl: async () => {
      reads += 1;
      return afhGroundingSnapshotFromStdout(fleetStatusJson({ openai: OK, anthropic: OK, google: OK }));
    },
  });
  const [a, b] = await Promise.all([getGrounding(), getGrounding()]);
  assert.equal(reads, 1, 'concurrent callers share the in-flight read');
  assert.equal(a.available, true);
  assert.equal(b.available, true);
  await getGrounding();
  assert.equal(reads, 1, 'cached within the TTL window');
  now += 60_001;
  await getGrounding();
  assert.equal(reads, 2, 'refreshed after the TTL window');

  const warnings = [];
  const throwing = createAfhReviewerGroundingCache({
    nowFn: () => now,
    logger: { warn: (message) => warnings.push(message) },
    readImpl: async () => {
      throw new Error('reader exploded');
    },
  });
  const snapshot = await throwing();
  assert.equal(snapshot.available, false, 'a throwing reader degrades instead of crashing the tick');
  assert.equal(snapshot.reason, 'fleet-quota-status-unavailable');
  await throwing();
  assert.equal(warnings.length, 1, 'the degraded breadcrumb is once per refresh window, not per PR');
  assert.match(warnings[0], /afh-reviewer-grounding degraded/);
});

test('AFH-04: the per-tick cache stale-serves a recent good grounding after a refresh failure', async () => {
  let reads = 0;
  let now = 10_000;
  const warnings = [];
  const getGrounding = createAfhReviewerGroundingCache({
    ttlMs: 100,
    nowFn: () => now,
    logger: { warn: (message) => warnings.push(message) },
    readImpl: async () => {
      reads += 1;
      if (reads === 1) {
        return CODEX_SOFT_GROUNDED();
      }
      return {
        available: false,
        reason: 'fleet-quota-status-unavailable',
        error: 'temporary hq status hiccup',
        verdictPresent: false,
        providers: Object.freeze({}),
      };
    },
  });

  const first = await getGrounding();
  assert.equal(first.available, true);
  assert.equal(reviewerModelGrounding(first, 'codex').grounded, true);

  now += 101;
  const stale = await getGrounding();
  assert.equal(reads, 2, 'the cache attempted to refresh after TTL expiry');
  assert.equal(stale.available, true, 'a recent good quota snapshot is used');
  assert.equal(stale.staleIfError.reason, 'fleet-quota-status-unavailable');
  assert.equal(reviewerModelGrounding(stale, 'codex').grounded, true);
  assert.match(warnings.at(-1), /stale-if-error/);
});

// ── 5. auto-revert ─────────────────────────────────────────────────────────

test('AFH-04: the next attempt returns to the primary once codex un-grounds', () => {
  const baseRoute = effectiveRouteFor('claude-code', 'fallback');
  const duringOutage = applyAfhReviewerFallback({
    builderClass: 'claude-code',
    baseRoute,
    grounding: CODEX_SOFT_GROUNDED(),
    geminiReviewerMode: 'fallback',
  });
  assert.equal(duringOutage.reviewerModel, 'gemini');

  // Same inputs, recovered snapshot — the decision is stateless, so recovery
  // needs no operator action and nothing to un-pin.
  const afterRecovery = applyAfhReviewerFallback({
    builderClass: 'claude-code',
    baseRoute,
    grounding: ALL_OK(),
    geminiReviewerMode: 'fallback',
  });
  assert.equal(afterRecovery.reviewerModel, 'codex');
  assert.equal(afterRecovery.afhReviewerFallback, undefined);
  assert.deepEqual(afterRecovery, baseRoute);
});

// ── helpers / attempt-selection integration ────────────────────────────────

test('AFH-04: provider mapping covers every reviewer model', () => {
  assert.equal(providerForReviewerModel('codex'), 'openai');
  assert.equal(providerForReviewerModel('claude'), 'anthropic');
  assert.equal(providerForReviewerModel('claude-code'), 'anthropic');
  assert.equal(providerForReviewerModel('gemini'), 'google');
  assert.equal(providerForReviewerModel('nope'), null);
  assert.equal(AFH_REVIEWER_MODEL_PROVIDER.codex, 'openai');
});

test('AFH-04: gemini fallback eligibility mirrors the existing gemini policy', () => {
  assert.equal(geminiFallbackEligibility({ builderClass: 'claude-code', geminiReviewerMode: 'always-on' }).eligible, true);
  assert.equal(geminiFallbackEligibility({ builderClass: 'gemini', geminiReviewerMode: 'always-on' }).reason, 'gemini-integrity-guard');
  assert.equal(geminiFallbackEligibility({ builderClass: 'pi', geminiReviewerMode: 'always-on' }).reason, 'builder-not-in-gemini-roster');
  assert.equal(geminiFallbackEligibility({ builderClass: 'claude-code', geminiReviewerMode: 'off' }).reason, 'gemini-reviewer-mode-off');
});

test('AFH-04: the reviewer-timeout fallback refuses a grounded target', () => {
  const env = {
    ADVERSARIAL_REVIEW_TIMEOUT_FALLBACK_THRESHOLD: '2',
    ADVERSARIAL_REVIEW_TIMEOUT_FALLBACK_MODEL: 'gemini',
  };
  const baseRoute = effectiveRouteFor('claude-code', 'off'); // codex
  const rootDir = mkdtempSync(join(tmpdir(), 'afh04-cascade-'));
  try {
    // No cascade state on disk → the timeout fallback does not engage at all,
    // which is the pre-AFH behavior and must be preserved.
    assert.deepEqual(
      selectReviewerRouteForAttempt({
        subject: { builderClass: 'claude-code' },
        baseRoute,
        rootDir,
        repoPath: 'owner/repo',
        prNumber: 1,
        env,
        afhGrounding: CODEX_AND_GEMINI_GROUNDED(),
      }),
      baseRoute
    );

    mkdirSync(join(rootDir, 'data', 'cascade-state'), { recursive: true });
    writeFileSync(
      join(rootDir, 'data', 'cascade-state', `${encodeURIComponent('owner/repo')}__1.json`),
      JSON.stringify({
        lastFailureClass: 'reviewer-timeout',
        transientFailureBreakdown: { 'reviewer-timeout': 3 },
      })
    );

    // Gemini healthy → the pre-AFH timeout fallback still engages unchanged.
    const healthy = selectReviewerRouteForAttempt({
      subject: { builderClass: 'claude-code' },
      baseRoute,
      rootDir,
      repoPath: 'owner/repo',
      prNumber: 1,
      env,
      afhGrounding: ALL_OK(),
    });
    assert.equal(healthy.reviewerModel, 'gemini');
    assert.equal(healthy.timeoutFallback.toReviewerModel, 'gemini');
    assert.equal(healthy.afhTimeoutFallbackSkipped, undefined);

    // Gemini grounded → refuse to trade a slow reviewer for an unspawnable one.
    const grounded = selectReviewerRouteForAttempt({
      subject: { builderClass: 'claude-code' },
      baseRoute,
      rootDir,
      repoPath: 'owner/repo',
      prNumber: 1,
      env,
      afhGrounding: CODEX_AND_GEMINI_GROUNDED(),
    });
    assert.equal(grounded.reviewerModel, 'codex', 'stays on the configured reviewer');
    assert.equal(grounded.timeoutFallback, undefined);
    assert.equal(grounded.afhTimeoutFallbackSkipped.candidateReviewerModel, 'gemini');
    assert.equal(grounded.afhTimeoutFallbackSkipped.provider, 'google');

    // No AFH signal at all → pre-AFH behavior, byte for byte.
    const noSignal = selectReviewerRouteForAttempt({
      subject: { builderClass: 'claude-code' },
      baseRoute,
      rootDir,
      repoPath: 'owner/repo',
      prNumber: 1,
      env,
    });
    assert.equal(noSignal.reviewerModel, 'gemini');
    assert.equal(noSignal.afhTimeoutFallbackSkipped, undefined);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('AFH-04: an unrecognizable builder class fails closed (no same-model reassignment)', () => {
  const decision = afhReviewerFallbackDecision({
    builderClass: 'not-a-worker-class',
    baseRoute: { reviewerModel: 'codex', botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN' },
    grounding: CODEX_SOFT_GROUNDED(),
    geminiReviewerMode: 'always-on',
  });
  assert.equal(decision.applied, false);
  assert.equal(decision.reason, 'unknown-builder-class');
});

test('AFH-04: decision surface is null-safe for a config-broken or absent route', () => {
  assert.equal(afhReviewerFallbackDecision({}).applied, false);
  assert.equal(afhReviewerFallbackDecision({ baseRoute: null }).reason, 'no-route');
  assert.equal(
    afhReviewerFallbackDecision({ baseRoute: { configBroken: true } }).reason,
    'no-route'
  );
  assert.equal(applyAfhReviewerFallback({ baseRoute: null }), null);
  assert.equal(describeAfhReviewerFallback(null), null);
  assert.equal(describeAfhReviewerFallback({ applied: false }), null);
});

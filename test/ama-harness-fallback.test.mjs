import test from 'node:test';
import assert from 'node:assert/strict';

import {
  providerForCloserWorkerClass,
  resolveCloserDispatchHarness,
} from '../src/ama/harness-fallback.mjs';
import { describeHarnessGrounding } from '../src/ama/dispatch-closer.mjs';
import {
  isGroundedProviderState,
  parseHqFleetQuotaStatus,
  providerAvailabilityFromFleetStatus,
  providerAvailabilityFromStatuses,
  providerSoftGroundingFromFleetStatus,
  providerSoftGroundingFromStatuses,
} from '../src/fleet-quota-status.mjs';

// A `hq fleet quota status --json` payload with the given provider states. The
// shape mirrors cwp_dispatch/cli_fleet.py's `providerStatuses` output. A value
// may be a bare hard state string, or `{ state, afhGrounding }` to also carry
// AFH-02's soft-grounding verdict (afh_soft_grounding.py's `to_json()`).
function fleetQuotaStdout(states = {}) {
  const providerStatuses = Object.entries(states).map(([provider, value]) => {
    const spec = typeof value === 'string' ? { state: value } : (value || {});
    return {
      provider,
      authPath: 'oauth',
      state: spec.state,
      lastProbeAt: '2026-07-05T00:00:00Z',
      lastGoodAt: '2026-07-04T00:00:00Z',
      ...('afhGrounding' in spec ? { afhGrounding: spec.afhGrounding } : {}),
    };
  });
  return JSON.stringify({ providerStatuses, lastProbeAt: '2026-07-05T00:00:00Z' });
}

// AFH-02's `afhGrounding` projection, verbatim from SoftGroundingVerdict.to_json().
function afhGrounding({ grounded, signals = 0, reason = null, kills = 0, lrqDepth = 0 } = {}) {
  return {
    grounded,
    signals,
    threshold: 3,
    reason: reason || (grounded ? 'sustained_provider_quota_exhausted_kills' : 'below_threshold'),
    quotaExhaustedKills: kills,
    suspendedLrqDepth: lrqDepth,
  };
}

function buildFleetExec(stdout) {
  const calls = [];
  const impl = async (cmd, args) => {
    calls.push({ cmd, args });
    return { stdout, stderr: '' };
  };
  return { impl, calls };
}

test('providerForCloserWorkerClass maps hammer/codex to openai and claude classes to anthropic', () => {
  assert.equal(providerForCloserWorkerClass('hammer'), 'openai');
  assert.equal(providerForCloserWorkerClass('codex'), 'openai');
  assert.equal(providerForCloserWorkerClass('claude-code'), 'anthropic');
  assert.equal(providerForCloserWorkerClass('hammer-claude'), 'anthropic');
  assert.equal(providerForCloserWorkerClass('gemini'), 'google');
  assert.equal(providerForCloserWorkerClass('nonsense'), null);
});

test('isGroundedProviderState treats exhausted/suspended as grounded, ok/degraded/unknown as not', () => {
  assert.equal(isGroundedProviderState('exhausted'), true);
  assert.equal(isGroundedProviderState('suspended'), true);
  assert.equal(isGroundedProviderState('ok'), false);
  assert.equal(isGroundedProviderState('degraded'), false);
  assert.equal(isGroundedProviderState('unknown'), false);
  assert.equal(isGroundedProviderState(''), false);
});

test('providerAvailabilityFromFleetStatus prefers the oauth auth-path status', () => {
  const stdout = JSON.stringify({
    providerStatuses: [
      { provider: 'openai', authPath: 'litellm-vk', state: 'ok' },
      { provider: 'openai', authPath: 'oauth', state: 'exhausted' },
    ],
  });
  const decision = providerAvailabilityFromFleetStatus(stdout, { provider: 'openai' });
  assert.equal(decision.state, 'exhausted');
  assert.equal(decision.available, false);
});

test('no fallback configured → keep primary, no fleet-quota read', async () => {
  const exec = buildFleetExec(fleetQuotaStdout({ openai: 'exhausted' }));
  const result = await resolveCloserDispatchHarness({
    workerClass: 'hammer',
    fallbackWorkerClasses: [],
    execFileImpl: exec.impl,
  });
  assert.equal(result.fellBack, false);
  assert.equal(result.workerClass, 'hammer');
  assert.equal(result.reason, 'no-fallback-configured');
  assert.equal(exec.calls.length, 0, 'must not query fleet quota when no fallback is configured');
});

test('codex grounded (exhausted) + hammer primary → falls back to claude-code', async () => {
  const exec = buildFleetExec(fleetQuotaStdout({ openai: 'exhausted', anthropic: 'ok' }));
  const result = await resolveCloserDispatchHarness({
    workerClass: 'hammer',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: exec.impl,
  });
  assert.equal(result.fellBack, true);
  assert.equal(result.workerClass, 'claude-code');
  assert.equal(result.from, 'hammer');
  assert.equal(result.to, 'claude-code');
  assert.equal(result.provider, 'openai');
  assert.equal(result.primaryState, 'exhausted');
  assert.equal(result.fallbackProvider, 'anthropic');
  assert.equal(exec.calls.length, 1);
  assert.deepEqual(exec.calls[0].args, ['fleet', 'quota', 'status', '--json']);
});

test('codex healthy (ok) → keep primary hammer (auto-revert, no fallback)', async () => {
  const exec = buildFleetExec(fleetQuotaStdout({ openai: 'ok', anthropic: 'ok' }));
  const result = await resolveCloserDispatchHarness({
    workerClass: 'hammer',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: exec.impl,
  });
  assert.equal(result.fellBack, false);
  assert.equal(result.workerClass, 'hammer');
  assert.equal(result.reason, 'primary-available');
  assert.equal(result.primaryState, 'ok');
});

test('ambiguous codex state (degraded/unknown/missing) → keep primary (no guess)', async () => {
  for (const state of ['degraded', 'unknown']) {
    const exec = buildFleetExec(fleetQuotaStdout({ openai: state }));
    const result = await resolveCloserDispatchHarness({
      workerClass: 'hammer',
      fallbackWorkerClasses: ['claude-code'],
      execFileImpl: exec.impl,
    });
    assert.equal(result.fellBack, false, `state=${state} must not fall back`);
    assert.equal(result.reason, 'primary-not-grounded');
  }
  // Missing provider status entirely → also no guess.
  const execMissing = buildFleetExec(fleetQuotaStdout({ anthropic: 'ok' }));
  const missing = await resolveCloserDispatchHarness({
    workerClass: 'hammer',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: execMissing.impl,
  });
  assert.equal(missing.fellBack, false);
});

test('fleet quota status unavailable (exec throws) → fail-open to primary', async () => {
  const impl = async () => {
    throw new Error('hq: command not found');
  };
  const result = await resolveCloserDispatchHarness({
    workerClass: 'hammer',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: impl,
  });
  assert.equal(result.fellBack, false);
  assert.equal(result.workerClass, 'hammer');
  assert.equal(result.reason, 'fleet-quota-status-unavailable');
});

test('every fallback also grounded → keep primary (doomed but auto-reverting)', async () => {
  const exec = buildFleetExec(fleetQuotaStdout({ openai: 'exhausted', anthropic: 'exhausted' }));
  const result = await resolveCloserDispatchHarness({
    workerClass: 'hammer',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: exec.impl,
  });
  assert.equal(result.fellBack, false);
  assert.equal(result.workerClass, 'hammer');
  assert.equal(result.reason, 'all-fallbacks-grounded');
});

test('skips a grounded fallback and picks the first healthy one in order', async () => {
  // openai (hammer) exhausted, google (gemini) exhausted, anthropic (claude-code) ok.
  const exec = buildFleetExec(fleetQuotaStdout({ openai: 'exhausted', google: 'exhausted', anthropic: 'ok' }));
  const result = await resolveCloserDispatchHarness({
    workerClass: 'hammer',
    fallbackWorkerClasses: ['gemini', 'claude-code'],
    execFileImpl: exec.impl,
  });
  assert.equal(result.fellBack, true);
  assert.equal(result.to, 'claude-code');
});

// ---------------------------------------------------------------------------
// AFH-05 — the closer also grounds on AFH-02's SOFT signal.
//
// The hard states below are deliberately left NON-grounded in these fixtures
// (`unknown` is what a flapping codex outage actually reports), so each test
// proves the soft limb alone drove the decision.
// ---------------------------------------------------------------------------

test('AFH-05: soft-grounded codex (hard state unknown) → falls back to hammer-claude', async () => {
  const exec = buildFleetExec(fleetQuotaStdout({
    openai: {
      state: 'unknown',
      afhGrounding: afhGrounding({ grounded: true, signals: 10, reason: 'suspended_lrq_depth', lrqDepth: 10 }),
    },
    anthropic: { state: 'ok', afhGrounding: afhGrounding({ grounded: false }) },
  }));
  const result = await resolveCloserDispatchHarness({
    workerClass: 'hammer',
    fallbackWorkerClasses: ['hammer-claude'],
    execFileImpl: exec.impl,
  });
  assert.equal(result.fellBack, true);
  assert.equal(result.workerClass, 'hammer-claude');
  assert.equal(result.from, 'hammer');
  assert.equal(result.to, 'hammer-claude');
  assert.equal(result.provider, 'openai');
  assert.equal(result.fallbackProvider, 'anthropic');
  // The soft limb fired, and the HARD state is reported untouched — the audit
  // record must never restate a soft verdict as the 429 classification.
  assert.equal(result.groundedBy, 'soft');
  assert.equal(result.softGrounded, true);
  assert.equal(result.primaryState, 'unknown');
  assert.equal(result.softGrounding.reason, 'suspended_lrq_depth');
  assert.equal(result.softGrounding.signals, 10);
  assert.equal(result.softGrounding.threshold, 3);
  assert.equal(exec.calls.length, 1);
});

test('AFH-05: provider recovered (soft verdict clears, hard not set) → auto-reverts to hammer', async () => {
  const exec = buildFleetExec(fleetQuotaStdout({
    openai: { state: 'ok', afhGrounding: afhGrounding({ grounded: false, signals: 1, kills: 1 }) },
    anthropic: { state: 'ok', afhGrounding: afhGrounding({ grounded: false }) },
  }));
  const result = await resolveCloserDispatchHarness({
    workerClass: 'hammer',
    fallbackWorkerClasses: ['hammer-claude'],
    execFileImpl: exec.impl,
  });
  assert.equal(result.fellBack, false);
  assert.equal(result.workerClass, 'hammer');
  assert.equal(result.reason, 'primary-available');
  assert.equal(result.softGrounded, false);
});

test('AFH-05: sub-threshold soft signal (a blip) does not ground the primary', async () => {
  const exec = buildFleetExec(fleetQuotaStdout({
    openai: {
      state: 'unknown',
      afhGrounding: afhGrounding({ grounded: false, signals: 2, kills: 2, reason: 'below_threshold' }),
    },
    anthropic: 'ok',
  }));
  const result = await resolveCloserDispatchHarness({
    workerClass: 'hammer',
    fallbackWorkerClasses: ['hammer-claude'],
    execFileImpl: exec.impl,
  });
  assert.equal(result.fellBack, false, 'a below-threshold verdict must not fall back');
  assert.equal(result.workerClass, 'hammer');
  assert.equal(result.reason, 'primary-not-grounded');
});

test('AFH-05: hard GROUNDED_PROVIDER_STATES path is unchanged (regression)', async () => {
  // Hard-exhausted openai while AFH-02 says NOT soft-grounded: the pre-AFH-05
  // behavior must survive untouched, and be labeled as the hard limb.
  for (const state of ['exhausted', 'suspended', 'grounded']) {
    const exec = buildFleetExec(fleetQuotaStdout({
      openai: { state, afhGrounding: afhGrounding({ grounded: false }) },
      anthropic: { state: 'ok', afhGrounding: afhGrounding({ grounded: false }) },
    }));
    const result = await resolveCloserDispatchHarness({
      workerClass: 'hammer',
      fallbackWorkerClasses: ['hammer-claude'],
      execFileImpl: exec.impl,
    });
    assert.equal(result.fellBack, true, `hard state=${state} must still fall back`);
    assert.equal(result.workerClass, 'hammer-claude');
    assert.equal(result.primaryState, state);
    assert.equal(result.groundedBy, 'hard');
    assert.equal(result.softGrounded, false);
  }

  // And with NO afhGrounding key at all (a pre-AFH-02 `hq` on the box), the
  // hard path still behaves exactly as it did before this change.
  const legacy = buildFleetExec(fleetQuotaStdout({ openai: 'exhausted', anthropic: 'ok' }));
  const result = await resolveCloserDispatchHarness({
    workerClass: 'hammer',
    fallbackWorkerClasses: ['hammer-claude'],
    execFileImpl: legacy.impl,
  });
  assert.equal(result.fellBack, true);
  assert.equal(result.to, 'hammer-claude');
  assert.equal(result.groundedBy, 'hard');
  assert.equal(result.softGrounding, null);
});

test('AFH-05: hard AND soft grounded → falls back, labeled hard+soft', async () => {
  const exec = buildFleetExec(fleetQuotaStdout({
    openai: { state: 'exhausted', afhGrounding: afhGrounding({ grounded: true, signals: 5, kills: 5 }) },
    anthropic: 'ok',
  }));
  const result = await resolveCloserDispatchHarness({
    workerClass: 'hammer',
    fallbackWorkerClasses: ['hammer-claude'],
    execFileImpl: exec.impl,
  });
  assert.equal(result.fellBack, true);
  assert.equal(result.groundedBy, 'hard+soft');
});

test('AFH-05: unreadable/ambiguous soft verdict → keeps primary (fail-open preserved)', async () => {
  // Every shape that is not a definite boolean-true verdict: absent key, the
  // Python side's own fail-open null, a truthy STRING, a non-object, an object
  // with no `grounded`, and an inverted-type verdict.
  const unreadable = [
    { state: 'unknown' },
    { state: 'unknown', afhGrounding: null },
    { state: 'unknown', afhGrounding: { grounded: 'true', signals: 9, threshold: 3 } },
    { state: 'unknown', afhGrounding: 'soft-grounded' },
    { state: 'unknown', afhGrounding: 1 },
    { state: 'unknown', afhGrounding: [{ grounded: true }] },
    { state: 'unknown', afhGrounding: { signals: 9, threshold: 3, reason: 'suspended_lrq_depth' } },
  ];
  for (const openai of unreadable) {
    const exec = buildFleetExec(fleetQuotaStdout({ openai, anthropic: 'ok' }));
    const result = await resolveCloserDispatchHarness({
      workerClass: 'hammer',
      fallbackWorkerClasses: ['hammer-claude'],
      execFileImpl: exec.impl,
    });
    assert.equal(
      result.fellBack,
      false,
      `unreadable afhGrounding ${JSON.stringify(openai.afhGrounding)} must keep the primary`,
    );
    assert.equal(result.workerClass, 'hammer');
    assert.equal(result.reason, 'primary-not-grounded');
    assert.equal(result.softGrounded, false);
  }
});

test('AFH-05: malformed fleet-quota JSON → fail-open to primary, never throws', async () => {
  for (const stdout of ['not json at all', '', '{"providerStatuses": [']) {
    const exec = buildFleetExec(stdout);
    const result = await resolveCloserDispatchHarness({
      workerClass: 'hammer',
      fallbackWorkerClasses: ['hammer-claude'],
      execFileImpl: exec.impl,
    });
    assert.equal(result.fellBack, false);
    assert.equal(result.workerClass, 'hammer');
    assert.equal(result.reason, 'fleet-quota-status-unreadable');
  }
});

test('AFH-05: a soft-grounded primary still respects a hard-grounded fallback', async () => {
  // Soft-grounded openai, hard-exhausted anthropic: no healthy harness exists,
  // so keep the primary (auto-reverting) rather than swap to a doomed one.
  const exec = buildFleetExec(fleetQuotaStdout({
    openai: { state: 'unknown', afhGrounding: afhGrounding({ grounded: true, signals: 4, kills: 4 }) },
    anthropic: 'exhausted',
  }));
  const result = await resolveCloserDispatchHarness({
    workerClass: 'hammer',
    fallbackWorkerClasses: ['hammer-claude'],
    execFileImpl: exec.impl,
  });
  assert.equal(result.fellBack, false);
  assert.equal(result.reason, 'all-fallbacks-grounded');
  assert.equal(result.groundedBy, 'soft');
});

test('AFH-05: providerSoftGroundingFromFleetStatus reads the AFH-02 verdict verbatim', () => {
  const stdout = fleetQuotaStdout({
    openai: {
      state: 'unknown',
      afhGrounding: afhGrounding({ grounded: true, signals: 3, reason: 'sustained_provider_quota_exhausted_kills', kills: 3 }),
    },
  });
  const grounded = providerSoftGroundingFromFleetStatus(stdout, { provider: 'openai' });
  assert.equal(grounded.grounded, true);
  assert.equal(grounded.verdict.signals, 3);
  assert.equal(grounded.verdict.quotaExhaustedKills, 3);
  assert.equal(grounded.reason, 'sustained_provider_quota_exhausted_kills');

  // Provider not in the payload, and no provider asked for → not grounded.
  assert.equal(providerSoftGroundingFromFleetStatus(stdout, { provider: 'google' }).grounded, false);
  assert.equal(
    providerSoftGroundingFromFleetStatus(stdout, { provider: 'google' }).reason,
    'missing-provider-status',
  );
  assert.equal(providerSoftGroundingFromFleetStatus(stdout, {}).reason, 'unknown-provider');
});

test('AFH-05: the operator alert never renders a soft verdict as the hard 429 state', () => {
  const soft = describeHarnessGrounding({
    provider: 'openai',
    primaryState: 'unknown',
    groundedBy: 'soft',
    softGrounding: { grounded: true, signals: 10, threshold: 3, reason: 'suspended_lrq_depth' },
  });
  assert.match(soft, /AFH soft-grounded/);
  assert.match(soft, /10\/3 signals/);
  assert.match(soft, /hard probe state unknown/);
  assert.doesNotMatch(soft, /is quota-grounded \(unknown\)/);

  const hard = describeHarnessGrounding({ provider: 'openai', primaryState: 'exhausted', groundedBy: 'hard' });
  assert.equal(hard, 'is quota-grounded (exhausted)');
  // Pre-AFH-05 records carry no `groundedBy` — they must still read as hard.
  assert.equal(
    describeHarnessGrounding({ provider: 'openai', primaryState: 'exhausted' }),
    'is quota-grounded (exhausted)',
  );
});

test('the fleet-quota payload is parsed exactly once per resolve, however many candidates are screened', async () => {
  // Review follow-up: the primary's hard+soft limbs and EVERY fallback candidate
  // read the same stdout, so the payload must be parsed once and queried from the
  // parsed rows — not re-parsed per lookup inside the candidate loop.
  const exec = buildFleetExec(fleetQuotaStdout({
    openai: 'exhausted',
    anthropic: 'exhausted',
    google: 'ok',
  }));
  const realParse = JSON.parse;
  let parseCalls = 0;
  JSON.parse = function countingParse(...args) {
    parseCalls += 1;
    return realParse.apply(this, args);
  };
  let result;
  try {
    result = await resolveCloserDispatchHarness({
      workerClass: 'hammer',
      fallbackWorkerClasses: ['claude-code', 'hammer-claude', 'gemini'],
      execFileImpl: exec.impl,
    });
  } finally {
    JSON.parse = realParse;
  }
  assert.equal(result.fellBack, true);
  assert.equal(result.workerClass, 'gemini', 'both anthropic candidates are grounded; google is not');
  assert.equal(parseCalls, 1, `fleet-quota payload parsed ${parseCalls}× (expected exactly 1)`);
});

test('providerAvailabilityFromStatuses / providerSoftGroundingFromStatuses answer from parsed rows', () => {
  const statuses = parseHqFleetQuotaStatus(fleetQuotaStdout({
    openai: { state: 'unknown', afhGrounding: afhGrounding({ grounded: true, signals: 5, kills: 5 }) },
    anthropic: 'ok',
  }));
  assert.equal(providerAvailabilityFromStatuses(statuses, { provider: 'anthropic' }).available, true);
  assert.equal(providerAvailabilityFromStatuses(statuses, { provider: 'openai' }).state, 'unknown');
  assert.equal(providerSoftGroundingFromStatuses(statuses, { provider: 'openai' }).grounded, true);
  assert.equal(providerSoftGroundingFromStatuses(statuses, { provider: 'anthropic' }).grounded, false);
  // Same fail-open guards as the stdout wrappers: no provider, unknown provider,
  // and a non-array rows argument must all stay ungrounded rather than throw.
  assert.equal(providerAvailabilityFromStatuses(statuses, {}).state, 'unknown-provider');
  assert.equal(providerSoftGroundingFromStatuses(statuses, {}).reason, 'unknown-provider');
  assert.equal(providerAvailabilityFromStatuses(null, { provider: 'openai' }).state, 'missing-provider-status');
  assert.equal(
    providerSoftGroundingFromStatuses(undefined, { provider: 'openai' }).reason,
    'missing-provider-status',
  );
});

test('primary provider untracked → never fall back (cannot prove a cap)', async () => {
  const exec = buildFleetExec(fleetQuotaStdout({ openai: 'exhausted' }));
  const result = await resolveCloserDispatchHarness({
    workerClass: 'some-bespoke-worker',
    fallbackWorkerClasses: ['claude-code'],
    execFileImpl: exec.impl,
  });
  assert.equal(result.fellBack, false);
  assert.equal(result.reason, 'primary-provider-untracked');
  assert.equal(exec.calls.length, 0);
});

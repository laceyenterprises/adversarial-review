import { afhGroundingSnapshotFromStdout, reviewerModelGrounding, applyAfhReviewerFallback, createAfhReviewerGroundingCache } from '../src/afh-reviewer-fallback.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectClaudeAccountLane, resolveClaudeBrokerProvider } from '../src/claude-account-routing.mjs';
import { harnessCapFromStatuses, parseHqFleetQuotaStatus } from '../src/fleet-quota-status.mjs';
import { resolveCloserDispatchHarness } from '../src/ama/harness-fallback.mjs';
import { resolveRemediationWorkerClassWithFallback } from '../src/remediation-worker-class-fallback.mjs';
import { isHammerWorkerClass } from '../src/ama/hammer-worker-class.mjs';
import { isCrossModelReviewWaived, reviewerRefusesBuilder, routePR } from '../src/adapters/subject/github-pr/routing.mjs';
import { claudeAccountFixture } from './helpers/claude-account-fixture.mjs';

for (const workerClass of ['hammer-claude', 'remediator-claude', 'claude-reviewer']) {
  for (const [label, options, suffix] of [
    ['healthy', {}, '-corp'], ['near cap', { corpNearCap: true }, '-corp'],
    ['unhealthy', { corpReady: false }, ''], ['capped', { corp: 'exhausted' }, ''],
    ['suspended', { corp: 'suspended' }, ''],
  ]) {
    test(`${workerClass}: ${label} selects the approved account`, () => {
      const result = selectClaudeAccountLane(JSON.stringify(claudeAccountFixture(options)), { workerClass });
      assert.equal(result.workerClass, workerClass + suffix);
      assert.equal(result.provider, suffix ? 'claude-code-corp' : 'claude-code');
      assert.equal(result.hold, false);
    });
  }
  test(`${workerClass}: neither account ready holds`, () => {
    const stdout = JSON.stringify(claudeAccountFixture({ corp: 'exhausted', primary: 'exhausted' }));
    assert.equal(selectClaudeAccountLane(stdout, { workerClass }).hold, true);
  });
}

test('stale/unknown weekly measurement never fabricates corporate headroom or primary fallback', () => {
  for (const status of ['stale', 'unknown', undefined]) {
    const fixture = claudeAccountFixture();
    fixture.reserveFloors['anthropic-oauth-corp'].weeklyMeasurement = { status };
    assert.equal(selectClaudeAccountLane(JSON.stringify(fixture), { workerClass: 'claude-reviewer' }).hold, true);
    fixture.reserveFloors['anthropic-oauth'].weeklyMeasurement = { status };
    assert.equal(selectClaudeAccountLane(JSON.stringify(fixture), { workerClass: 'claude-reviewer' }).hold, true);
  }
});

test('reserve/pause/model and soft-grounding remain account local', () => {
  for (const block of ['soft', 'model']) {
    const fixture = claudeAccountFixture();
    const row = fixture.providerStatuses[1];
    if (block === 'soft') row.afhGrounding = { grounded: true };
    else if (block === 'model') row.models = [{ model: 'synthetic-model', state: 'exhausted' }];
    else fixture.reserveFloors['anthropic-oauth-corp'][block] = true;
    const stdout = JSON.stringify(fixture);
    assert.equal(selectClaudeAccountLane(stdout, { workerClass: 'claude-reviewer', model: 'synthetic-model' }).provider, 'claude-code');
    const rows = parseHqFleetQuotaStatus(stdout);
    assert.equal(harnessCapFromStatuses(rows, { harness: 'claude-reviewer' }).capped, false);
  }
  const rows = parseHqFleetQuotaStatus(JSON.stringify(claudeAccountFixture({ primary: 'exhausted' })));
  assert.equal(harnessCapFromStatuses(rows, { harness: 'claude-reviewer-corp' }).available, true);
  assert.equal(harnessCapFromStatuses(rows, { harness: 'claude-reviewer' }).capped, true);
});

test('legacy projections retain ambiguity and builder classes cannot select privileged lanes', () => {
  assert.equal(selectClaudeAccountLane('{"providerStatuses":[]}', { workerClass: 'claude-reviewer' }), null);
  assert.equal(selectClaudeAccountLane(JSON.stringify(claudeAccountFixture()), { workerClass: 'claude-code' }), null);
  assert.throws(() => resolveClaudeBrokerProvider({ CLAUDE_BROKER_PROVIDER: 'unrecognized' }));
});

for (const [label, options, suffix] of [
  ['healthy', {}, '-corp'], ['near cap', { corpNearCap: true }, '-corp'],
  ['unhealthy', { corpReady: false }, ''], ['both capped', { corp: 'exhausted', primary: 'exhausted' }, null],
]) {
  const execFileImpl = async () => ({ stdout: JSON.stringify(claudeAccountFixture(options)) });
  test(`hammer fallback ${label} uses a hammer twin or holds`, async () => {
    const result = await resolveCloserDispatchHarness({ workerClass: 'hammer', fallbackWorkerClasses: ['hammer-claude'], execFileImpl,
      env: {}, modelForWorkerClass: () => null });
    if (suffix === null) assert.equal(result.hold, true);
    else {
      assert.equal(result.workerClass, 'hammer-claude' + suffix);
      assert.equal(isHammerWorkerClass(result.workerClass), true);
    }
  });
  test(`remediator fallback ${label} uses a remediator twin or holds`, async () => {
    const result = await resolveRemediationWorkerClassWithFallback({ primary: 'codex', fallbackWorkerClasses: ['remediator-claude'],
      reviewerModels: ['codex'], execFileImpl, env: {} });
    if (suffix === null) assert.equal(result.hold, true);
    else assert.equal(result.workerClass, 'remediator-claude' + suffix);
  });
}

test('preferred Claude lanes return to corporate on recovery without changing declarations', async () => {
  for (const workerClass of ['hammer-claude', 'hammer-claude-corp']) {
    const result = await resolveCloserDispatchHarness({ workerClass, execFileImpl: async () => ({ stdout: JSON.stringify(claudeAccountFixture()) }),
      env: {}, modelForWorkerClass: () => null });
    assert.equal(result.workerClass, 'hammer-claude-corp');
  }
});

test('both Claude accounts remain one builder/reviewer family', () => {
  for (const builder of ['claude-code', 'claude-code-corp', 'remediator-claude-corp']) {
    for (const reviewer of ['claude', 'claude-code', 'claude-reviewer-corp']) {
      assert.equal(isCrossModelReviewWaived(builder, reviewer), true);
      assert.equal(reviewerRefusesBuilder(builder, reviewer), true);
    }
  }
  assert.equal(reviewerRefusesBuilder('codex', 'claude-reviewer-corp'), false);
  assert.equal(routePR('[claude-code] synthetic change', null, { env: {}, topPath: '/dev/null' }).reviewerModel, 'codex');
});

test('AFH sees the selected corporate account before primary cap or native runtime failures', () => {
  const grounding = afhGroundingSnapshotFromStdout(JSON.stringify(claudeAccountFixture({ primary: 'exhausted' })));
  const status = reviewerModelGrounding({ ...grounding, localRuntimeGrounding: { claude: { available: false } } }, 'claude');
  assert.equal(status.grounded, false);
  assert.equal(status.brokerProvider, 'claude-code-corp');
  const route = applyAfhReviewerFallback({ builderClass: 'codex', baseRoute: { reviewerModel: 'claude', botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN' },
    grounding, geminiReviewerMode: 'fallback' });
  assert.equal(route.reviewerModel, 'claude');
  assert.notEqual(route.quotaBlocked, true);
});

test('unknown corporate evidence cannot trigger a cross-account or cross-harness switch', () => {
  const fixture = claudeAccountFixture({ corp: 'unknown' });
  const grounding = afhGroundingSnapshotFromStdout(JSON.stringify(fixture));
  assert.equal(grounding.claudeAccountSelection.hold, true);
  assert.equal(reviewerModelGrounding(grounding, 'claude').grounded, false);
});

test('AFH skips Claude fallback candidates with unknown or stale corporate evidence', () => {
  for (const evidence of ['unknown', 'stale']) {
    const fixture = claudeAccountFixture();
    fixture.reserveFloors['anthropic-oauth-corp'].weeklyMeasurement = { status: evidence };
    fixture.providerStatuses.push({ provider: 'google', authPath: 'oauth', state: 'exhausted' });
    const grounding = afhGroundingSnapshotFromStdout(JSON.stringify(fixture));
    assert.equal(reviewerModelGrounding(grounding, 'claude').accountHold, true);
    const route = applyAfhReviewerFallback({ builderClass: 'codex',
      baseRoute: { reviewerModel: 'gemini', botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN' },
      grounding, geminiReviewerMode: 'fallback' });
    assert.equal(route.reviewerModel, 'gemini');
    assert.equal(route.quotaBlocked, true);
    assert.equal(route.afhReviewerFallback, undefined);
  }
});

test('malformed or stale quota facts cannot authorize corporate or cause an account switch', () => {
  for (const value of [null, {}, { status: 'measured' }, { status: 'measured', percentRemaining: NaN }]) {
    const fixture = claudeAccountFixture();
    fixture.reserveFloors['anthropic-oauth-corp'].weeklyMeasurement = value;
    assert.equal(selectClaudeAccountLane(JSON.stringify(fixture), { workerClass: 'claude-reviewer' }).hold, true);
  }
  const fixture = claudeAccountFixture();
  fixture.providerStatuses[1].cachedEvidenceStale = true;
  assert.equal(selectClaudeAccountLane(JSON.stringify(fixture), { workerClass: 'claude-reviewer' }).hold, true);
});

test('provider name casing and whitespace preserve stale-evidence guards for both accounts', () => {
  for (const provider of ['Anthropic', ' anthropic ', ' ANTHROPIC ']) {
    const fixture = claudeAccountFixture();
    for (const row of fixture.providerStatuses.slice(0, 2)) row.provider = provider;
    const select = () => selectClaudeAccountLane(JSON.stringify(fixture), { workerClass: 'claude-reviewer' });
    assert.equal(select().provider, 'claude-code-corp');
    fixture.providerStatuses[1].cachedEvidenceStale = true;
    assert.equal(select().hold, true);
    fixture.reserveFloors['anthropic-oauth-corp'].nearCap = true;
    assert.equal(select().hold, true);
    fixture.providerStatuses[1].state = 'exhausted';
    assert.equal(select().provider, 'claude-code');
    fixture.providerStatuses[0].cachedEvidenceStale = true;
    assert.equal(select().hold, true);
  }
});

test('a stale-if-error cache cannot authorize a new corporate reviewer', async () => {
  let now = 1000;
  let reads = 0;
  const get = createAfhReviewerGroundingCache({ ttlMs: 10, nowFn: () => now,
    logger: { warn() {} }, readImpl: async () => ++reads === 1
      ? afhGroundingSnapshotFromStdout(JSON.stringify(claudeAccountFixture()))
      : { available: false, reason: 'synthetic-unavailable' } });
  assert.equal((await get()).claudeAccountSelection.hold, false);
  now += 11;
  const stale = await get();
  assert.equal(stale.claudeAccountSelection.hold, true);
  assert.equal(stale.claudeAccountSelection.reason, 'claude-account-evidence-unknown');
  assert.equal(reviewerModelGrounding(stale, 'claude').grounded, false);
});

for (const [label, options, provider, stale] of [
  ['reserve warning', { corpNearCap: true, primary: 'exhausted' }, 'claude-code-corp', false],
  ['measured cap', { corp: 'exhausted' }, 'claude-code', false],
  ['broker unavailable', { corpReady: false }, 'claude-code', false],
  ['stale evidence plus reserve warning', { corpNearCap: true }, null, true],
]) {
  test(`Claude queue spill: ${label}`, async () => {
    const { resolveReviewerWorkerClassWithFallback } = await import('../src/review-worker-class-fallback.mjs');
    const fixture = claudeAccountFixture(options);
    if (stale) fixture.providerStatuses[1].cachedEvidenceStale = true;
    const decision = await resolveReviewerWorkerClassWithFallback({
      primary: 'gemini', authorClass: 'codex', fallbackWorkerClasses: ['claude-code'],
      depthPressure: { engaged: true, reason: 'review-max-wait', waitSeconds: 481 },
      env: { GH_CLAUDE_REVIEWER_TOKEN: 'synthetic-token' },
      execFileImpl: async () => ({ stdout: JSON.stringify(fixture) }), logger: {},
    });
    assert.equal(decision.fellBack, provider !== null);
    if (provider) assert.equal(decision.claudeAccountSelection.provider, provider);
  });
}

test('corporate reserve flags do not spend primary quota; measured zero does', () => {
  const fixture = claudeAccountFixture({ corpNearCap: true });
  Object.assign(fixture.reserveFloors['anthropic-oauth-corp'], { active: true, paused: true });
  assert.equal(selectClaudeAccountLane(JSON.stringify(fixture), { workerClass: 'claude-reviewer' }).provider, 'claude-code-corp');
  fixture.reserveFloors['anthropic-oauth-corp'].weeklyMeasurement.percentRemaining = 0;
  assert.equal(selectClaudeAccountLane(JSON.stringify(fixture), { workerClass: 'claude-reviewer' }).provider, 'claude-code');
});

test('typed corporate spawn exhaustion persists an account-local hold until reset', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnReviewer } = await import('../src/reviewer-spawn-settle.mjs');
  const { readCorporateClaudeQuotaCooldown } = await import('../src/claude-account-routing.mjs');
  const root = mkdtempSync(join(tmpdir(), 'reviewspill-account-'));
  const requests = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const fixture = claudeAccountFixture({ corpNearCap: true });
    const account = selectClaudeAccountLane(JSON.stringify(fixture), { workerClass: 'claude-reviewer' });
    const result = await spawnReviewer({ rootDir: root, repo: 'sample/project', prNumber: 1,
      reviewerModel: 'claude', builderTag: 'codex', claudeAccountSelection: account,
      quotaCheckEnv: {}, readReviewerQuotaDecisionImpl: async () => ({ available: true, state: 'ok' }),
      reviewerRuntimeAdapterOverride: { async spawnReviewer(request) {
        requests.push(request);
        return { ok: false, failureClass: 'quota-exhausted', error: 'synthetic quota exhausted' };
      } },
      beginReviewerPassImpl() {}, completeReviewerPassImpl() {},
      readBestReviewerEvidenceTokenUsageImpl: async () => null, ledgerLookupSleepImpl: async () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(requests[0].subjectContext.claudeBrokerProvider, 'claude-code-corp');
    assert.ok(logs.some(line => /Spawning reviewer.*claude_account=corporate/.test(line)));
    const hold = readCorporateClaudeQuotaCooldown(root, { env: {} });
    assert.ok(hold);
    assert.equal(readCorporateClaudeQuotaCooldown(root, { env: {}, nowMs: Date.parse(hold.resetAt) }), null);
    const fallback = selectClaudeAccountLane(JSON.stringify(fixture), {
      workerClass: 'claude-reviewer', blockedWorkerClasses: ['claude-reviewer-corp'],
    });
    assert.equal(fallback.provider, 'claude-code');
  } finally { console.log = originalLog; rmSync(root, { recursive: true, force: true }); }
});

test('local corporate exhaustion still requires independent primary evidence on a legacy projection', () => {
  const result = selectClaudeAccountLane(JSON.stringify({ providerStatuses: [
    { provider: 'anthropic', authPath: 'oauth', state: 'ok' },
  ] }), { workerClass: 'claude-reviewer', blockedWorkerClasses: ['claude-reviewer-corp'] });
  assert.equal(result?.hold, true);
});

for (const trigger of ['quota', 'depth']) {
  for (const evidence of ['missing accounts', 'brokers unready', 'quota unmeasured']) {
    test(`Claude worker fallback refuses ${evidence} under ${trigger} pressure`, async () => {
      const { resolveReviewerWorkerClassWithFallback } = await import('../src/review-worker-class-fallback.mjs');
      const fixture = evidence === 'missing accounts'
        ? { providerStatuses: [
          { provider: 'anthropic', authPath: 'oauth', state: 'ok' },
        ] } : claudeAccountFixture({ corpReady: evidence !== 'brokers unready',
          primaryReady: evidence !== 'brokers unready' });
      if (evidence === 'quota unmeasured') fixture.reserveFloors = {};
      fixture.providerStatuses.push({ provider: 'google', authPath: 'oauth',
        state: trigger === 'quota' ? 'exhausted' : 'ok' });
      const decision = await resolveReviewerWorkerClassWithFallback({
        primary: 'gemini', authorClass: 'codex', fallbackWorkerClasses: ['claude-code'],
        depthPressure: trigger === 'depth'
          ? { engaged: true, reason: 'review-max-wait', waitSeconds: 481 } : null,
        env: { GH_CLAUDE_REVIEWER_TOKEN: 'synthetic-token' },
        execFileImpl: async () => ({ stdout: JSON.stringify(fixture) }), logger: {},
      });
      assert.equal(decision.fellBack, false);
      assert.equal(decision.workerClass, 'gemini');
      assert.equal(decision.reason, 'no-available-fallback');
    });
  }
}

test('unknown corporate evidence retains an assigned Claude hold even when primary quota is exhausted', async () => {
  const { resolveReviewerWorkerClassWithFallback } = await import('../src/review-worker-class-fallback.mjs');
  const fixture = claudeAccountFixture({ primary: 'exhausted' });
  fixture.reserveFloors['anthropic-oauth-corp'].weeklyMeasurement = { status: 'unknown' };
  fixture.providerStatuses.push({ provider: 'google', authPath: 'oauth', state: 'ok' });
  const decision = await resolveReviewerWorkerClassWithFallback({
    primary: 'claude-code', authorClass: 'codex', fallbackWorkerClasses: ['gemini'],
    execFileImpl: async () => ({ stdout: JSON.stringify(fixture) }), logger: {},
  });
  assert.equal(decision.fellBack, false);
  assert.equal(decision.claudeAccountHoldReason, 'claude-account-evidence-unknown');
});

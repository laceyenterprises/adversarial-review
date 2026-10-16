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
    ['healthy', {}, '-corp'], ['near cap', { corpNearCap: true }, ''],
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
  for (const block of ['active', 'paused', 'soft', 'model']) {
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
  ['healthy', {}, '-corp'], ['near cap', { corpNearCap: true }, ''],
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

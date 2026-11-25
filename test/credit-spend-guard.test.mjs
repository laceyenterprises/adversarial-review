// CREDITSPENDGUARD-01: an exhausted subscription plan is never a selectable
// Codex account, whatever credits it holds, and a reviewer whose quota cannot
// be read is held instead of being routed to an account that may bill credits.
// Synthetic fixtures only.
import './helpers/dispatch-files-preload.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexAccountFixture } from './helpers/codex-account-fixture.mjs';
import { spawnReviewer } from './helpers/reviewer-quota-fixture.mjs';
import { quotaStatusesFromSnapshot, codexPlanLimitExhausted } from '../src/fleet-quota-status.mjs';
import { selectCodexReviewerAccount, codexWorkerLaneFromSnapshot, readCorporateCodexQuotaCooldown } from '../src/codex-account-routing.mjs';
import { readReviewerQuotaDecision } from '../src/reviewer-spawn-settle.mjs';

const future = () => new Date(Date.now() + 86_400_000).toISOString();

// The provider reports its plan limit reached below a rounded 100 %, while the
// account still holds credits, so a turn would succeed and bill them.
function limitReachedPlan(fixture, authPath) {
  const row = fixture.providerStatuses.find(entry => entry.authPath === authPath);
  row.providerRateLimits = [{ limitId: 'codex', windowMinutes: 10080, usedPercent: 99, limitReached: true,
    fresh: true, resetsAt: future(), credits: { has_credits: true, balance: '100.0' } }];
  return fixture;
}

function availablePlan(fixture, authPath) {
  const row = fixture.providerStatuses.find(entry => entry.authPath === authPath);
  row.providerRateLimits = [{ limitId: 'codex', windowMinutes: 10080, usedPercent: 40,
    fresh: true, resetsAt: future(), credits: { has_credits: true, balance: '100.0' } }];
  return fixture;
}

test('predicate: used >= 100 % or provider limit reached is exhausted; credits never matter', () => {
  assert.equal(codexPlanLimitExhausted({ usedPercent: 100, credits: { has_credits: true } }), true);
  assert.equal(codexPlanLimitExhausted({ usedPercent: 99, limitReached: true }), true);
  assert.equal(codexPlanLimitExhausted({ usedPercent: 99, credits: { has_credits: true } }), false);
  assert.equal(codexPlanLimitExhausted({ usedPercent: Infinity }), false);
  assert.equal(codexPlanLimitExhausted(null), false);
});

test('a limit-reached plan with credits projects as exhausted until its reset', () => {
  const fixture = limitReachedPlan(codexAccountFixture(), 'oauth');
  const personal = quotaStatusesFromSnapshot(fixture).find(row => row.authPath === 'oauth');
  assert.equal(personal.state, 'exhausted');
  assert.equal(personal.stateSource, 'codex-plan-meter');
  fixture.providerStatuses[0].providerRateLimits[0].resetsAt = new Date(Date.now() - 1000).toISOString();
  assert.equal(quotaStatusesFromSnapshot(fixture).find(row => row.authPath === 'oauth').state, 'ok');
});

test('reviewer selection skips a limit-reached account that holds credits', () => {
  const fixture = limitReachedPlan(codexAccountFixture(), 'oauth-corp');
  const selected = selectCodexReviewerAccount(fixture);
  assert.equal(selected.hold, false);
  assert.equal(selected.provider, 'codex', 'falls through to the account with plan remaining');
  limitReachedPlan(fixture, 'oauth');
  assert.deepEqual([selectCodexReviewerAccount(fixture).hold, selectCodexReviewerAccount(fixture).reason],
    [true, 'no-ready-codex-account']);
});

for (const policy of ['personal-first', 'corporate-first']) {
  for (const workerClass of ['hammer', 'remediator-codex']) {
    test(`${workerClass} ${policy}: a limit-reached personal plan with credits is never chosen`, () => {
      const fixture = limitReachedPlan(codexAccountFixture(), 'oauth');
      const lane = codexWorkerLaneFromSnapshot(fixture, { workerClass, policy });
      assert.equal(lane.hold, false);
      assert.equal(lane.provider, 'codex-corp');
      assert.equal(lane.workerClass, workerClass === 'hammer' ? 'hammer-corp' : 'remediator-codex-corp');
      limitReachedPlan(fixture, 'oauth-corp');
      const none = codexWorkerLaneFromSnapshot(fixture, { workerClass, policy });
      assert.equal(none.hold, true);
      assert.equal(none.reason, 'no-ready-codex-account');
    });
  }
}

test('an available account is unaffected', () => {
  const fixture = availablePlan(availablePlan(codexAccountFixture(), 'oauth'), 'oauth-corp');
  assert.equal(selectCodexReviewerAccount(fixture).provider, 'codex-corp');
  assert.equal(codexWorkerLaneFromSnapshot(fixture, { workerClass: 'hammer', policy: 'personal-first' }).workerClass, 'hammer');
});

for (const [reviewerModel, provider, holds] of [
  ['codex', 'openai', true], ['claude-code', 'anthropic', true], ['gemini', 'google', false],
]) {
  test(`readReviewerQuotaDecision probe-error for ${reviewerModel} ${holds ? 'holds' : 'stays available'}`, async () => {
    const decision = await readReviewerQuotaDecision({ reviewerModel, env: {},
      execFileImpl: async () => { throw new Error('synthetic quota probe outage'); } });
    assert.equal(decision.state, 'probe-error');
    assert.equal(decision.provider, provider);
    assert.equal(decision.available, !holds);
    assert.equal(decision.capped, holds);
  });
}

for (const codexBrokerProvider of ['codex', 'codex-corp']) {
  test(`${codexBrokerProvider} reviewer is not spawned when its quota cannot be read`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'credit-spend-guard-'));
    try {
      const env = { ADVERSARIAL_REVIEW_STATE_DIR: stateDir };
      let spawnCalls = 0;
      const completed = [];
      const result = await spawnReviewer({
        repo: 'example/demo', prNumber: 7, reviewerModel: 'codex', codexBrokerProvider,
        botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN', reviewerHeadSha: 'deadbeef', reviewerSessionUuid: randomUUID(),
        reviewAttemptNumber: 1, reviewDbAttemptNumber: 1, maxRemediationRounds: 2, rootDir: stateDir,
        quotaCheckEnv: env,
        readReviewerQuotaDecisionImpl: async () => { throw new Error('synthetic quota probe outage'); },
        reviewerRuntimeAdapterOverride: { async spawnReviewer() { spawnCalls += 1; return { ok: true, reviewBody: 'x' }; } },
        beginReviewerPassImpl() {}, async completeReviewerPassImpl(_root, args) { completed.push(args); },
        postGitHubReviewWithCaptureImpl: async () => {}, readBestReviewerEvidenceTokenUsageImpl: async () => null,
        ledgerLookupSleepImpl: async () => {},
      });
      assert.equal(spawnCalls, 0);
      assert.equal(result.reason, 'quota-probe-unavailable');
      assert.equal(result.transient, true);
      assert.equal(result.quotaState, 'probe-error');
      assert.equal(completed[0].metadata.quotaReason, 'quota-unverifiable-credit-capable');
      assert.equal(readCorporateCodexQuotaCooldown(stateDir, { env }), null,
        'an unreadable quota is not corporate exhaustion');
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });
}

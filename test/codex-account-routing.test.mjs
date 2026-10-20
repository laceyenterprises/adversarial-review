import test from 'node:test';
import assert from 'node:assert/strict';
import { codexAccountFixture } from './helpers/codex-account-fixture.mjs';
import { afhGroundingSnapshotFromStdout, applyAfhReviewerFallback, createAfhReviewerGroundingCache, reviewerModelGrounding } from '../src/afh-reviewer-fallback.mjs';
import { resolveReviewerWorkerClassWithFallback, applyReviewerWorkerClassFallbackToRoute } from '../src/review-worker-class-fallback.mjs';
import { REVIEWER_ROUTE_BY_MODEL } from '../src/adapters/subject/github-pr/routing.mjs';

const groundingFor = fixture => afhGroundingSnapshotFromStdout(JSON.stringify(fixture));
const direct = fixture => applyAfhReviewerFallback({ builderClass: 'claude-code',
  baseRoute: REVIEWER_ROUTE_BY_MODEL.codex, grounding: groundingFor(fixture), geminiReviewerMode: 'off' });
const spill = fixture => resolveReviewerWorkerClassWithFallback({ primary: 'gemini', authorClass: 'claude-code',
  fallbackWorkerClasses: ['codex'], depthPressure: { engaged: true, reason: 'review-max-wait', waitSeconds: 481 },
  env: { GH_CODEX_REVIEWER_TOKEN: 'synthetic-token' },
  execFileImpl: async () => ({ stdout: JSON.stringify(fixture) }) });

test('missing all corporate evidence holds AFH and worker spill routing consistently', async () => {
  const fixture = codexAccountFixture();
  fixture.providerStatuses = fixture.providerStatuses.filter(row => row.authPath !== 'oauth-corp');
  delete fixture.reserveFloors['openai-oauth-corp'];
  delete fixture.brokerAuth.provider_states['codex-corp'];
  const snapshot = groundingFor(fixture);
  assert.deepEqual(snapshot.codexAccountSelection, { hold: true, reason: 'codex-account-evidence-unknown' });
  assert.equal(reviewerModelGrounding(snapshot, 'codex').accountHold, true);
  assert.equal(direct(fixture).quotaBlocked, true);
  assert.equal((await spill(fixture)).fellBack, false);
});

test('repeated corporate quota failures preserve the longest active cooldown', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { recordCorporateCodexQuotaCooldown, readCorporateCodexQuotaCooldown } = await import('../src/codex-account-routing.mjs');
  const root = mkdtempSync(join(tmpdir(), 'codex-cooldown-repeat-'));
  const nowMs = Date.parse('2026-10-17T20:00:00Z');
  const options = { env: {}, nowMs };
  try {
    const resetAt = new Date(nowMs + 6 * 60 * 60 * 1000).toISOString();
    recordCorporateCodexQuotaCooldown(root, { ...options, resetAt });
    for (const shorter of [null, 'invalid', new Date(nowMs - 1).toISOString(),
      new Date(nowMs + 60 * 60 * 1000).toISOString()]) {
      assert.equal(recordCorporateCodexQuotaCooldown(root, { ...options, resetAt: shorter }).resetAt, resetAt);
      assert.equal(readCorporateCodexQuotaCooldown(root, options).resetAt, resetAt);
    }
    const later = new Date(nowMs + 12 * 60 * 60 * 1000).toISOString();
    assert.equal(recordCorporateCodexQuotaCooldown(root, { ...options, resetAt: later }).resetAt, later);
    const expiredNow = Date.parse(later) + 1;
    assert.equal(recordCorporateCodexQuotaCooldown(root, { env: {}, nowMs: expiredNow }).resetAt,
      new Date(expiredNow + 15 * 60 * 1000).toISOString());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AFH detects snake_case corporate auth paths without corporate broker evidence', () => {
  const fixture = codexAccountFixture();
  fixture.providerStatuses = fixture.providerStatuses.map(({ authPath, ...row }) => ({ ...row, auth_path: authPath }));
  delete fixture.brokerAuth.provider_states['codex-corp'];
  const snapshot = groundingFor(fixture);
  assert.equal(snapshot.providers['openai/oauth-corp'].authPath, 'oauth-corp');
  assert.deepEqual(snapshot.codexAccountSelection, { hold: true, reason: 'codex-account-evidence-unknown' });
  assert.equal(reviewerModelGrounding(snapshot, 'codex').accountHold, true);
  assert.equal(direct(fixture).quotaBlocked, true);
});

test('REVIEWCORPFIRST-01: Codex spill selects corporate while personal still has capacity', async () => {
  const fixture = codexAccountFixture();
  const decision = await spill(fixture);
  assert.equal(decision.workerClass, 'codex');
  const applied = applyReviewerWorkerClassFallbackToRoute({ route: REVIEWER_ROUTE_BY_MODEL.gemini,
    decision, authorClass: 'claude-code', reviewerRouteByModel: REVIEWER_ROUTE_BY_MODEL });
  assert.equal(applied.route.codexBrokerProvider, 'codex-corp');
  assert.equal(direct(fixture).codexBrokerProvider, 'codex-corp');
});

for (const [label, options] of [['capped', { corp: 'exhausted' }], ['not ready', { corpReady: false }]]) {
  test(`REVIEWCORPFIRST-01: personal Codex is selected only when corporate is ${label}`, async () => {
    const fixture = codexAccountFixture(options);
    assert.equal(reviewerModelGrounding(groundingFor(fixture), 'codex').brokerProvider, 'codex');
    assert.equal((await spill(fixture)).codexBrokerProvider, 'codex');
  });
}

for (const evidence of ['stale', 'unknown', 'missing', 'cached-stale']) {
  test(`REVIEWCORPFIRST-01: ${evidence} corporate evidence holds with healthy personal capacity`, async () => {
    const fixture = codexAccountFixture();
    if (evidence === 'missing') delete fixture.brokerAuth.provider_states['codex-corp'];
    else if (evidence === 'cached-stale') fixture.providerStatuses[1].cachedEvidenceStale = true;
    else {
      const reading = { status: evidence, confidence: evidence, inferred: false, percentRemaining: 99 };
      fixture.reserveFloors['openai-oauth-corp'] = {
        weeklyMeasurement: { ...reading }, measurement: { ...reading },
      };
      const personal = { status: 'measured', confidence: 'measured', inferred: false, percentRemaining: 6 };
      fixture.reserveFloors['openai-oauth'] = {
        weeklyMeasurement: { ...personal }, measurement: { ...personal },
      };
    }
    assert.deepEqual(groundingFor(fixture).codexAccountSelection,
      { hold: true, reason: 'codex-account-evidence-unknown' });
    const status = reviewerModelGrounding(groundingFor(fixture), 'codex');
    assert.equal(status.accountHold, true);
    assert.equal(status.grounded, false, 'unknown evidence cannot trigger a model switch');
    assert.equal((await spill(fixture)).fellBack, false);
  });
}

test('REVIEWCORPFIRST-01: a failed quota refresh holds cached corporate admission', async () => {
  let now = 0;
  const get = createAfhReviewerGroundingCache({ nowFn: () => now, ttlMs: 1, logger: {},
    readImpl: async () => now === 0 ? groundingFor(codexAccountFixture()) : { available: false, reason: 'synthetic-read-failure' } });
  assert.equal(reviewerModelGrounding(await get(), 'codex').brokerProvider, 'codex-corp');
  now = 2;
  assert.equal(reviewerModelGrounding(await get(), 'codex').accountHold, true);
});

for (const [label, mutate] of [
  ['measured zero', f => { f.reserveFloors['openai-oauth-corp'].weeklyMeasurement.percentRemaining = 0; }],
  ['model cap', f => { f.providerStatuses[1].models = [{ model: 'synthetic-model', state: 'exhausted' }]; }],
  ['soft grounding', f => { f.providerStatuses[1].afhGrounding = { grounded: true }; }],
]) test(`corporate ${label} permits independently admitted personal capacity`, async () => {
  const { selectCodexReviewerAccount } = await import('../src/codex-account-routing.mjs');
  const fixture = codexAccountFixture();
  mutate(fixture);
  assert.equal(selectCodexReviewerAccount(fixture, { model: 'synthetic-model' }).provider, 'codex');
  fixture.brokerAuth.provider_states.codex.ready = false;
  assert.equal(selectCodexReviewerAccount(fixture, { model: 'synthetic-model' }).hold, true);
});

test('corporate reserve flags alone retain corporate Codex', () => {
  const fixture = codexAccountFixture();
  Object.assign(fixture.reserveFloors['openai-oauth-corp'], { active: true, nearCap: true, paused: true });
  assert.equal(direct(fixture).codexBrokerProvider, 'codex-corp');
});

test('typed corporate Codex exhaustion persists before settlement and permits personal selection', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnReviewer } = await import('../src/reviewer-spawn-settle.mjs');
  const { selectCodexReviewerAccount, readCorporateCodexQuotaCooldown } = await import('../src/codex-account-routing.mjs');
  const root = mkdtempSync(join(tmpdir(), 'codex-review-account-'));
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const result = await spawnReviewer({ rootDir: root, repo: 'sample/project', prNumber: 1,
      reviewerModel: 'codex', builderTag: 'claude-code', codexBrokerProvider: 'codex-corp',
      quotaCheckEnv: {}, readReviewerQuotaDecisionImpl: async args => {
        assert.equal(args.codexBrokerProvider, 'codex-corp');
        return { available: true, state: 'ok' };
      },
      reviewerRuntimeAdapterOverride: { async spawnReviewer(request) {
        assert.equal(request.subjectContext.codexBrokerProvider, 'codex-corp');
        return { ok: false, failureClass: 'quota-exhausted', error: 'synthetic quota exhausted' };
      } },
      onPostOperationSettled() { assert.ok(readCorporateCodexQuotaCooldown(root, { env: {} })); },
      beginReviewerPassImpl() {}, completeReviewerPassImpl() {},
      readBestReviewerEvidenceTokenUsageImpl: async () => null, ledgerLookupSleepImpl: async () => {},
    });
    assert.equal(result.ok, false);
    assert.ok(logs.some(line => /Spawning reviewer.*codex_account=corporate/.test(line)));
    const hold = readCorporateCodexQuotaCooldown(root, { env: {} });
    assert.ok(hold);
    assert.equal(readCorporateCodexQuotaCooldown(root, { env: {}, nowMs: Date.parse(hold.resetAt) }), null);
    assert.equal(selectCodexReviewerAccount(codexAccountFixture(), { corporateExhausted: true }).provider, 'codex');
  } finally { console.log = originalLog; rmSync(root, { recursive: true, force: true }); }
});


test('AFH rollback retains corporate account admission without enabling model fallback', async () => {
  const { readAfhReviewerGrounding } = await import('../src/afh-reviewer-fallback.mjs');
  let reads = 0;
  const grounding = await readAfhReviewerGrounding({
    env: { ADVERSARIAL_AFH_REVIEWER_FALLBACK: '0' }, includeFleetQuotaStatus: true,
    claudeRuntimeProbeUid: 1234, claudeRuntimeProbeImpl: () => assert.fail('AFH rollback must not probe model runtime'),
    execFileImpl: async () => { reads++; return { stdout: JSON.stringify(codexAccountFixture()) }; },
  });
  assert.equal(reads, 1);
  assert.equal(grounding.claudeAccountSelection, null);
  assert.equal(grounding.claudeAccountSnapshot, null);
  const route = applyAfhReviewerFallback({ builderClass: 'claude-code',
    baseRoute: REVIEWER_ROUTE_BY_MODEL.codex, grounding, geminiReviewerMode: 'always-on' });
  assert.equal(route.reviewerModel, 'codex');
  assert.equal(route.codexBrokerProvider, 'codex-corp');
  assert.equal(route.afhReviewerFallback, undefined);
});

test('worker spills check the pinned reviewer model on the corporate account', async () => {
  const fixture = codexAccountFixture();
  fixture.providerStatuses[1].models = [{ model: 'synthetic-model', state: 'exhausted' }];
  const decision = await resolveReviewerWorkerClassWithFallback({ primary: 'gemini', authorClass: 'claude-code',
    fallbackWorkerClasses: ['codex'], depthPressure: { engaged: true, reason: 'review-max-wait' },
    env: { GH_CODEX_REVIEWER_TOKEN: 'synthetic-token', CODEX_MODEL_ID: 'synthetic-model' },
    execFileImpl: async () => ({ stdout: JSON.stringify(fixture) }) });
  assert.equal(decision.codexBrokerProvider, 'codex');
});


for (const kind of ['execution', 'timeout']) test(`${kind} fallback selects corporate Codex and skips stale corporate evidence`, async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { recordCascadeFailure } = await import('../src/reviewer-cascade.mjs');
  const { selectReviewerRouteForAttempt } = await import('../src/reviewer-route-selection.mjs');
  const root = mkdtempSync(join(tmpdir(), 'codex-review-fallback-'));
  try {
    if (kind === 'timeout') recordCascadeFailure(root, { repo: 'sample/project', prNumber: 1,
      failureClass: 'reviewer-timeout', reviewerModel: 'gemini', failedAt: new Date().toISOString() });
    const fixture = codexAccountFixture();
    const select = () => selectReviewerRouteForAttempt({ rootDir: root, repoPath: 'sample/project', prNumber: 1,
      subject: { builderClass: 'claude-code' }, baseRoute: REVIEWER_ROUTE_BY_MODEL.gemini,
      headSha: 'synthetic-head', currentRow: { review_status: 'failed', reviewer: 'gemini',
        reviewer_head_sha: 'synthetic-head', failure_message: '[quota-exhausted] synthetic exhaustion', infra_auto_recover_attempts: 1 },
      env: kind === 'timeout' ? { AGENT_OS_REVIEWER_EXEC_FALLBACK_THRESHOLD: '0',
        ADVERSARIAL_REVIEW_TIMEOUT_FALLBACK_THRESHOLD: '1', ADVERSARIAL_REVIEW_TIMEOUT_FALLBACK_MODEL: 'codex' } : {},
      afhGrounding: groundingFor(fixture) });
    assert.equal(select().reviewerModel, 'codex');
    assert.equal(select().codexBrokerProvider, 'codex-corp');
    fixture.providerStatuses[1].cachedEvidenceStale = true;
    assert.equal(select().reviewerModel, 'gemini');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('selected corporate cap at spawn preflight persists a cooldown without launching', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnReviewer } = await import('../src/reviewer-spawn-settle.mjs');
  const { readCorporateCodexQuotaCooldown } = await import('../src/codex-account-routing.mjs');
  const root = mkdtempSync(join(tmpdir(), 'codex-review-preflight-'));
  try {
    const result = await spawnReviewer({ rootDir: root, repo: 'sample/project', prNumber: 1,
      reviewerModel: 'codex', builderTag: 'claude-code', codexBrokerProvider: 'codex-corp', quotaCheckEnv: {},
      readReviewerQuotaDecisionImpl: async () => ({ available: false, capped: true, state: 'exhausted' }),
      reviewerRuntimeAdapterOverride: { spawnReviewer() { assert.fail('capped account cannot launch'); } },
      beginReviewerPassImpl() {}, completeReviewerPassImpl() {},
    });
    assert.equal(result.failureClass, 'quota-exhausted');
    assert.ok(readCorporateCodexQuotaCooldown(root, { env: {} }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

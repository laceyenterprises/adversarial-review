import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAgyReviewerIdentityPool, readReviewerGeminiPoolAvailability, runWithAgyReviewerIdentity,
} from '../src/agy-reviewer-identities.mjs';
import {
  afhGroundingSnapshotFromStdout, afhReviewerFallbackDecision, applyAfhReviewerFallbackDecision,
  reviewerModelGrounding,
} from '../src/afh-reviewer-fallback.mjs';
import { resolveReviewerWorkerClassWithFallback } from '../src/review-worker-class-fallback.mjs';
import { resolveGeminiCredentialConcurrencyForDispatchCandidates } from '../src/reviewer-runtime-support.mjs';
import { runBoundedReviewerDispatchQueue } from '../src/watcher-reviewer-pool.mjs';

import { createReviewerQuotaBlockLogger } from '../src/reviewer-quota-block-log.mjs';
import { spawnReviewer, settleReviewerAttempt } from '../src/reviewer-spawn-settle.mjs';
import Database from 'better-sqlite3';
import { prepareReleaseReviewerClaim } from '../src/review-state-statements.mjs';

const quiet = { log() {}, warn() {}, error() {} };
const adapter = { describe: () => ({ capabilities: { agyReviewerIdentity: true } }) };
const fleet = JSON.stringify({ providerStatuses: [
  { provider: 'google', authPath: 'agy', state: 'exhausted' },
  { provider: 'anthropic', authPath: 'oauth', state: 'exhausted' },
  { provider: 'openai', authPath: 'oauth', state: 'ok' },
] });
function makePool(cooled) {
  return createAgyReviewerIdentityPool({
    env: {}, log: quiet, hqOwner: 'owner-identity',
    loadIdentities: () => ['owner-identity', 'reviewer-b'], resolveRuntime: () => 'antigravity',
    readQuotaCooldownImpl: (user) => cooled.has(user) ? { resetAt: '2099-01-01T00:00:00Z' } : null,
    readActiveRunRecordsImpl: () => [], readBootstrapRecordImpl: () => null,
    listUserProcessesImpl: async () => ({ ok: true, processes: [] }),
    referenceSettings: () => [],
    runPinnedImpl: async ({ args }) => ({ code: 0, stdout: args[0] === 'status'
      ? 'keychain.exists=yes\nkeychain.item=readable\nsettings.valid=yes' : '' }),
  });
}
async function grounding(pool) {
  return { ...afhGroundingSnapshotFromStdout(fleet),
    geminiPoolAvailability: await readReviewerGeminiPoolAvailability({ pool, adapter }) };
}

test('GEMPOOL-01: owner cooled and second identity ready overrides exhausted fleet and dispatches one seat', async () => {
  const pool = makePool(new Set(['owner-identity']));
  const snapshot = await grounding(pool);
  assert.equal(reviewerModelGrounding(snapshot, 'gemini').grounded, false);
  const decision = afhReviewerFallbackDecision({ builderClass: 'codex',
    baseRoute: { reviewerModel: 'gemini', builderClass: 'codex' }, grounding: snapshot,
    geminiReviewerMode: 'always-on' });
  const fallback = afhReviewerFallbackDecision({ builderClass: 'codex',
    baseRoute: { reviewerModel: 'claude', builderClass: 'codex' }, grounding: snapshot,
    geminiReviewerMode: 'always-on' });
  assert.equal(fallback.to, 'gemini', 'pool readiness also admits Gemini as a fallback target');
  const route = applyAfhReviewerFallbackDecision({ reviewerModel: 'gemini' }, decision);
  assert.equal(route.reviewerModel, 'gemini');
  assert.notEqual(route.quotaBlocked, true);
  const spill = await resolveReviewerWorkerClassWithFallback({
    authorClass: 'codex', primary: 'gemini', fallbackWorkerClasses: ['codex', 'claude-code'],
    agyReviewerIdentityPool: pool, reviewerRuntimeAdapter: adapter,
    execFileImpl: async () => ({ stdout: fleet }), logger: quiet,
  });
  assert.equal(spill.fellBack, false);
  assert.equal(spill.reason, 'primary-available');
  const dispatched = [];
  const candidates = [{ repoPath: 'example/review', prNumber: 1, reviewerModel: route.reviewerModel,
    reviewerRuntimeAdapter: adapter, run: () => runWithAgyReviewerIdentity({
      reviewerModel: route.reviewerModel, adapter, pool, log: quiet,
    }, async (identity) => { dispatched.push(identity.user); return { ok: true }; }),
  }];
  const cap = await resolveGeminiCredentialConcurrencyForDispatchCandidates(candidates, {
    identityPool: pool, logger: quiet, fetchCredentialConcurrency: async () => { throw Error('no broker'); },
  });
  assert.equal(cap, 1);
  const result = await runBoundedReviewerDispatchQueue(candidates, {
    maxConcurrent: 1, geminiCredentialConcurrency: cap, logger: quiet,
  });
  assert.equal(result.dispatched, 1);
  assert.deepEqual(dispatched, ['reviewer-b']);
});

test('GEMPOOL-01: all identities cooled grounds Gemini; cooldown recovery is read without waiting for fleet refresh', async () => {
  const cooled = new Set(['owner-identity', 'reviewer-b']);
  const pool = makePool(cooled);
  assert.equal(reviewerModelGrounding(await grounding(pool), 'gemini').grounded, true);
  const resolveSpill = () => resolveReviewerWorkerClassWithFallback({
    authorClass: 'codex', primary: 'gemini', fallbackWorkerClasses: ['codex', 'claude-code'],
    agyReviewerIdentityPool: pool, execFileImpl: async () => ({ stdout: fleet }), logger: quiet,
  });
  assert.equal((await resolveSpill()).quotaBlocked, true);
  cooled.delete('reviewer-b');
  await pool.refreshReadiness();
  assert.equal(reviewerModelGrounding(await grounding(pool), 'gemini').grounded, false);
  const recovered = await resolveSpill();
  assert.equal(recovered.reason, 'primary-available');
  assert.notEqual(recovered.quotaBlocked, true);
});

test('GEMPOOL-01: legacy pool and runtime without identity support retain fleet grounding', async () => {
  const pool = makePool(new Set(['owner-identity']));
  assert.equal(await readReviewerGeminiPoolAvailability({ pool, adapter: { describe: () => ({}) } }), null);
  assert.equal(await readReviewerGeminiPoolAvailability({ pool: { plan: () => ({ multi: false }) } }), null);
  assert.equal(reviewerModelGrounding(afhGroundingSnapshotFromStdout(fleet), 'gemini').grounded, true);
});

test('GEMPOOL-01: grounded Gemini and Claude defer a codex builder and log once per grounding state', async () => {
  const pool = makePool(new Set(['owner-identity', 'reviewer-b']));
  const snapshot = await grounding(pool);
  const baseRoute = { reviewerModel: 'gemini', builderClass: 'codex' };
  const decision = afhReviewerFallbackDecision({ builderClass: 'codex', baseRoute,
    grounding: snapshot, geminiReviewerMode: 'always-on' });
  assert.equal(decision.applied, false);
  assert.ok(decision.considered.some((entry) => entry.reviewerModel === 'codex'
    && entry.reason === 'codex-builder-integrity-guard'));
  const route = applyAfhReviewerFallbackDecision(baseRoute, decision);
  assert.equal(route.quotaBlocked, true);
  assert.equal(route.quotaGrounding.source, 'agy-reviewer-identity-pool');
  const spill = await resolveReviewerWorkerClassWithFallback({
    authorClass: 'codex', primary: 'gemini', fallbackWorkerClasses: ['codex', 'claude-code'],
    agyReviewerIdentityPool: pool, execFileImpl: async () => ({ stdout: fleet }), logger: quiet,
  });
  assert.equal(spill.fellBack, false);
  assert.equal(spill.quotaBlocked, true);
  const lines = [];
  const logBlock = createReviewerQuotaBlockLogger();
  const candidate = { repoPath: 'example/review', prNumber: 2, route, logger: { warn: (line) => lines.push(line) } };
  assert.equal(logBlock(candidate), true);
  assert.equal(logBlock(candidate), true);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /DEFERRED repo=example\/review pr=2 reviewer=gemini source=agy-reviewer-identity-pool state=exhausted/);
  assert.match(lines[0], /no review attempt spent/);
  logBlock({ ...candidate, route: { ...route, quotaGrounding: { ...route.quotaGrounding, state: 'suspended' } } });
  assert.equal(lines.length, 2);
  logBlock({ ...candidate, route: { ...route, quotaGrounding: { ...route.quotaGrounding, source: 'fleet-quota-status' } } });
  assert.equal(lines.length, 3);
  assert.equal(logBlock({ ...candidate, route: { reviewerModel: 'gemini' } }), false);
  logBlock(candidate);
  assert.equal(lines.length, 4, 're-entering a blocked state logs again');
  logBlock({ ...candidate, prNumber: 3 });
  assert.equal(lines.length, 5, 'each candidate has its own state');
});

for (const builderTag of ['codex', 'clio-agent']) {
  test(`GEMPOOL-01: routing refusal for ${builderTag} releases only its claim without charging attempts`, async () => {
    const result = await spawnReviewer({ builderTag, reviewerModel: 'codex',
      reviewerRuntimeAdapterOverride: { spawnReviewer() { throw Error('must not spawn'); } } });
    assert.equal(result.failureClass, 'bug');
    assert.equal(result.routingRefusal, true);
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE reviewed_prs (
        repo TEXT, pr_number INTEGER, review_status TEXT, review_attempts INTEGER,
        reviewer_session_uuid TEXT, reviewer_started_at TEXT, reviewer_head_sha TEXT,
        reviewer_timeout_ms INTEGER, reviewer_lease_expires_at TEXT, reviewer_pgid INTEGER
      ); INSERT INTO reviewed_prs VALUES ('example/review', 4, 'reviewing', 2,
        'owned-session', NULL, 'synthetic-head', NULL, NULL, NULL);`);
      const statements = { releaseReviewerClaim: prepareReleaseReviewerClaim(db),
        markFailed: { run() { throw Error('must not charge failed attempt'); } },
        releaseReviewLease: { run() { throw Error('must not charge lease release'); } },
      };
      // A late refusal must not release a replacement reviewer's claim.
      settleReviewerAttempt({ repoPath: 'example/review', prNumber: 4, result,
        reviewerSessionUuid: 'old-session', statements, log: quiet });
      assert.equal(db.prepare('SELECT review_status FROM reviewed_prs').get().review_status, 'reviewing');
      settleReviewerAttempt({ repoPath: 'example/review', prNumber: 4, result,
        reviewerSessionUuid: 'owned-session', statements, log: quiet });
      assert.deepEqual(db.prepare('SELECT review_status, review_attempts, reviewer_session_uuid FROM reviewed_prs').get(),
        { review_status: 'pending', review_attempts: 2, reviewer_session_uuid: null });
    } finally { db.close(); }
  });
}


test('GEMPOOL-01: spawn-time fleet guard admits the ready pool identity', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'gempool-spawn-'));
  const pool = makePool(new Set(['owner-identity']));
  let spawned = 0;
  try {
    const result = await spawnReviewer({
      rootDir, repo: 'example/review', prNumber: 5, builderTag: 'codex', reviewerModel: 'gemini',
      botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN', reviewerHeadSha: 'synthetic-head',
      reviewerSessionUuid: 'synthetic-session', quotaCheckEnv: {}, agyReviewerIdentityPool: pool,
      reviewerRuntimeAdapterOverride: { ...adapter, spawnReviewer: async (request) => {
        spawned += 1;
        assert.equal(request.subjectContext.agyIdentity.user, 'reviewer-b');
        return { ok: false, failureClass: 'fixture-stop' };
      } },
      readReviewerQuotaDecisionImpl: async () => ({ available: false, state: 'exhausted', provider: 'google' }),
      beginReviewerPassImpl() {}, completeReviewerPassImpl() {},
      readBestReviewerEvidenceTokenUsageImpl: async () => null, ledgerLookupSleepImpl: async () => {},
    });
    assert.equal(spawned, 1);
    assert.equal(result.failureClass, 'fixture-stop');
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});


test('GEMPOOL-01: unrelated bug-class failures still charge a review attempt', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'gempool-bug-'));
  let attempts = 2;
  try {
    settleReviewerAttempt({ rootDir, repoPath: 'example/review', prNumber: 6, env: {}, leaseRecoveryEnabled: false,
      result: { ok: false, failureClass: 'bug', error: 'synthetic implementation bug' },
      statements: {
        markFailed: { run() { attempts += 1; } },
        getReviewRow: { get: () => ({ review_attempts: attempts }) },
        releaseReviewerClaim: { run() { throw Error('unrelated bugs must not release for free'); } },
      }, log: quiet,
    });
    assert.equal(attempts, 3);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});


test('GEMPOOL-01: pool grounding preserves the existing AFH disable switch', async () => {
  const pool = makePool(new Set(['owner-identity', 'reviewer-b']));
  const baseRoute = { reviewerModel: 'gemini', builderClass: 'codex' };
  const decision = afhReviewerFallbackDecision({ builderClass: 'codex', baseRoute,
    grounding: { available: false, reason: 'afh-reviewer-fallback-disabled',
      geminiPoolAvailability: await readReviewerGeminiPoolAvailability({ pool, adapter }) },
    geminiReviewerMode: 'always-on' });
  assert.equal(decision.applied, false);
  assert.equal(applyAfhReviewerFallbackDecision(baseRoute, decision), baseRoute);
});

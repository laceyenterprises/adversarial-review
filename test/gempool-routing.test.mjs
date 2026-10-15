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
  cooled.delete('reviewer-b');
  await pool.refreshReadiness();
  assert.equal(reviewerModelGrounding(await grounding(pool), 'gemini').grounded, false);
});

test('GEMPOOL-01: legacy pool and runtime without identity support retain fleet grounding', async () => {
  const pool = makePool(new Set(['owner-identity']));
  assert.equal(await readReviewerGeminiPoolAvailability({ pool, adapter: { describe: () => ({}) } }), null);
  assert.equal(await readReviewerGeminiPoolAvailability({ pool: { plan: () => ({ multi: false }) } }), null);
  assert.equal(reviewerModelGrounding(afhGroundingSnapshotFromStdout(fleet), 'gemini').grounded, true);
});

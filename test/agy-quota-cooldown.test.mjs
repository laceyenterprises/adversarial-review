import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgyReviewerIdentityPool, readReviewerGeminiQuotaCooldown, runWithAgyReviewerIdentity } from '../src/agy-reviewer-identities.mjs';
import { startGeminiQuotaCooldown } from '../src/gemini-quota-cooldown.mjs';
import { parseReviewerQuotaExhaustion } from '../src/reviewer-quota-signal.mjs';

const owner = 'owner-identity';
const added = 'reviewer-b';
const adapter = { describe: () => ({ id: 'cli-direct', capabilities: { agyReviewerIdentity: true } }) };

function fixture(identities = [owner, added]) {
  const rootDir = mkdtempSync(join(tmpdir(), 'agy-cooldown-'));
  const env = { ADVERSARIAL_REVIEW_STATE_DIR: rootDir };
  let clock = Date.parse('2026-10-14T00:00:00Z');
  const pool = createAgyReviewerIdentityPool({
    hqOwner: owner, env, now: () => clock, runStateRootDir: rootDir,
    loadIdentities: () => identities, resolveRuntime: () => 'antigravity',
    log: { info() {}, log() {}, warn() {} }, leaseWaitMs: 0,
    readActiveRunRecordsImpl: () => [], readBootstrapRecordImpl: () => ({ ready: true }),
    referenceSettings: () => [], listUserProcessesImpl: async () => ({ ok: true, processes: [] }),
    runPinnedImpl: async ({ args }) => ({ code: 0, stdout: args[0] === 'status'
      ? 'keychain.exists=yes\nkeychain.item=timeout\ntoken.file=ready\ntoken.owner=yes\ntoken.mode=600\nhome.mode=700\nsettings.valid=yes\n' : '' }),
  });
  const options = () => ({ rootDir, env, hqOwner: owner, nowMs: clock, log: {} });
  return { pool, rootDir, env, options, setClock: value => { clock = value; }, cleanup: () => rmSync(rootDir, { recursive: true, force: true }) };
}

test('AGYCOOLDOWN-01: quota on the first identity leaves Gemini on and the next lease uses the second', async () => {
  const f = fixture();
  try {
    await f.pool.refreshReadiness();
    await runWithAgyReviewerIdentity({ reviewerModel: 'gemini', adapter, pool: f.pool }, async (_identity, lease) => {
      assert.equal(lease.user, owner);
      const signal = parseReviewerQuotaExhaustion({ stderr: 'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 50h', nowMs: f.options().nowMs });
      startGeminiQuotaCooldown({ ...f.options(), identityUser: lease.user, signal });
      return { ok: false, failureClass: 'quota-exhausted' };
    });
    assert.equal(readReviewerGeminiQuotaCooldown({ ...f.options(), pool: f.pool, adapter }), null);
    assert.equal(await f.pool.refreshReadiness(), 1);
    const lease = await f.pool.acquire({ reviewId: 'next-review' });
    assert.equal(lease.user, added);
    await f.pool.release(lease);
  } finally { f.cleanup(); }
});

test('AGYCOOLDOWN-01: both quotas hold the mode, then the first reset restores only that identity', async () => {
  const f = fixture();
  try {
    await f.pool.refreshReadiness();
    const firstReset = new Date(f.options().nowMs + 50 * 3600000).toISOString();
    const secondReset = new Date(f.options().nowMs + 60 * 3600000).toISOString();
    for (const [identityUser, resetAt] of [[owner, firstReset], [added, secondReset]]) {
      startGeminiQuotaCooldown({ ...f.options(), identityUser, signal: { resetAt } });
    }
    assert.deepEqual(readReviewerGeminiQuotaCooldown({ ...f.options(), pool: f.pool, adapter }), {
      identities: [{ user: owner, resetAt: firstReset }, { user: added, resetAt: secondReset }],
    });
    assert.equal(await f.pool.refreshReadiness(), 0);
    assert.equal(await f.pool.acquire({ reviewId: 'all-cooled' }), null);
    f.setClock(Date.parse(firstReset));
    assert.equal(readReviewerGeminiQuotaCooldown({ ...f.options(), pool: f.pool, adapter }), null);
    assert.equal(await f.pool.refreshReadiness(), 1);
    assert.deepEqual(f.pool.readyUsers(), [owner]);
    const lease = await f.pool.acquire({ reviewId: 'quota-reset' });
    assert.equal(lease.user, owner);
    assert.equal(await f.pool.acquire({ reviewId: 'second-still-cooled' }), null);
    await f.pool.release(lease);
  } finally { f.cleanup(); }
});

test('AGYCOOLDOWN-01: a ready added cli-direct identity dispatches with zero broker credentials', async () => {
  const { createCliDirectReviewerRuntimeAdapter } = await import('../src/adapters/reviewer-runtime/cli-direct/index.mjs');
  const { resolveReviewerRuntimeAdapterForDomainId, reviewerRuntimeState } = await import('../src/reviewer-runtime-adapter.mjs');
  const { resolveGeminiCredentialConcurrencyForDispatchCandidates } = await import('../src/reviewer-runtime-support.mjs');
  const { fetchGeminiCredentialConcurrency, runBoundedReviewerDispatchQueue } = await import('../src/watcher-reviewer-pool.mjs');
  const f = fixture([added]);
  const previous = reviewerRuntimeState.adapter;
  const lines = [];
  const logger = { log: line => lines.push(line), warn() {}, error() {} };
  try {
    const brokerCount = await fetchGeminiCredentialConcurrency({
      brokerUrl: 'http://broker.invalid', fetchImpl: async () => ({ ok: true,
        json: async () => ({ credentials: [{ credential_id: 'synthetic-credential', is_cooled: true }] }),
      }),
    });
    assert.equal(brokerCount, 0);
    // A primary adapter cannot carry identities. A domain-specific cli-direct
    // adapter can; capacity must resolve the adapter used by the candidate.
    const inert = { describe: () => ({ id: 'fixture-stub', capabilities: {} }) };
    reviewerRuntimeState.adapter = inert;
    const domainAdapter = resolveReviewerRuntimeAdapterForDomainId('synthetic-code', {
      rootDir: f.rootDir, domainMtimeImpl: () => 1,
      loadDomainConfigImpl: () => ({ id: 'synthetic-code', reviewerRuntime: 'cli-direct' }),
      createAdapterImpl: options => createCliDirectReviewerRuntimeAdapter({ ...options, logger }),
    });
    assert.equal(domainAdapter.describe().capabilities.agyReviewerIdentity, true);
    const seen = [];
    const addedCandidate = {
      repoPath: 'example/synthetic', prNumber: 1, reviewerModel: 'gemini', subject: { domainId: 'synthetic-code' },
      run: () => runWithAgyReviewerIdentity({ reviewerModel: 'gemini', adapter: domainAdapter, pool: f.pool }, async identity => {
        seen.push(identity.user);
        return { ok: true };
      }),
    };
    const brokerCandidate = {
      repoPath: 'example/synthetic', prNumber: 2, reviewerModel: 'gemini', reviewerRuntimeAdapter: inert,
      run: async () => { throw new Error('no usable broker credential'); },
    };
    const resolveCap = candidates => resolveGeminiCredentialConcurrencyForDispatchCandidates(candidates, {
      env: {}, identityPool: f.pool, logger,
      resolveDomainAdapter: domain => domain === 'synthetic-code' ? domainAdapter : null,
      readSharedSecret: async () => '', fetchCredentialConcurrency: async () => brokerCount,
    });
    // The added identity starts draining; the actual readiness pass clears it.
    assert.equal(f.pool.readyCount(), 0);
    assert.equal(await resolveCap([addedCandidate]), 1);
    assert.deepEqual(f.pool.readyUsers(), [added]);
    assert.equal(lines.filter(line => line.startsWith('[agy-identities]')).length, 1);
    assert.match(lines[0], /ready=reviewer-b limit=1/);
    const limit = await resolveCap([brokerCandidate, addedCandidate]);
    assert.equal(limit, 1, 'a mixed batch cannot reduce the ready identity limit to broker zero');
    assert.equal(brokerCandidate.geminiCredentialConcurrency, 0);
    const summary = await runBoundedReviewerDispatchQueue([brokerCandidate, addedCandidate], {
      maxConcurrent: 2, geminiCredentialConcurrency: limit, logger,
    });
    assert.equal(summary.dispatched, 1);
    assert.deepEqual(seen, [added]);
    assert.equal(summary.deferred, 1);
    assert.equal(summary.deferredReasons[0].reason, 'gemini-credential-concurrency-zero');
  } finally { reviewerRuntimeState.adapter = previous; f.cleanup(); }
});

test('AGYCOOLDOWN-01: a legacy global record written before the upgrade holds only the HQ owner', async () => {
  const f = fixture();
  try {
    // The pre-upgrade watcher wrote one provider-wide record.
    const { writeFileSync } = await import('node:fs');
    const resetAt = new Date(f.options().nowMs + 50 * 3600000).toISOString();
    writeFileSync(join(f.rootDir, 'gemini-quota-cooldown.json'), JSON.stringify({ resetAt }));
    await f.pool.refreshReadiness();
    // Gemini stays on: only the HQ owner is cooled.
    assert.equal(readReviewerGeminiQuotaCooldown({ ...f.options(), pool: f.pool, adapter }), null);
    assert.deepEqual(f.pool.readyUsers(), [added]);
    const lease = await f.pool.acquire({ reviewId: 'after-upgrade' });
    assert.equal(lease.user, added);
    await f.pool.release(lease);
    // A single-identity runtime still sees the legacy hold on the HQ owner.
    assert.deepEqual(readReviewerGeminiQuotaCooldown({ ...f.options(), pool: f.pool, adapter: null }), { resetAt });
  } finally { f.cleanup(); }
});

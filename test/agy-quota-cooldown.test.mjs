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
      ? 'keychain.exists=yes\nkeychain.item=readable\nsettings.valid=yes\n' : '' }),
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

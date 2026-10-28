import './helpers/dispatch-files-preload.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { reconcileReviewerSessions } from '../src/reviewer-reattach.mjs';
import { prepareClaudeOAuthEnv } from '../src/reviewer-harness.mjs';
import { materializePerWorkerCodexAuth } from '../src/codex-per-worker-auth.mjs';
import { readAfhReviewerGrounding, applyAfhReviewerFallback } from '../src/afh-reviewer-fallback.mjs';
import { REVIEWER_ROUTE_BY_MODEL } from '../src/adapters/subject/github-pr/routing.mjs';
import { spawnReviewer, settleReviewerAttempt } from '../src/reviewer-spawn-settle.mjs';
import { writeReviewerRunRecord, readReviewerRunRecord } from '../src/adapters/reviewer-runtime/run-state.mjs';

// Replay the same acceptance tests against the actual parent, including the
// spawn integration (where the parent silently ignores the new receipt).
const url = new URL('../src/reviewer-token-pool.mjs', import.meta.url);
const pool = await import(url.href).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === url.href) return {};
  throw error;
});
const vectors = JSON.parse(readFileSync(new URL('./fixtures/identity-token-selection.v1.json', import.meta.url)));
const outcomes = JSON.parse(readFileSync(new URL('./fixtures/identity-token-outcomes.v1.json', import.meta.url)));
function merge(base, patch) {
  const value = structuredClone(base);
  for (const [key, item] of Object.entries(patch)) value[key] = item && typeof item === 'object'
    && !Array.isArray(item) && value[key] && typeof value[key] === 'object' && !Array.isArray(value[key])
    ? merge(value[key], item) : structuredClone(item);
  return value;
}
function wireFor(family, suffix = 'declared-preference', requestId = 'session') {
  const name = `${family}-reviewer-${suffix}`;
  const vector = vectors.cases.find(v => v.name === name);
  assert.ok(vector, name);
  const value = merge(vectors.defaults, vector.patch || {});
  const selection = structuredClone(outcomes.cases.find(v => v.name === name).result);
  const account = value.oauth.token_accounts[selection.account_id];
  return { ...value, selection, lease: account ? { version: 1, kind: 'managed', lease_id: 'lease-1',
    identity: selection.identity, account_id: selection.account_id, request_id: requestId,
    generation: 1, expires_at: 400, broker_provider: account.broker_provider, holder_user: null } : null };
}
async function selectWire(wire, extra = {}) {
  assert.equal(typeof pool.selectReviewerTokenAccount, 'function');
  const rootDir = extra.rootDir || mkdtempSync(join(tmpdir(), 'reviewer-select-'));
  try {
    return await pool.selectReviewerTokenAccount({ reviewerModel: wire.request.family, requestId: 'session', acquire: true,
      rootDir, oauth: wire.oauth, model: wire.request.requested_models[0], env: {},
      ownerImpl: async value => value.operation === 'release' ? { ok: true, operation: 'release' } : wire, ...extra });
  } finally { if (!extra.rootDir) rmSync(rootDir, { recursive: true, force: true }); }
}

for (const family of ['claude', 'codex']) {
  for (const suffix of ['declared-preference', 'quota-exhausted', 'not-ready', 'reserve-refused', 'model-denied', 'capacity-saturated']) {
    test(`ITP-12 ${family} ${suffix} consumes canonical reviewer receipt`, async () => {
      const wire = wireFor(family, suffix);
      const receipt = await selectWire(wire);
      assert.equal(receipt.hold, false);
      assert.equal(receipt.identity, `${family}-reviewer`);
      assert.equal(receipt.tokenAccountId, wire.selection.account_id);
      assert.equal(receipt.brokerProvider, wire.lease.broker_provider);
      assert.equal(receipt.reason, suffix === 'declared-preference' ? 'preferred-ready' : 'fallback-ready');
      assert.equal(receipt.workerClass, undefined);
    });
  }
  for (const suffix of ['preferred-unknown', 'preferred-stale', 'preferred-wrong-generation']) {
    test(`ITP-12 ${family} ${suffix} holds without spending primary`, async () => {
      const receipt = await selectWire(wireFor(family, suffix));
      assert.equal(receipt.hold, true);
      assert.equal(receipt.lease, undefined);
      assert.equal(receipt.brokerProvider, undefined);
    });
  }
  test(`ITP-12 ${family} refresh retains primary while recovery wins the next attempt`, async () => {
    const first = await selectWire(wireFor(family, 'quota-exhausted'));
    const second = await selectWire(wireFor(family));
    assert.notEqual(first.tokenAccountId, second.tokenAccountId);
    const calls = [];
    await pool.updateReviewerTokenLease(first, 'renew', { ownerImpl: async value => { calls.push(value); return { ok: true, operation: value.operation }; } });
    assert.equal(calls[0].lease.account_id, first.tokenAccountId);
    const context = { reviewerModel: family, reviewerAccountReceipt: first,
      codexBrokerProvider: 'codex-corp', claudeBrokerProvider: 'claude-code-corp' };
    assert.equal(pool.reviewerBrokerProviders(context)[`${family}BrokerProvider`], first.brokerProvider);
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.lease));
  });
  test(`ITP-12 ${family} typed quota cooldown affects only its selected account`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'reviewer-pool-quota-'));
    try {
      const receipt = await selectWire(wireFor(family));
      const nowMs = Date.now();
      pool.recordReviewerAccountQuotaFailure(root, receipt, { env: {}, nowMs });
      assert.ok(pool.readReviewerAccountCooldown(root, receipt.tokenAccountId, { env: {}, nowMs }));
      const wire = wireFor(family, 'quota-exhausted');
      assert.equal(pool.readReviewerAccountCooldown(root, wire.selection.account_id, { env: {}, nowMs }), null);
      let blocked;
      await selectWire(wire, { rootDir: root, ownerImpl: async value => { blocked = value.blockedAccountIds; return wire; } });
      assert.deepEqual(blocked, [receipt.tokenAccountId]);
      assert.equal(pool.readReviewerAccountCooldown(root, receipt.tokenAccountId, { env: {}, nowMs: nowMs + 900_001 }), null);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test(`ITP-12 ${family} resolves the canonical reviewer registry model without a caller model`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'reviewer-pool-model-'));
    try {
      const wire = wireFor(family);
      const expectedModel = wire.request.requested_models[0];
      mkdirSync(join(root, 'registry'));
      writeFileSync(join(root, 'registry', 'worker-classes.json'), JSON.stringify({ classes: {
        [`${family}-reviewer`]: { defaultModel: expectedModel },
      } }));
      for (const acquire of [false, true]) {
        let requested;
        const receipt = await pool.selectReviewerTokenAccount({ reviewerModel: family,
          oauth: wire.oauth, requestId: 'session', acquire, rootDir: root,
          env: { HQ_ROOT: root, AGENT_OS_DEPLOY_CHECKOUT: root },
          ownerImpl: async value => { requested = value; return wire; } });
        assert.equal(requested.model, expectedModel);
        assert.equal(requested.operation, acquire ? 'acquire' : 'propose');
        assert.equal(receipt.hold, false);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('ITP-12 malformed owner leases and request substitution hold without leaking diagnostics', async () => {
  for (const mutate of [
    w => { w.lease.account_id = 'other'; }, w => { w.lease.broker_provider = 'other'; },
    w => { w.lease.request_id = 'other'; }, w => { w.lease.generation = 0; },
    w => { w.lease.expires_at = 0; }, w => { w.lease.access_token = 'synthetic-secret'; },
    w => { w.request.identity = 'codex'; }, w => { w.selection.version = 2; },
  ]) {
    const wire = wireFor('codex');
    mutate(wire);
    const operations = [];
    const result = await selectWire(wire, { ownerImpl: async value => {
      operations.push(value.operation);
      return value.operation === 'release' ? { ok: true, operation: 'release' } : wire;
    } });
    assert.deepEqual(operations, ['acquire', 'release']);
    assert.equal(result.hold, true);
    assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
  }
});

for (const family of ['claude', 'codex']) test(`ITP-12 ${family} pool evidence controls AFH even when legacy quota is unavailable`, async () => {
  for (const suffix of ['declared-preference', 'preferred-unknown']) {
    const receipt = await selectWire(wireFor(family, suffix));
    const grounding = await readAfhReviewerGrounding({ env: {}, retryDelaysMs: [],
      execFileImpl: async () => ({ stdout: '{"providerStatuses":[]}' }),
      selectReviewerTokenAccountImpl: async request => request.reviewerModel === family ? receipt : null });
    assert.equal(grounding.available, !receipt.hold);
    const route = applyAfhReviewerFallback({ baseRoute: REVIEWER_ROUTE_BY_MODEL[family],
      builderClass: family === 'codex' ? 'claude-code' : 'codex', grounding, geminiReviewerMode: 'off' });
    assert.equal(route.reviewerModel, family);
    if (suffix === 'preferred-unknown') assert.equal(route.quotaBlocked, true);
    else assert.equal(family === 'codex' ? route.codexBrokerProvider : route.claudeAccountSelection.provider, receipt.brokerProvider);
  }
});

test('ITP-12 undeclared reviewer pools preserve legacy routing without contacting Python', async () => {
  assert.equal(typeof pool.selectReviewerTokenAccount, 'function');
  for (const family of ['claude', 'codex']) assert.equal(await pool.selectReviewerTokenAccount({
    reviewerModel: family, oauth: { token_accounts: {}, identity_token_pools: {} },
    ownerImpl: () => assert.fail('undeclared pools must stay offline') }), null);
});

for (const describe of [() => ({ id: 'fixture-stub' }), () => ({ id: 'agent-os-hq' }), () => ({}), undefined]) test('ITP-12 unsupported or unidentified runtime holds without dispatching a falsely attributed account', async () => {
  const receipt = await selectWire(wireFor('codex'));
  const operations = [];
  const result = await spawnReviewer({ reviewerModel: 'codex', builderTag: 'claude-code',
    selectReviewerTokenAccountImpl: async () => receipt,
    updateReviewerTokenLeaseImpl: async (_, operation) => operations.push(operation),
    reviewerRuntimeAdapterOverride: { describe,
      spawnReviewer: () => assert.fail('runtime cannot propagate binding') } });
  assert.equal(result.failureClass, 'reviewer-account-held');
  assert.equal(result.error, 'reviewer-runtime-account-binding-unsupported');
  assert.deepEqual(operations, ['release']);
});

test('ITP-12 a declaration change during lease acquisition releases the unstarted slot and holds', async () => {
  assert.equal(typeof pool.selectReviewerTokenAccount, 'function');
  const wire = wireFor('codex');
  const changed = structuredClone(wire.oauth);
  changed.identity_token_pools['codex-reviewer'].reverse();
  let reads = 0;
  const operations = [];
  const result = await pool.selectReviewerTokenAccount({ reviewerModel: 'codex', requestId: 'session',
    model: 'gpt-6', acquire: true, env: {}, resolvePoolsImpl: () => reads++ ? changed : wire.oauth,
    ownerImpl: async value => { operations.push(value.operation); return value.operation === 'release' ? { ok: true, operation: 'release' } : wire; } });
  assert.equal(result.hold, true);
  assert.equal(result.reason, 'evidence-generation-mismatch');
  assert.deepEqual(operations, ['acquire', 'release']);
});

test('ITP-12 Claude proxy remint keeps its bound primary provider after corporate recovery', async () => {
  const first = await selectWire(wireFor('claude', 'quota-exhausted'));
  const recovered = await selectWire(wireFor('claude'));
  const providers = pool.reviewerBrokerProviders({ reviewerModel: 'claude', reviewerAccountReceipt: first });
  const env = { CLAUDE_BROKER_PROVIDER: providers.claudeBrokerProvider,
    ADVERSARIAL_REVIEW_CLAUDE_CODE_OAUTH_TRANSPORT: 'broker' };
  const calls = [];
  const auth = await prepareClaudeOAuthEnv({ model: 'opus', sourceEnv: env,
    logger: {}, proxied: true,
    mintClaudeCodeBrokerTokenImpl: async value => {
      calls.push(value.provider);
      return { token: 'synthetic-access', expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
    } });
  env.CLAUDE_BROKER_PROVIDER = recovered.brokerProvider;
  await auth.remint();
  await auth.remint();
  assert.deepEqual(calls, ['claude-code', 'claude-code', 'claude-code']);
});

test('ITP-12 Codex broker sync retries keep the bound corporate provider', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-pool-refresh-'));
  try {
    const receipt = await selectWire(wireFor('codex'));
    const providers = pool.reviewerBrokerProviders({ reviewerModel: 'codex', reviewerAccountReceipt: receipt });
    const syncBin = join(root, 'synthetic-sync');
    writeFileSync(syncBin, 'fixture');
    const env = { CODEX_BROKER_PROVIDER: providers.codexBrokerProvider, AGENT_OS_CODEX_WORKER_AUTH_SYNC_BIN: syncBin };
    const calls = [];
    const auth = materializePerWorkerCodexAuth({ sharedAuthPath: join(root, '.codex', 'auth.json'),
      key: 'session', env, sleepImpl() {}, execFileSyncImpl: (_, __, options) => {
        calls.push(options.env.CODEX_BROKER_PROVIDER);
        if (calls.length === 1) { env.CODEX_BROKER_PROVIDER = 'codex'; throw new Error('HTTP 503'); }
        writeFileSync(options.env.CODEX_WORKER_AUTH_PATH, JSON.stringify({ auth_mode: 'chatgpt',
          tokens: { access_token: 'synthetic-corporate-access' } }));
      } });
    assert.deepEqual(calls, ['codex-corp', 'codex-corp']);
    auth.cleanup();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const family of ['claude', 'codex']) test(`ITP-12 ${family} receipt survives spawn, settle and run-record recovery`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-pool-spawn-'));
  try {
    const receipt = await selectWire(wireFor(family, 'quota-exhausted'));
    const metadata = [];
    const operations = [];
    let requestContext;
    let settled;
    const result = await spawnReviewer({ rootDir: root, repo: 'sample/project', prNumber: 7,
      reviewerModel: family, reviewerSessionUuid: 'session', builderTag: family === 'codex' ? 'claude-code' : 'codex',
      selectReviewerTokenAccountImpl: async () => receipt,
      updateReviewerTokenLeaseImpl: async (value, operation) => operations.push([value, operation]),
      quotaCheckEnv: {}, readReviewerQuotaDecisionImpl: async () => ({ available: true }),
      beginReviewerPassImpl: (_, value) => metadata.push(value.metadata),
      completeReviewerPassImpl: (_, value) => metadata.push(value.metadata),
      readBestReviewerEvidenceTokenUsageImpl: async () => null, ledgerLookupSleepImpl: async () => {},
      onPostOperationSettled: value => { settled = value; },
      accountBindingRuntimeIds: ['fixture-stub'],
      reviewerRuntimeAdapterOverride: { describe: () => ({ id: 'fixture-stub' }), async spawnReviewer(req) {
        requestContext = req.subjectContext;
        writeReviewerRunRecord(root, { sessionUuid: 'session', state: 'completed', subjectContext: req.subjectContext });
        return { ok: false, failureClass: 'unknown', error: 'fixture failed after drain' };
      } },
    });
    assert.deepEqual(requestContext.reviewerAccountReceipt, receipt);
    assert.equal(requestContext[`${family}BrokerProvider`], receipt.brokerProvider);
    assert.deepEqual(result.reviewerAccountReceipt, receipt);
    assert.deepEqual(settled.reviewerAccountReceipt, receipt);
    assert.deepEqual(metadata.map(value => value.reviewerAccountReceipt), [receipt, receipt]);
    assert.deepEqual(readReviewerRunRecord(root, 'session').subjectContext.reviewerAccountReceipt, receipt);
    assert.deepEqual(operations, [[receipt, 'release']]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const recordKind of ['missing', 'unreadable']) test(`ITP-12 ${recordKind} run record after resolved spawn handles lease capacity safely`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-pool-record-'));
  try {
    const receipt = await selectWire(wireFor('codex'));
    const operations = [];
    if (recordKind === 'unreadable') {
      writeReviewerRunRecord(root, { sessionUuid: 'session', state: 'spawned' });
      writeFileSync(join(root, 'data', 'reviewer-runs', 'session.json'), '{');
    } else {
      assert.equal(readReviewerRunRecord(root, 'session'), null);
    }
    const result = await spawnReviewer({ rootDir: root, repo: 'sample/project', prNumber: 7,
      reviewerModel: 'codex', builderTag: 'claude-code', reviewerSessionUuid: 'session',
      selectReviewerTokenAccountImpl: async () => receipt,
      updateReviewerTokenLeaseImpl: async (_, operation) => operations.push(operation),
      quotaCheckEnv: {}, readReviewerQuotaDecisionImpl: async () => ({ available: true }),
      beginReviewerPassImpl() {}, completeReviewerPassImpl() {},
      readBestReviewerEvidenceTokenUsageImpl: async () => null, ledgerLookupSleepImpl: async () => {},
      accountBindingRuntimeIds: ['fixture-stub'],
      reviewerRuntimeAdapterOverride: { describe: () => ({ id: 'fixture-stub' }),
        spawnReviewer: async () => ({ ok: false, failureClass: 'unknown', error: 'failed before launch' }) },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(operations, recordKind === 'missing' ? ['release'] : []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ITP-12 account hold releases the claim without charging any retry budget', async () => {
  let spawned = 0;
  const result = await spawnReviewer({ reviewerModel: 'codex', builderTag: 'claude-code', reviewerSessionUuid: 'session',
    selectReviewerTokenAccountImpl: async () => ({ hold: true, reason: 'evidence-unknown' }),
    reviewerRuntimeAdapterOverride: { spawnReviewer() { spawned += 1; } } });
  const releases = [];
  settleReviewerAttempt({ repoPath: 'sample/project', prNumber: 7, result,
    statements: { releaseReviewerClaim: { run: (...args) => releases.push(args) } } });
  assert.equal(spawned, 0);
  assert.deepEqual(releases, [['session', 'sample/project', 7]]);
  releases.length = 0;
  settleReviewerAttempt({ repoPath: 'sample/project', prNumber: 7, result,
    reviewerSessionUuid: 'previous-fallback-session',
    statements: { releaseReviewerClaim: { run: (...args) => releases.push(args) } } });
  assert.deepEqual(releases, [['session', 'sample/project', 7]]);
});

test('ITP-12 same-family refusal precedes any account checkout', async () => {
  for (const family of ['claude', 'codex']) {
    let selections = 0;
    const result = await spawnReviewer({ reviewerModel: family, builderTag: family === 'claude' ? 'claude-code' : 'codex',
      selectReviewerTokenAccountImpl: async () => { selections += 1; throw new Error('must not select'); } });
    assert.equal(result.routingRefusal, true);
    assert.equal(selections, 0);
  }
});

test('ITP-12 reattach renews the original receipt and releases only after confirmed drain', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-pool-reattach-'));
  const db = new Database(':memory:');
  try {
    const receipt = await selectWire(wireFor('codex', 'quota-exhausted'));
    ensureReviewStateSchema(db);
    db.prepare(`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state,
      review_status, reviewer_session_uuid, reviewer_pgid, reviewer_started_at,
      reviewer_head_sha, reviewer_timeout_ms) VALUES (?, 7, ?, 'codex', 'open', 'reviewing',
      'session', 9001, ?, 'head-1', 3600000)`).run('sample/project', '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z');
    writeReviewerRunRecord(root, { sessionUuid: 'session', state: 'spawned', pgid: 9001,
      subjectContext: { reviewerAccountReceipt: receipt, reviewerModel: 'codex' } });
    let alive = true;
    const calls = [];
    const options = { db, rootDir: root, now: new Date('2026-10-20T00:10:00Z'),
      log: { log() {}, warn() {} }, probeAlive: () => alive,
      probeSession: () => ({ alive, matched: true }), fetchHeadSha: async () => 'head-1',
      findPostedReview: async () => null,
      onTerminalDeadSession: async () => calls.push('drained'),
      findReviewerProcess: () => ({ found: false }),
      updateReviewerTokenLeaseImpl: async (value, operation) => calls.push([value.lease.account_id, operation]),
    };
    await reconcileReviewerSessions(options);
    assert.deepEqual(calls, [[receipt.tokenAccountId, 'renew']]);
    alive = false;
    await reconcileReviewerSessions(options);
    assert.deepEqual(calls, [[receipt.tokenAccountId, 'renew'], [receipt.tokenAccountId, 'release'], 'drained']);
    assert.deepEqual(readReviewerRunRecord(root, 'session').subjectContext.reviewerAccountReceipt, receipt);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

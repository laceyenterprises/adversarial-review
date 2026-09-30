import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCloserDispatchHarness } from '../src/ama/harness-fallback.mjs';
import { resolveRemediationWorkerClassWithFallback } from '../src/remediation-worker-class-fallback.mjs';
import { harnessCapFromStatuses, parseHqFleetQuotaStatus } from '../src/fleet-quota-status.mjs';
import { afhGroundingSnapshotFromStdout, applyAfhReviewerFallback, reviewerModelGrounding } from '../src/afh-reviewer-fallback.mjs';
import { routeSubject, isCrossModelReviewWaived, normalizeReviewerModel } from '../src/adapters/subject/github-pr/routing.mjs';
import { TAG_PREFIXES } from '../src/adapters/subject/github-pr/title-tagging.mjs';
import { loadConfig } from '../src/config-loader.mjs';
import { materializePerWorkerCodexAuth, prepareCorporateCodexReviewerAuth, PER_WORKER_PLACEHOLDER_REFRESH_TOKEN } from '../src/codex-per-worker-auth.mjs';
import { remediationWorkerGitIdentity, remediationWorkerPushProvider, remediationWorkerTrailerClass } from '../src/remediation-worker-provenance.mjs';

function rows(primary = 'exhausted', corp = 'ok', extra = {}) {
  return [
    { provider: 'openai', authPath: 'oauth-corp', state: corp }, // corp first must never become primary
    { provider: 'openai', authPath: 'oauth', state: primary, ...extra },
    { provider: 'anthropic', authPath: 'oauth', state: 'ok' },
    { provider: 'google', authPath: 'oauth', state: 'ok' },
  ];
}
const stdout = (statuses) => JSON.stringify({ providerStatuses: statuses });
const probe = (statuses) => async () => ({ stdout: stdout(statuses) });
const route = (builderClass) => routeSubject({ builderClass }, { env: {}, topPath: '/dev/null', geminiReviewerMode: 'off' });
function reviewer(statuses, builderClass = 'claude-code', codexModel = null) {
  return applyAfhReviewerFallback({ builderClass, baseRoute: route(builderClass),
    grounding: afhGroundingSnapshotFromStdout(stdout(statuses), { codexModel }), geminiReviewerMode: 'off' });
}

for (const [label, primary, extra] of [
  ['hard cap', 'exhausted', {}],
  ['soft ground', 'unknown', { afhGrounding: { grounded: true } }],
  ['model cap', 'unknown', { lastErrorSignature: 'model_only_exhaustion' }],
]) {
  test(`CCX-04 ${label}: each lane selects its corporate account before Claude`, async () => {
    const statuses = rows(primary, 'ok', extra);
    const hammer = await resolveCloserDispatchHarness({ workerClass: 'hammer',
      fallbackWorkerClasses: ['hammer-corp', 'hammer-claude'], execFileImpl: probe(statuses), env: {} });
    assert.equal(hammer.workerClass, 'hammer-corp');
    const remediator = await resolveRemediationWorkerClassWithFallback({ primary: 'codex',
      fallbackWorkerClasses: ['remediator-codex-corp', 'remediator-claude'], reviewerModels: ['codex'], execFileImpl: probe(statuses), env: {} });
    assert.equal(remediator.workerClass, 'remediator-codex-corp');
    const review = reviewer(statuses);
    assert.equal(review.reviewerModel, 'codex');
    assert.equal(review.codexBrokerProvider, 'codex-corp');
    assert.equal(review.quotaBlocked, undefined);
  });
}

test('CCX-04 both accounts capped: declared Claude fallbacks, no capped spawn', async () => {
  const statuses = rows('exhausted', 'exhausted');
  assert.equal((await resolveCloserDispatchHarness({ workerClass: 'hammer',
    fallbackWorkerClasses: ['hammer-corp', 'hammer-claude'], execFileImpl: probe(statuses) })).workerClass, 'hammer-claude');
  assert.equal((await resolveRemediationWorkerClassWithFallback({ primary: 'codex',
    fallbackWorkerClasses: ['remediator-codex-corp', 'remediator-claude'], execFileImpl: probe(statuses) })).workerClass, 'remediator-claude');
  assert.equal(reviewer(statuses).reviewerModel, 'claude');
  statuses[2].state = 'exhausted';
  assert.equal(reviewer(statuses).quotaBlocked, true);
  assert.equal((await resolveCloserDispatchHarness({ workerClass: 'hammer',
    fallbackWorkerClasses: ['hammer-corp', 'hammer-claude'], execFileImpl: probe(statuses) })).hold, true);
  assert.equal((await resolveRemediationWorkerClassWithFallback({ primary: 'codex',
    fallbackWorkerClasses: ['remediator-codex-corp', 'remediator-claude'], execFileImpl: probe(statuses) })).hold, true);
});

for (const corp of ['unknown', 'degraded', 'grounded']) {
  test(`CCX-04 corporate ${corp} is not admitting`, () => {
    assert.equal(reviewer(rows('exhausted', corp)).reviewerModel, 'claude');
  });
}

test('CCX-04 missing corporate row never borrows primary evidence; recovery auto-reverts', () => {
  const statuses = rows('ok', 'exhausted');
  const parsed = parseHqFleetQuotaStatus(stdout(statuses));
  assert.equal(harnessCapFromStatuses(parsed, { harness: 'codex' }).available, true);
  assert.equal(harnessCapFromStatuses(parsed, { harness: 'codex-corp' }).capped, true);
  assert.equal(harnessCapFromStatuses(parsed.slice(1), { harness: 'codex-corp' }).available, false);
  assert.equal(reviewer(statuses).codexBrokerProvider, undefined);
  assert.equal(reviewerModelGrounding(afhGroundingSnapshotFromStdout(stdout(statuses)), 'codex').brokerProvider, 'codex');
});

test('CCX-04 reviewer screens the routed model on each account', () => {
  const statuses = rows('ok', 'ok', { models: [{ model: 'test-model', state: 'exhausted' }] });
  assert.equal(reviewer(statuses, 'claude-code', 'test-model').codexBrokerProvider, 'codex-corp');
  statuses[0].models = [{ model: 'test-model', state: 'exhausted' }];
  assert.equal(reviewer(statuses, 'claude-code', 'test-model').reviewerModel, 'claude');
});

test('CCX-04 codex-corp belongs to codex for routing and never-review-own-builder', () => {
  assert.equal(route('codex-corp').reviewerModel, 'claude');
  assert.equal(normalizeReviewerModel('codex-corp'), 'codex');
  for (const builder of ['codex', 'codex-corp']) {
    for (const model of ['codex', 'codex-corp']) assert.equal(isCrossModelReviewWaived(builder, model), true);
    const statuses = rows('ok', 'ok');
    statuses[2].state = 'exhausted';
    assert.equal(reviewer(statuses, builder).reviewerModel, 'claude');
    assert.equal(reviewer(statuses, builder).quotaBlocked, true);
  }
  assert.equal(isCrossModelReviewWaived('claude-code', 'codex-corp'), false);
  assert.equal(Object.values(TAG_PREFIXES).includes('[codex-corp]'), false);
});

test('CCX-04 strict Node config accepts twins and keeps the hammer default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccx-config-'));
  try {
    const topPath = join(dir, 'config.yaml');
    writeFileSync(topPath, 'version: 1\n');
    assert.deepEqual(loadConfig({ topPath, env: {} }).getMergeAuthorityConfig().workerClassFallback, ['hammer-claude']);
    writeFileSync(topPath, 'version: 1\nroles:\n  remediator_fallback: [remediator-codex-corp, remediator-claude]\n  adversarial:\n    merge_authority:\n      worker_class_fallback: [hammer-corp, hammer-claude]\n');
    const cfg = loadConfig({ topPath, env: {} });
    assert.deepEqual(cfg.getMergeAuthorityConfig().workerClassFallback, ['hammer-corp', 'hammer-claude']);
    assert.deepEqual(cfg.get('roles.remediator_fallback'), ['remediator-codex-corp', 'remediator-claude']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const provider of ['codex', 'codex-corp']) {
  test(`CCX-04 every auth-sync token request passes provider=${provider}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccx-auth-'));
    try {
      mkdirSync(join(dir, '.codex'));
      const sharedAuthPath = join(dir, '.codex', 'auth.json');
      writeFileSync(sharedAuthPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'primary', refresh_token: 'primary-refresh' } }));
      const syncBin = join(dir, 'fake-sync');
      writeFileSync(syncBin, 'fixture');
      const calls = [];
      const env = { AGENT_OS_CODEX_WORKER_AUTH_SYNC_BIN: syncBin, CODEX_BROKER_PROVIDER: provider };
      const result = materializePerWorkerCodexAuth({ sharedAuthPath, key: 'reviewer-fixture', env,
        execFileSyncImpl: (_bin, args, options) => {
          calls.push({ args, provider: options.env.CODEX_BROKER_PROVIDER });
          const authPath = options.env.CODEX_WORKER_AUTH_PATH;
          const auth = JSON.parse(readFileSync(authPath, 'utf8'));
          if (provider === 'codex-corp') assert.equal(auth.tokens.access_token, undefined);
          auth.tokens = { access_token: `${provider}-token`, refresh_token: 'broker-placeholder', account_id: provider };
          writeFileSync(authPath, JSON.stringify(auth));
        } });
      assert.deepEqual(calls, [{ args: [syncBin], provider }]);
      const auth = JSON.parse(readFileSync(result.authPath, 'utf8'));
      assert.equal(auth.tokens.access_token, `${provider}-token`);
      assert.equal(auth.tokens.refresh_token, PER_WORKER_PLACEHOLDER_REFRESH_TOKEN);
      assert.equal(JSON.parse(readFileSync(sharedAuthPath, 'utf8')).tokens.access_token, 'primary');
      result.cleanup();
      if (provider === 'codex-corp') {
        assert.throws(() => materializePerWorkerCodexAuth({ sharedAuthPath, key: 'failure', env,
          execFileSyncImpl: () => { throw new Error('fixture broker unavailable'); } }), /corporate Codex broker credential unavailable/);
        assert.equal(existsSync(join(dir, '.codex', '.per-worker', 'failure')), false);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('CCX-04 remediator twins retain their harness commit and push identity', () => {
  for (const [twin, original] of [['remediator-codex-corp', 'codex'], ['remediator-claude', 'claude-code']]) {
    assert.deepEqual(remediationWorkerGitIdentity(twin, {}), remediationWorkerGitIdentity(original, {}));
    assert.equal(remediationWorkerPushProvider(twin, {}).provider, remediationWorkerPushProvider(original, {}).provider);
    assert.equal(remediationWorkerTrailerClass(twin), remediationWorkerTrailerClass(original));
  }
});


test('CCX-04 corporate preflight prepares independent auth without a primary credential', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccx-independent-auth-'));
  try {
    const syncBin = join(dir, 'fake-sync');
    writeFileSync(syncBin, 'fixture');
    const env = { HOME: dir, CODEX_BROKER_PROVIDER: 'codex-corp', AGENT_OS_CODEX_WORKER_AUTH_SYNC_BIN: syncBin };
    const materializeImpl = (args) => materializePerWorkerCodexAuth({ ...args,
      execFileSyncImpl: (_bin, _args, options) => {
        assert.equal(options.env.CODEX_BROKER_PROVIDER, 'codex-corp');
        writeFileSync(options.env.CODEX_WORKER_AUTH_PATH, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'corp-only' } }));
      } });
    const first = prepareCorporateCodexReviewerAuth(env, 'same-session', { materializeImpl });
    const secondEnv = { ...env };
    const second = prepareCorporateCodexReviewerAuth(secondEnv, 'same-session', { materializeImpl });
    assert.notEqual(first.authPath, second.authPath);
    assert.equal(env.CODEX_REVIEWER_AUTH_PROVIDER, 'codex-corp');
    assert.equal(JSON.parse(readFileSync(env.CODEX_AUTH_PATH, 'utf8')).tokens.access_token, 'corp-only');
    second.cleanup();
    assert.equal(existsSync(first.authPath), true, 'duplicate-session preparation cannot delete active auth');
    first.cleanup();
    assert.equal(existsSync(join(dir, '.codex', 'auth.json')), false);
    const primaryEnv = { CODEX_BROKER_PROVIDER: 'codex', CODEX_REVIEWER_AUTH_PROVIDER: 'codex-corp' };
    assert.equal(prepareCorporateCodexReviewerAuth(primaryEnv, 'primary'), null);
    assert.equal(primaryEnv.CODEX_REVIEWER_AUTH_PROVIDER, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

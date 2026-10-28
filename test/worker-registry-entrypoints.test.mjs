import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'acorn';
import { dispatchReadTransport } from '../src/dispatch-read-client.mjs';
import { ensureWorkerRegistryReady, RegistryUnavailableError } from '../src/adapters/agent-runtime/local/remediation.mjs';
import { resolveReviewerExecution, resolveReviewerExecutionAsync } from '../src/reviewer-harness.mjs';
import { readAfhReviewerGrounding } from '../src/afh-reviewer-fallback.mjs';
import { resolveReviewerWorkerClassWithFallback } from '../src/review-worker-class-fallback.mjs';
import { resolveRemediationWorkerClassWithFallback } from '../src/remediation-worker-class-fallback.mjs';
import { resolveCloserDispatchHarness } from '../src/ama/harness-fallback.mjs';
import { selectReviewerTokenAccount } from '../src/reviewer-token-pool.mjs';
import { readReviewerQuotaDecision } from '../src/reviewer-spawn-settle.mjs';
import { createDefaultArgusReviewDeps } from '../src/argus-security-review-deps.mjs';
import { createArgusSecurityDrain } from '../src/argus-security-drain.mjs';
import { enqueueArgusSecurityReview, findArgusJob } from '../src/argus-security-queue.mjs';

const quiet = { info() {}, log() {}, warn() {}, error() {} };
const quota = JSON.stringify({providerStatuses: [
  {provider: 'openai', authPath: 'oauth', state: 'ok'},
  {provider: 'anthropic', authPath: 'oauth', state: 'ok'},
]});

function registry(t, name) {
  const env = {APP_CONTRACT_ENDPOINT_URL: `https://example.invalid/${name}`};
  let reads = 0, down = false;
  t.mock.method(dispatchReadTransport, 'sdk', () => ({
    async connect(config) { return {sessionToken: 'fixture-session', endpoint_url: config.endpoint_url}; },
    async readSessionHostServices(request) {
      assert.equal(request.action, 'worker_registry');
      reads++;
      if (down) throw Error('fixture transport down');
      return {schema_version: 1, status: 'found', data: {classes: {
        ...Object.fromEntries(['claude', 'codex', 'gemini'].map(harness =>
          [`${harness}-reviewer`, {defaultModel: `governed-${harness}`}])),
        'remediator-claude': {defaultModel: 'governed-claude'},
        hammer: {defaultModel: 'governed-codex'},
      }}};
    },
    readHostServicesSync() { assert.fail('sync transport forbidden'); },
  }));
  return {env, reads: () => reads, outage() { down = true; }};
}

const readers = {
  remediation: (env, ensureWorkerRegistryReadyImpl) => resolveRemediationWorkerClassWithFallback({env, ensureWorkerRegistryReadyImpl, primary: 'remediator-claude',
    execFileImpl: async () => ({stdout: quota}), selectAccountImpl: async () => null}),
  closer: (env, ensureWorkerRegistryReadyImpl) => resolveCloserDispatchHarness({env, ensureWorkerRegistryReadyImpl, workerClass: 'hammer',
    execFileImpl: async () => ({stdout: quota}), selectAccountImpl: async () => null}),
  pool: (env, ensureWorkerRegistryReadyImpl) => selectReviewerTokenAccount({env, ensureWorkerRegistryReadyImpl, reviewerModel: 'codex',
    oauth: {identity_token_pools: {'codex-reviewer': []}}, ownerImpl: async request => {
      assert.equal(request.model, 'governed-codex');
      return {held: 'fixture-hold'};
    }}),
  reviewer: (env, ensureWorkerRegistryReadyImpl) => resolveReviewerExecutionAsync('claude', {env, ensureWorkerRegistryReadyImpl, log: quiet}),
  grounding: (env, ensureWorkerRegistryReadyImpl) => readAfhReviewerGrounding({env, ensureWorkerRegistryReadyImpl, execFileImpl: async () => ({stdout: quota}),
    selectReviewerTokenAccountImpl: async () => null, retryDelaysMs: []}),
  fallback: (env, ensureWorkerRegistryReadyImpl) => resolveReviewerWorkerClassWithFallback({env, ensureWorkerRegistryReadyImpl, authorClass: 'claude-code',
    primary: 'codex', fallbackWorkerClasses: ['claude-code'],
    fleetQuotaStatus: {stdout: quota}, logger: quiet}),
  quota: (env, ensureWorkerRegistryReadyImpl) => readReviewerQuotaDecision({env, ensureWorkerRegistryReadyImpl, reviewerModel: 'codex',
    execFileImpl: async () => ({stdout: quota})}),
};

for (const [name, read] of Object.entries(readers)) {
  test(`${name} accepts injected readiness with a ready registry`, async t => {
    const f = registry(t, `injected-ready-${name}`);
    await ensureWorkerRegistryReady({env: f.env});
    f.outage();
    let calls = 0;
    await read(f.env, async ({env}) => {
      assert.deepEqual(env, f.env);
      calls++;
    });
    assert.ok(calls > 0);
    assert.equal(f.reads(), 1, 'injected readiness never consults the physical transport');
  });

  test(`${name} preserves an injected readiness outage`, async t => {
    const f = registry(t, `injected-outage-${name}`);
    const error = new RegistryUnavailableError();
    await assert.rejects(read(f.env, async () => { throw error; }), caught => caught === error);
    assert.equal(f.reads(), 0);
  });
  test(`${name} owns its cold registry and refreshes it on expiry`, async t => {
    const f = registry(t, `cold-${name}`);
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    await read(f.env);
    assert.equal(resolveReviewerExecution('claude', {env: f.env, log: quiet}).model, 'governed-claude');
    assert.equal(f.reads(), 1);
    now += 60_000;
    await read({...f.env});
    assert.equal(f.reads(), 2);
    now += 60_000;
    f.outage();
    await read(f.env);
    assert.equal(resolveReviewerExecution('claude', {env: f.env, log: quiet}).modelSource, 'committed-seed');
  });

  test(`${name} resolves covered models during a cold transport outage`, async t => {
    const f = registry(t, `outage-${name}`);
    f.outage();
    await read(f.env);
    assert.equal(resolveReviewerExecution('claude', {env: f.env, log: quiet}).modelSource, 'committed-seed');
  });
}

for (const down of [false, true]) {
  test(`security drain owns registry readiness (transport down=${down})`, async t => {
    const f = registry(t, `drain-${down}`);
    if (down) f.outage();
    const rootDir = mkdtempSync(join(tmpdir(), 'registry-drain-'));
    t.after(() => rmSync(rootDir, {recursive: true, force: true}));
    const deps = createDefaultArgusReviewDeps({rootDir, env: f.env, logger: quiet,
      evidenceIo: {}, identityPool: {plan: () => ({hqOwner: true})}, agyLease: {legacy: true},
      reviewWithGeminiImpl: async () => {
        const execution = resolveReviewerExecution('gemini', {env: f.env, log: quiet});
        assert.equal(execution.modelSource, down ? 'committed-seed' : 'registry');
        return {reviewText: 'fixture review'};
      }});
    const headSha = 'a'.repeat(40);
    enqueueArgusSecurityReview({rootDir, repo: 'example/fixture', prNumber: 7, headSha,
      reasons: [{trigger: 'manifest-change', ecosystems: ['npm'], matches: []}]});
    let caught;
    const drain = createArgusSecurityDrain({rootDir, logger: quiet, runJob: async () => {
      try {
        await deps.runReviewerModel({model: 'gemini', prompt: 'fixture', cwd: rootDir, diff: ''});
      } catch (error) { caught = error; throw error; }
      return {kind: 'defer', reason: 'fixture-complete', retryAfterMs: 60_000};
    }});
    assert.equal(drain.tick().claimed.length, 1);
    await drain.drain();
    assert.equal(f.reads(), 1);
    const found = findArgusJob(rootDir, {repo: 'example/fixture', prNumber: 7, headSha});
    assert.equal(found.bucket, 'pending');
    assert.equal(caught, undefined);
  });
}

test('every production model-resolution importer has an async readiness owner', () => {
  const root = new URL('../', import.meta.url);
  const sources = [];
  function walk(dir) {
    for (const entry of readdirSync(new URL(dir, root), {withFileTypes: true})) {
      const name = `${dir}${entry.name}`;
      if (entry.isDirectory()) walk(`${name}/`);
      else if (name.endsWith('.mjs')) sources.push(name);
    }
  }
  for (const dir of ['src/', 'bin/', 'scripts/']) walk(dir);
  const importers = sources.filter(name => parse(readFileSync(new URL(name, root), 'utf8'),
    {ecmaVersion: 'latest', sourceType: 'module'}).body.some(node => node.type === 'ImportDeclaration'
      && node.specifiers.some(spec => /^resolve(?:RemediationModel|NonBlockingCodexModel|(?:Claude|Codex|Gemini)RemediationModel|ConfiguredNonBlockingCodexModel|ReviewerExecution(?:Async)?)$/.test(spec.imported?.name))));
  const owners = [
    'src/afh-reviewer-fallback.mjs', 'src/ama/harness-fallback.mjs',
    'src/follow-up-remediation.mjs', 'src/remediation-worker-class-fallback.mjs',
    'src/review-worker-class-fallback.mjs', 'src/reviewer-harness.mjs',
    'src/reviewer-spawn-settle.mjs', 'src/reviewer-token-pool.mjs', 'src/reviewer.mjs',
  ];
  // This pure sync config adapter is consumed only by the two async owners
  // above. It never registers a session or accesses the physical transport.
  const syncAdapter = 'src/adapters/agent-runtime/local/non-blocking-codex-model.mjs';
  assert.deepEqual(importers.sort(), [...owners, syncAdapter].sort());
  for (const name of [...owners, 'src/watcher.mjs',
    'src/argus-security-review-child.mjs', 'src/argus-security-review-deps.mjs']) {
    assert.match(readFileSync(new URL(name, root), 'utf8'), /await ensureWorkerRegistryReady(?:Impl)?\(/, name);
  }
  assert.match(readFileSync(new URL('src/osg-reviewer-arm.mjs', root), 'utf8'),
    /await resolveReviewerExecutionAsync\(/);
});

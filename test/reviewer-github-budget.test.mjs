import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReviewerPreModel, reviewerBudgetDeferralReceipt, parseReviewerBudgetDeferral,
  REVIEWER_GITHUB_BUDGET_DEFERRED_EXIT_CODE } from '../src/reviewer-github-budget.mjs';
import { recordResponseRateLimit, githubCredential, GitHubBudgetDeferredError } from '../src/rate-limit-throttle.mjs';
import { fetchPRDiff } from '../src/reviewer-diff-fetch.mjs';
import { classifyReviewerFailure } from '../src/adapters/reviewer-runtime/cli-direct/classification.mjs';

for (const swallowed of [false, true]) test(`pre-model diff exhaustion defers before transport or model (caught=${swallowed})`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'review-budget-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [key, value] of Object.entries({ GHO_RATE_LIMIT_SHARED_STATE_PATH: join(root, 'state.json'),
    GH_TOKEN: 'synthetic-reviewer-token', GITHUB_TOKEN: 'synthetic-reviewer-token' })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  // This fixture tests immediate pre-model deferral; long cached holds are
  // confirmed separately by the rate-limit transport fixtures.
  const resetAt = new Date(Date.now() + 60_000).toISOString();
  await recordResponseRateLimit({ remaining: 0, limit: 5000, resource: 'core', resetAt,
    credential: githubCredential(), observedAt: new Date().toISOString() });
  let modelCalls = 0;
  await assert.rejects(async () => {
    await runReviewerPreModel(async () => {
      try {
        await fetchPRDiff('example/project', 7, 'synthetic-head', {
          getCachedDiffImpl: () => null,
          execFileImpl: async () => assert.fail('exhausted admission cannot call GitHub'),
        });
      } catch (error) {
        if (!swallowed) throw error;
      }
    });
    modelCalls++;
  }, error => {
    assert.ok(error instanceof GitHubBudgetDeferredError);
    const receipt = reviewerBudgetDeferralReceipt(error);
    assert.equal(parseReviewerBudgetDeferral(receipt).resetAt, resetAt);
    assert.equal(classifyReviewerFailure(receipt, REVIEWER_GITHUB_BUDGET_DEFERRED_EXIT_CODE), 'github-budget-deferred');
    assert.notEqual(classifyReviewerFailure(receipt, 1), 'github-budget-deferred');
    return true;
  });
  assert.equal(modelCalls, 0);
});

test('malformed and incomplete receipts cannot masquerade as budget deferrals', () => {
  for (const text of ['[reviewer-github-budget-deferred] {',
    '[reviewer-github-budget-deferred] {"resetAt":"tomorrow"}',
    'unanchored [reviewer-github-budget-deferred] {}']) {
    assert.equal(parseReviewerBudgetDeferral(text), null);
    assert.notEqual(classifyReviewerFailure(text, REVIEWER_GITHUB_BUDGET_DEFERRED_EXIT_CODE), 'github-budget-deferred');
  }
});

for (const phase of ['context', 'diff']) test(`reviewer CLI exits 79 before a model pass when ${phase} admission exhausts`, async t => {
  const { writeFileSync, existsSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const { buildRegisterSource } = await import('./helpers/fixture-loader-register.mjs');
  const root = mkdtempSync(join(tmpdir(), 'review-budget-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const modelMarker = join(root, 'model-called'), transportMarker = join(root, 'transport-called');
  const sourceUrl = name => new URL(`../src/${name}`, import.meta.url).href;
  const registryUrl = sourceUrl('adapters/agent-runtime/local/remediation.mjs');
  const harnessUrl = sourceUrl('reviewer-harness.mjs'), contextUrl = sourceUrl('reviewer-context-auth.mjs');
  // This fixture tests immediate pre-model deferral; long cached holds are
  // confirmed separately by the rate-limit transport fixtures.
  const resetAt = new Date(Date.now() + 60_000).toISOString();
  const sources = {
    'fixture:budget-registry': `export * from ${JSON.stringify(registryUrl + '?actual')};
      export async function ensureWorkerRegistryReady() {}`,
    'fixture:budget-harness': `export * from ${JSON.stringify(harnessUrl + '?actual')};
      import { writeFileSync } from 'node:fs';
      export function resolveReviewerExecution() { return {}; }
      export async function dispatchReviewerModel() {
        writeFileSync(${JSON.stringify(modelMarker)}, 'unexpected model call');
        throw new Error('model must not run');
      }`,
    'fixture:budget-context': `export * from ${JSON.stringify(contextUrl + '?actual')};
      import { recordResponseRateLimit, awaitThrottleIfNeeded, githubCredential } from ${JSON.stringify(sourceUrl('rate-limit-throttle.mjs'))};
      export async function fetchPRContext() {
        const credential = githubCredential();
        await recordResponseRateLimit({ credential, resource: 'core', remaining: 0, limit: 5000,
          resetAt: ${JSON.stringify(resetAt)}, observedAt: new Date().toISOString() });
        ${phase === 'context' ? "await awaitThrottleIfNeeded('core', credential);" : ''}
        return { title: 'Synthetic change', body: '', labels: [], commits: [], reviews: [] };
      }`,
  };
  const aliases = { [registryUrl]: 'fixture:budget-registry', [harnessUrl]: 'fixture:budget-harness',
    [contextUrl]: 'fixture:budget-context' };
  const loader = join(root, 'loader.mjs'), register = join(root, 'register.mjs');
  writeFileSync(loader, `
    const aliases = ${JSON.stringify(aliases)}, sources = ${JSON.stringify(sources)};
    export async function resolve(specifier, context, nextResolve) {
      if (sources[specifier]) return { url: specifier, shortCircuit: true };
      const result = await nextResolve(specifier, context);
      return aliases[result.url] ? { url: aliases[result.url], shortCircuit: true } : result;
    }
    export async function load(url, context, nextLoad) {
      if (sources[url]) return { format: 'module', source: sources[url], shortCircuit: true };
      return nextLoad(url, context);
    }
  `);
  writeFileSync(register, buildRegisterSource(loader));
  writeFileSync(join(root, 'gh'), `#!${process.execPath}
    require('node:fs').writeFileSync(${JSON.stringify(transportMarker)}, 'unexpected transport');
    process.exit(9);
  `, { mode: 0o700 });
  const result = spawnSync(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main',
    '--import', pathToFileURL(register).href, fileURLToPath(new URL('../src/reviewer.mjs', import.meta.url)),
    JSON.stringify({ repo: 'example/project', prNumber: 7, reviewerModel: 'gemini',
      botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN' })], {
    env: { ...process.env, PATH: root, GH_GEMINI_REVIEWER_TOKEN: 'synthetic-reviewer-token',
      GHO_RATE_LIMIT_SHARED_STATE_PATH: join(root, 'state.json') },
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 79, result.stdout + result.stderr);
  assert.equal(parseReviewerBudgetDeferral(result.stderr).resetAt, resetAt);
  assert.equal(existsSync(modelMarker), false);
  assert.equal(existsSync(transportMarker), false);
});

test('the last successful pre-model read exhausting core still prevents the model pass', async t => {
  const root = mkdtempSync(join(tmpdir(), 'review-last-unit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [key, value] of Object.entries({ GHO_RATE_LIMIT_SHARED_STATE_PATH: join(root, 'state.json'),
    GH_TOKEN: 'synthetic-last-unit-token', GITHUB_TOKEN: 'synthetic-last-unit-token' })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  await assert.rejects(runReviewerPreModel(async () => {
    await recordResponseRateLimit({ remaining: 0, limit: 5000, resource: 'core',
      resetAt: Date.now() + 3600_000, observedAt: Date.now(), credential: githubCredential() });
    return { context: 'last read succeeded' };
  }), { name: 'GitHubBudgetDeferredError' });
});

for (const resource of ['core', 'graphql']) test(`last-read guard uses explicit sending env for ${resource}`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'review-explicit-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH;
  process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = join(root, 'state.json');
  t.after(() => {
    if (previous === undefined) delete process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH;
    else process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = previous;
  });
  const env = { GH_TOKEN: `synthetic-explicit-${resource}` };
  const credential = githubCredential({ env });
  await assert.rejects(runReviewerPreModel(async () => {
    await recordResponseRateLimit({ remaining: 0, limit: 5000, resource,
      resetAt: Date.now() + 3600_000, observedAt: Date.now(), credential });
  }, { env }), error => error instanceof GitHubBudgetDeferredError
    && error.credential === credential && error.reviewerPreModelBudgetDeferred === true);
});

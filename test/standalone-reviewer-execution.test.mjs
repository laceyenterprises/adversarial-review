import { fixtureHq } from './helpers/review-cli-resolver-fixture.mjs';
// Each fresh process obtains its own app registry snapshot. Host config and
// filesystem rosters cannot replace governed models or the committed seed.
import { writeDummyCodexAuth } from './helpers/codex-service-fixture.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readCommittedWorkerModelSeed } from '../src/adapters/agent-runtime/local/remediation.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PROBE = `
const h = (await import(process.env.AR_ROOT + '/src/reviewer-harness.mjs')).__test__;
const r = await import(process.env.AR_ROOT + '/src/adapters/agent-runtime/local/remediation.mjs');
const { serviceFixtureExec } = await import(process.env.CODEX_TEST_HELPER);
const quiet = { info() {}, warn(message) { console.warn(message); }, error() {} };
const { dispatchReadTransport } = await import(process.env.AR_ROOT + '/src/dispatch-read-client.mjs');
let connects = 0;
dispatchReadTransport.sdk = () => ({
  async connect(config) {
    connects++;
    return { sessionToken: 'fixture-session', endpoint_url: config.endpoint_url };
  },
  async readSessionHostServices(request, options) {
    if (request.action !== 'worker_registry' || options.session_token !== 'fixture-session') throw Error('session required');
    const failures = {
      denied: {code: 'entitlement_denied'}, 'not-entitled': {code: 'not_entitled'},
      '401': {statusCode: 401}, '403': {statusCode: 403},
      timeout: {code: 'ETIMEDOUT'}, unavailable: {code: 'ECONNREFUSED'}, '5xx': {statusCode: 503},
    };
    if (failures[process.env.REGISTRY_FAILURE]) throw Object.assign(Error('synthetic refusal'), failures[process.env.REGISTRY_FAILURE]);
    if (process.env.REGISTRY_DOWN === '1') throw Error('fixture transport down');
    return {schema_version: 1, status: 'found', data: {classes: {
      'codex-reviewer': {defaultModel: 'governed-codex', defaultReasoningLevel: 'high'},
      'claude-reviewer': {defaultModel: 'governed-claude'},
      'gemini-reviewer': {defaultModel: 'governed-gemini'},
    }}};
  },
  readHostServicesSync() { throw Error('sync transport must never run'); },
});
if (process.env.REGISTRY_ENTRY === 'main') {
  const reviewerPath = process.env.AR_ROOT + '/src/reviewer.mjs';
  process.argv = [process.execPath, reviewerPath, JSON.stringify({
    repo: 'example/fixture', prNumber: 7, reviewerModel: process.env.REVIEWER_CLASS,
    botTokenEnv: 'SYNTHETIC_REVIEWER_GH_TOKEN',
    reviewerArm: process.env.MODEL_PIN ? {model: process.env.MODEL_PIN} : null,
  })];
  await import(reviewerPath);
} else try {
  if (process.env.REGISTRY_ENTRY === 'execution') {
    const rejectAuth = async () => { throw Error('credential probe ran before model infrastructure'); };
    if (process.env.REVIEWER_CLASS === 'codex') await h.reviewWithCodex('+fixture', '', {
      assertCodexOAuthImpl: rejectAuth, codexCli: process.execPath, log: quiet,
    });
    else if (process.env.REVIEWER_CLASS === 'claude') await h.reviewWithClaude('+fixture', '', {
      assertClaudeOAuthImpl: rejectAuth, logger: quiet,
    });
    else await h.reviewWithGemini('+fixture', '', {
      assertOAuthImpl: rejectAuth, resolveGeminiRuntimeImpl: () => 'cli', log: quiet,
    });
  } else if (process.env.REGISTRY_ENTRY === 'recovery') {
    let spawns = 0, recoveries = 0;
    const result = await h.reviewWithCodex('+fixture', '', {
      modelPin: process.env.MODEL_PIN || '',
      execFileSyncImpl: serviceFixtureExec,
      assertCodexOAuthImpl: async () => {}, codexCli: process.execPath, log: quiet,
      spawnCodexReviewImpl: async () => {
        spawns++;
        throw Object.assign(Error('synthetic no progress'), {progressTimedOut: true});
      },
      reviewWithCodexOAuthResponsesImpl: async () => {
        recoveries++;
        return {reviewText: '## Summary\\nSynthetic review.\\n\\n## Verdict\\nComment only'};
      },
    });
    process.stdout.write(JSON.stringify({spawns, recoveries, execution: result.execution}));
    process.exit(0);
  } else if (process.env.REGISTRY_ENTRY === 'grounding') {
    const { readAfhReviewerGrounding } = await import(process.env.AR_ROOT + '/src/afh-reviewer-fallback.mjs');
    await readAfhReviewerGrounding({env: process.env,
      execFileImpl: async () => ({stdout: JSON.stringify({providerStatuses: []})}),
      selectReviewerTokenAccountImpl: async () => null, retryDelaysMs: []});
  } else if (process.env.REGISTRY_ENTRY === 'security') {
    const { createDefaultArgusReviewDeps } = await import(process.env.AR_ROOT + '/src/argus-security-review-deps.mjs');
    const deps = createDefaultArgusReviewDeps({rootDir: process.env.AR_ROOT, env: process.env,
      logger: quiet, evidenceIo: {}, agyLease: {legacy: true},
      identityPool: {plan: () => ({hqOwner: true})},
      reviewWithGeminiImpl: async () => {
        const execution = h.resolveReviewerExecution('gemini', {env: process.env, log: quiet});
        if (execution.modelSource !== (process.env.REGISTRY_DOWN === '1' ? 'committed-seed' : 'registry')) throw Error('unexpected security source');
        return {reviewText: 'fixture review'};
      }});
    await deps.runReviewerModel({model: 'gemini', prompt: 'fixture', cwd: process.env.AR_ROOT, diff: ''});
  } else await h.resolveReviewerExecutionAsync('codex', {env: process.env, log: quiet});
  const codex = h.resolveCodexExecOverrides({env: process.env, log: quiet});
  const claude = r.resolveRemediationModel('claude-reviewer', {env: process.env, log: quiet});
  const gemini = r.resolveRemediationModel('gemini-reviewer', {env: process.env, log: quiet});
  process.stdout.write(JSON.stringify({connects, codex, claude, gemini}));
} catch (error) {
  process.stdout.write(JSON.stringify({connects, code: error.code, failureClass: error.failureClass,
    retryable: error.retryable, category: error.category, modelSource: error.modelSource,
    isOAuthError: error.isOAuthError === true, message: error.message}));
}
`;

// Share immutable installed assets; each probe still has its own HOME and
// fresh process. Keep separate packages for present/missing seed evidence.
const packagedRuntimes = new Map();
after(() => {
  for (const root of packagedRuntimes.values()) rmSync(root, { recursive: true, force: true });
});

function packagedRuntime(missingSeed) {
  if (packagedRuntimes.has(missingSeed)) return packagedRuntimes.get(missingSeed);
  const arRoot = mkdtempSync(path.join(tmpdir(), 'ar-runtime-'));
  try {
    // Copy shipped runtime assets rather than retaining runner source symlinks.
    for (const entry of ['src', 'bin', 'domains', 'prompts', 'templates', 'config', 'modules', 'migrations', 'config.yaml', 'config.json', 'package.json', 'package-lock.json']) {
      if (existsSync(path.join(repoRoot, entry))) {
        cpSync(path.join(repoRoot, entry), path.join(arRoot, entry), { recursive: true, dereference: true });
      }
    }
    if (missingSeed) rmSync(path.join(arRoot, 'src/adapters/agent-runtime/local/worker-model-seed.json'));
    symlinkSync(path.join(repoRoot, 'node_modules'), path.join(arRoot, 'node_modules'), 'dir');
    packagedRuntimes.set(missingSeed, arRoot);
    return arRoot;
  } catch (error) {
    rmSync(arRoot, { recursive: true, force: true });
    throw error;
  }
}

function standaloneRun(t, { codexConfig = null, down = false, entry = 'reviewer', missingSeed = false, reviewer = 'codex', failure = '', pin = '' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ar-standalone-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const arRoot = packagedRuntime(missingSeed);
  const home = path.join(root, 'home');
  writeDummyCodexAuth(path.join(home, '.codex', 'auth.json'));
  if (codexConfig) writeFileSync(path.join(home, '.codex', 'config.toml'), codexConfig);
  const probePath = path.join(root, 'probe.mjs');
  writeFileSync(probePath, PROBE);
  // Deliberately minimal env: nothing from an Agent OS host leaks in.
  const env = { HQ_BIN: fixtureHq, CODEX_TEST_HELPER: new URL('./helpers/codex-service-fixture.mjs', import.meta.url).href, HOME: home, PATH: process.env.PATH, AR_ROOT: arRoot, TMPDIR: root,
    REGISTRY_DOWN: down ? '1' : '0', REGISTRY_ENTRY: entry, REVIEWER_CLASS: reviewer,
    REGISTRY_FAILURE: failure, MODEL_PIN: pin, GEMINI_REVIEWER_MODEL: reviewer === 'gemini' ? pin : '',
    AGENT_OS_CODEX_PER_WORKER_AUTH: '0', CODEX_BROKER_PROVIDER: 'codex' };
  const result = spawnSync(process.execPath, [probePath], { env, cwd: root, encoding: 'utf8', timeout: 60_000 });
  if (entry === 'main') {
    assert.equal(result.status, 1, `expected the synthetic missing-token boundary: ${result.stderr}`);
    if (['denied', 'not-entitled', '401', '403'].includes(failure) && !pin) {
      assert.match(result.stderr, /reviewer-configuration-error.*modelSource=unresolved.*host\.observations\.read/);
      assert.doesNotMatch(result.stderr, /github-auth-outage|WARNING.*modelSource=committed-seed/);
    } else if (missingSeed) {
      assert.match(result.stderr, /reviewer-model-unresolved.*modelSource=unresolved/);
      assert.doesNotMatch(result.stderr, /github-auth-outage/);
    } else {
      assert.match(result.stderr, /github-auth-outage.*SYNTHETIC_REVIEWER_GH_TOKEN/);
      assert.match(result.stderr, pin ? /modelSource=env-pin/ : /WARNING.*modelSource=committed-seed/);
      if (pin) assert.doesNotMatch(result.stderr, /WARNING.*modelSource=committed-seed/);
      assert.doesNotMatch(result.stderr, /reviewer-model-unresolved/);
    }
    return { diagnostics: result.stderr };
  }
  assert.equal(result.status, 0, `standalone probe failed:\n${result.stderr}`);
  return {...JSON.parse(result.stdout), diagnostics: result.stderr};
}

test('fresh standalone process establishes its own app session before synchronous resolution', t => {
  const out = standaloneRun(t);
  assert.equal(out.connects, 1);
  assert.equal(out.codex.model, 'governed-codex');
  assert.equal(out.codex.modelSource, 'registry');
  assert.equal(out.claude.resolvedModel, 'governed-claude');
  assert.equal(out.gemini.resolvedModel, 'governed-gemini');
});

test('standalone host model cannot replace the governed registry model', t => {
  const out = standaloneRun(t, {codexConfig: 'model = "host-model"\nmodel_reasoning_effort = "medium"\n'});
  assert.equal(out.codex.model, 'governed-codex');
  assert.equal(out.codex.reasoningEffort, 'high');
  assert.equal(out.codex.modelSource, 'registry');
});

test('fresh standalone registry outage is retryable infrastructure without an OAuth notice', t => {
  const out = standaloneRun(t, {down: true, missingSeed: true});
  assert.equal(out.connects, 1);
  assert.equal(out.code, 'registry-unavailable');
  assert.equal(out.failureClass, 'reviewer-model-unresolved');
  assert.equal(out.retryable, true);
  assert.equal(out.isOAuthError, false);
  assert.doesNotMatch(out.message, /re-authenticate|OAuth credentials unavailable/);
});


test('fresh quota grounding process establishes its own registry without a watcher', t => {
  const out = standaloneRun(t, {entry: 'grounding'});
  assert.equal(out.connects, 1);
  assert.equal(out.codex.model, 'governed-codex');
  assert.equal(out.claude.resolvedModel, 'governed-claude');
});

test('fresh quota grounding process uses the committed seed during an outage', t => {
  const out = standaloneRun(t, {entry: 'grounding', down: true});
  assert.equal(out.codex.modelSource, 'committed-seed');
  assert.equal(out.gemini.modelSource, 'committed-seed');
  assert.match(out.diagnostics, /WARNING.*modelSource=committed-seed/);
});


test('fresh security reviewer process establishes its own registry without a watcher', t => {
  const out = standaloneRun(t, {entry: 'security'});
  assert.equal(out.connects, 1);
  assert.equal(out.gemini.resolvedModel, 'governed-gemini');
});

test('fresh security reviewer process uses the committed seed during an outage', t => {
  const out = standaloneRun(t, {entry: 'security', down: true});
  assert.equal(out.codex.modelSource, 'committed-seed');
  assert.equal(out.gemini.modelSource, 'committed-seed');
  assert.match(out.diagnostics, /WARNING.*modelSource=committed-seed/);
});

for (const reviewer of ['gemini', 'claude', 'codex']) {
  test(`real ${reviewer} reviewer main passes failed registry prefetch with a valid committed seed`, t => {
    standaloneRun(t, { entry: 'main', down: true, reviewer });
  });
  test(`real ${reviewer} reviewer main reports missing registry and seed as infrastructure before GitHub auth`, t => {
    standaloneRun(t, { entry: 'main', down: true, missingSeed: true, reviewer });
  });
  test(`${reviewer} harness reports missing registry and seed before model credentials`, t => {
    const out = standaloneRun(t, { entry: 'execution', down: true, missingSeed: true, reviewer });
    assert.equal(out.failureClass, 'reviewer-model-unresolved');
    assert.equal(out.retryable, true);
    assert.match(out.message, /modelSource=unresolved/);
    assert.doesNotMatch(out.message, /credential probe/);
  });
}

for (const failure of ['denied', 'not-entitled', '401', '403', 'timeout', 'unavailable', '5xx']) {
  const refused = ['denied', 'not-entitled', '401', '403'].includes(failure);
  for (const reviewer of ['gemini', 'claude', 'codex']) {
    test(`real ${reviewer} entry preserves ${failure} classification and pin precedence`, t => {
      standaloneRun(t, {entry: 'main', reviewer, failure});
      const pin = readCommittedWorkerModelSeed().classes[`${reviewer}-reviewer`].defaultModel;
      standaloneRun(t, {entry: 'main', reviewer, failure, pin});
    });
    if (refused) {
      test(`${reviewer} harness refuses ${failure} before credentials or seed warnings`, t => {
        const out = standaloneRun(t, {entry: 'execution', reviewer, failure});
        assert.equal(out.retryable, false);
        assert.equal(out.category, 'configuration');
        assert.equal(out.modelSource, 'unresolved');
        assert.match(out.message, /host\.observations\.read/);
        assert.doesNotMatch(out.message, /credential probe/);
        assert.doesNotMatch(out.diagnostics, /WARNING.*modelSource=committed-seed/);
      });
    }
  }
  test(`Codex recovery preserves ${failure} classification and pin precedence`, t => {
    const out = standaloneRun(t, {entry: 'recovery', failure});
    if (refused) {
      assert.equal(out.retryable, false);
      assert.equal(out.category, 'configuration');
      assert.equal(out.modelSource, 'unresolved');
      assert.match(out.message, /host\.observations\.read/);
      assert.doesNotMatch(out.diagnostics, /WARNING.*modelSource=committed-seed|invoking native Codex|retrying through OAuth/);
    } else {
      assert.equal(out.spawns, 1);
      assert.equal(out.recoveries, 1);
      assert.equal(out.execution.modelSource, 'committed-seed');
      assert.match(out.diagnostics, /WARNING.*modelSource=committed-seed/);
    }
    const pin = readCommittedWorkerModelSeed().classes['codex-reviewer'].defaultModel;
    const pinned = standaloneRun(t, {entry: 'recovery', failure, pin});
    assert.equal(pinned.spawns, 1);
    assert.equal(pinned.recoveries, 1);
    assert.equal(pinned.execution.model, pin);
    assert.equal(pinned.execution.modelSource, 'env-pin');
    assert.equal(pinned.execution.harness, 'codex');
    assert.doesNotMatch(pinned.diagnostics, /WARNING.*modelSource=committed-seed/);
  });
}

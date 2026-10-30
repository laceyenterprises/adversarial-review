import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { materializePerWorkerCodexAuth, prepareCorporateCodexReviewerAuth } from '../src/codex-per-worker-auth.mjs';
import { spawnCodexRemediationWorker, waitForLocalRemediationExit } from '../src/adapters/agent-runtime/local/remediation.mjs';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupServiceCodexAuth, prepareServiceCodexHome, serviceCodexConfigArgs } from '../src/codex-service-home.mjs';
import { probeCodexCli } from '../src/adapters/reviewer-runtime/cli-direct/discovery.mjs';
import { dummyCodexAuth, serviceFixtureExec, writeDummyCodexAuth } from './helpers/codex-service-fixture.mjs';

const quiet = { info() {}, warn() {} };

function materializer(f, capture) {
  const syncBin = join(f.root, 'dummy-sync');
  writeFileSync(syncBin, '# synthetic broker boundary; never executed');
  return options => {
    const auth = materializePerWorkerCodexAuth({
      ...options,
      env: { ...options.env, AGENT_OS_CODEX_WORKER_AUTH_SYNC_BIN: syncBin },
      resolveOperatorHomeImpl: () => f.root,
      execFileSyncImpl(_cmd, _args, { env }) {
        assert.equal(env.CODEX_BROKER_PROVIDER, options.provider);
        writeDummyCodexAuth(env.CODEX_WORKER_AUTH_PATH);
      },
    });
    capture?.(auth);
    return auth;
  };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'service-home-fixture-'));
  const authPath = writeDummyCodexAuth(join(root, '.codex', 'auth.json'));
  return { root, authPath, env: { HOME: root, CODEX_AUTH_PATH: authPath },
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function prepare(f, extra = {}) {
  return prepareServiceCodexHome({ env: f.env, workspaceDir: f.root,
    model: 'fixture-model', codexCli: '/fixture/codex', execFileSyncImpl: serviceFixtureExec,
    log: quiet, ...extra });
}
const catalogFixture = { version: 'synthetic', models: [
  { slug: 'fixture-model', tool_mode: 'code_mode_only', supports_search_tool: true,
    context_window: 120000, experimental_supported_tools: ['fixture-clock'], extra: { preserved: true } },
  { slug: 'fixture-direct', tool_mode: 'direct', supports_search_tool: true },
  { slug: 'fixture-legacy', display_name: 'Synthetic legacy model' },
] };

test('isolates config and CLI auth without changing source ownership or refresh tokens', () => {
  const f = fixture();
  const sourceConfig = '[plugins.browser]\nenabled = true\n[mcp_servers.fixture]\ncommand = "fixture"\n';
  writeFileSync(join(dirname(f.authPath), 'config.toml'), sourceConfig);
  const original = readFileSync(f.authPath, 'utf8');
  const home = prepare(f, { effort: 'high', env: { ...f.env, CODEX_HOME: dirname(f.authPath),
    OPENAI_API_KEY: 'synthetic-key', CODEX_API_KEY: 'synthetic-key', CODEX_ACCESS_TOKEN: 'synthetic-token' } });
  try {
    assert.notEqual(home.codexHome, dirname(f.authPath));
    assert.equal(home.authSourcePath, f.authPath);
    assert.equal(home.env.CODEX_AUTH_PATH, join(home.codexHome, 'auth.json'));
    assert.equal(home.env.HOME, f.root);
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']) assert.equal(home.env[key], undefined);
    assert.equal(statSync(home.codexHome).mode & 0o777, 0o700);
    assert.equal(statSync(home.authPath).mode & 0o777, 0o600);
    const snapshot = JSON.parse(readFileSync(home.authPath, 'utf8'));
    assert.equal(snapshot.tokens.access_token, dummyCodexAuth.tokens.access_token);
    assert.equal(snapshot.tokens.refresh_token, 'agent-os-per-worker-placeholder-no-rotate');
    const config = readFileSync(join(home.codexHome, 'config.toml'), 'utf8');
    assert.doesNotMatch(config, /\[(?:plugins|marketplaces|desktop|mcp_servers)(?:\.|\])/);
    assert.equal((config.match(/\[projects\./g) || []).length, 1);
    assert.match(config, /model_reasoning_effort = "high"/);
    assert.match(config, /cli_auth_credentials_store = "file"/);
    assert.equal(home.configDigest, createHash('sha256').update(config).digest('hex'));
    assert.equal(readFileSync(join(dirname(f.authPath), 'config.toml'), 'utf8'), sourceConfig);
    // Simulate a CLI rewriting its store: no alias/writeback to the owner.
    writeFileSync(home.authPath, '{}');
    home.cleanupAuth();
    assert.equal(readFileSync(f.authPath, 'utf8'), original);
    assert.ok(existsSync(join(home.codexHome, 'config.toml')));
  } finally { home.cleanup(); f.cleanup(); }
});

for (const [label, source] of [
  ['root', { account_id: 'synthetic-account' }],
  ['chatgpt', { tokens: { chatgpt_account_id: 'synthetic-account' } }],
]) {
  test(`snapshot keeps the account id from the ${label} location`, () => {
    const f = fixture();
    const { account_id: _omitted, ...tokens } = dummyCodexAuth.tokens;
    writeFileSync(f.authPath, JSON.stringify({ ...dummyCodexAuth, ...source,
      tokens: { ...tokens, ...source.tokens } }));
    const home = prepare(f);
    try {
      assert.equal(JSON.parse(readFileSync(home.authPath, 'utf8')).tokens.account_id, 'synthetic-account');
    } finally { home.cleanup(); f.cleanup(); }
  });
}

test('cleanupServiceCodexAuth is a no-op for a missing worker', () => {
  for (const worker of [null, undefined, {}]) assert.equal(cleanupServiceCodexAuth(worker), false);
});

for (const lookup of ['explicit', 'codex-home', 'default-home', 'legacy-oauth']) {
  test(`source lookup ${lookup} is resolved before home replacement`, () => {
    const f = fixture();
    if (lookup === 'legacy-oauth') {
      const legacy = { ...dummyCodexAuth };
      delete legacy.auth_mode;
      writeFileSync(f.authPath, JSON.stringify(legacy));
    }
    const env = lookup === 'explicit' ? f.env : { HOME: f.root,
      ...(lookup === 'codex-home' ? { CODEX_HOME: dirname(f.authPath) } : {}) };
    const home = prepare(f, { env });
    try { assert.equal(home.authSourcePath, f.authPath); }
    finally { home.cleanup(); f.cleanup(); }
  });
}

for (const failure of ['missing', 'invalid-json', 'missing-token', 'api-key', 'explicit-other-mode', 'cli-reject', 'cli-not-logged-in', 'cli-api-key']) {
  test(`auth ${failure} fails before catalog or paid execution and redacts errors`, () => {
    const f = fixture();
    let isolatedHome;
    let calls = 0;
    if (failure === 'missing') rmSync(f.authPath);
    if (failure === 'invalid-json') writeFileSync(f.authPath, 'synthetic-secret-invalid-json');
    if (failure === 'missing-token') writeFileSync(f.authPath, '{"auth_mode":"chatgpt","tokens":{}}');
    if (failure === 'api-key') writeFileSync(f.authPath, '{"OPENAI_API_KEY":"synthetic-secret"}');
    if (failure === 'explicit-other-mode') writeFileSync(f.authPath, JSON.stringify({ ...dummyCodexAuth, auth_mode: 'apikey' }));
    try {
      assert.throws(() => prepare(f, { execFileSyncImpl(_cmd, args, { env }) {
        calls += 1;
        isolatedHome = env.CODEX_HOME;
        assert.deepEqual(args, ['login', 'status']);
        if (failure === 'cli-reject') throw new Error('synthetic-secret-parser-output');
        return failure === 'cli-api-key' ? 'Logged in using an API key' : 'Not logged in';
      } }), error => error.failureClass === 'oauth-broken' && /pre-side-effect/.test(error.message)
        && !/synthetic-secret/.test(error.message) && !error.cause);
      assert.equal(calls, failure.startsWith('cli-') ? 1 : 0);
      if (isolatedHome) assert.equal(existsSync(isolatedHome), false);
    } finally { f.cleanup(); }
  });
}

test('CLI auth preflight precedes catalog fetch; catalog changes only tooling fields', () => {
  const f = fixture();
  const calls = [];
  const home = prepare(f, { execFileSyncImpl(command, args, options) {
    calls.push(args.join(' '));
    const result = serviceFixtureExec(command, args, options);
    return args[0] === 'login' ? result : JSON.stringify(catalogFixture);
  } });
  try {
    assert.deepEqual(calls, ['login status', 'debug models']);
    const expected = structuredClone(catalogFixture);
    for (const entry of expected.models) { delete entry.tool_mode; delete entry.supports_search_tool; }
    assert.deepEqual(JSON.parse(readFileSync(home.catalogPath, 'utf8')), expected);
    assert.equal(statSync(home.catalogPath).mode & 0o777, 0o600);
  } finally { home.cleanup(); f.cleanup(); }
});

for (const failure of ['fetch', 'parse', 'empty', 'entry', 'missing-model', 'write-catalog', 'pin-config']) {
  test(`catalog ${failure} falls back only after effective auth succeeds`, () => {
    const f = fixture();
    const warnings = [];
    const home = prepare(f, { log: { ...quiet, warn: line => warnings.push(line) },
      execFileSyncImpl(command, args, options) {
        if (args[0] === 'login') return serviceFixtureExec(command, args, options);
        if (failure === 'fetch') throw new Error('synthetic-private-output');
        if (failure === 'parse') return '{invalid';
        if (failure === 'empty') return '{"models":[]}';
        if (failure === 'entry') return '{"models":[null]}';
        if (failure === 'missing-model') return '{"models":[{"slug":"other"}]}';
        mkdirSync(join(options.env.CODEX_HOME, failure === 'write-catalog' ? 'model-catalog.direct-tools.json' : 'config.toml.tmp'));
        return JSON.stringify(catalogFixture);
      } });
    try {
      assert.equal(home.catalogPath, null);
      assert.ok(existsSync(home.authPath));
      assert.doesNotMatch(readFileSync(join(home.codexHome, 'config.toml'), 'utf8'), /model_catalog_json/);
      assert.equal(warnings.length, 1);
      assert.doesNotMatch(warnings[0], /synthetic-private-output/);
    } finally { home.cleanup(); f.cleanup(); }
  });
}

test('offline subprocess consumes auth.json while ignoring an external CODEX_AUTH_PATH', () => {
  const f = fixture();
  const binary = join(f.root, 'codex');
  const boundary = fileURLToPath(new URL('./fixtures/codex-service-cli.mjs', import.meta.url));
  writeFileSync(binary, `#!/bin/sh\nexec '${process.execPath}' '${boundary}' "$@"\n`, { mode: 0o700 });
  const home = prepare(f, { codexCli: binary, execFileSyncImpl: undefined });
  try {
    assert.ok(home.catalogPath);
    assert.ok(existsSync(home.authPath));
    rmSync(home.authPath);
    const result = spawnSync(binary, ['login', 'status'], { env: { HOME: f.root,
      CODEX_HOME: home.codexHome, CODEX_AUTH_PATH: f.authPath }, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Not logged in/);
  } finally { home.cleanup(); f.cleanup(); }
});

const deployedCli = '/opt/homebrew/bin/codex';
for (const legacy of [false, true]) {
  test(`deployed CLI offline login status consumes the dummy service store (legacy=${legacy})`, { skip: !existsSync(deployedCli) }, () => {
    const f = fixture();
    if (legacy) {
      const auth = { ...dummyCodexAuth };
      delete auth.auth_mode;
      writeFileSync(f.authPath, JSON.stringify(auth));
    }
    const empty = join(f.root, 'empty');
    mkdirSync(empty);
    const env = { HOME: f.root, PATH: '/usr/bin:/bin', CODEX_HOME: empty, CODEX_AUTH_PATH: f.authPath };
    const status = (effectiveEnv) => {
      const result = spawnSync(deployedCli, ['login', 'status'], { env: effectiveEnv, cwd: f.root,
        encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
      return { code: result.status, text: `${result.stdout || ''}\n${result.stderr || ''}` };
    };
    let home;
    try {
      assert.match(status(env).text, /Not logged in/);
      home = prepare(f, { codexCli: deployedCli, execFileSyncImpl(command, args, options) {
        if (args[0] !== 'login') return serviceFixtureExec(command, args, options); // no catalog network
        const result = status(options.env);
        assert.equal(result.code, 0);
        assert.match(result.text, /Logged in using ChatGPT/);
        return result.text;
      } });
      assert.ok(home.authPath);
    } finally { home?.cleanup(); f.cleanup(); }
  });
}

test('discovery isolates every compatibility probe and removes only its service home', async () => {
  const f = fixture();
  const homes = [];
  const calls = [];
  try {
    await probeCodexCli({ env: { ...f.env, CODEX_CLI: '/fixture/codex' }, cwd: f.root,
      requireMcpOAuth: true, ensureWorkerRegistryReadyImpl: async () => {}, execFileSyncImpl: serviceFixtureExec,
      execFileImpl: async (_cmd, args, { env }) => {
        homes.push(env.CODEX_HOME); calls.push(args.join(' '));
        assert.equal(env.CODEX_AUTH_PATH, join(env.CODEX_HOME, 'auth.json'));
        assert.ok(JSON.parse(readFileSync(env.CODEX_AUTH_PATH)).tokens.access_token);
        if (args[0] === 'sessions') throw new Error("unrecognized subcommand 'sessions'");
        return { stdout: args[0] === 'login' ? 'Logged in using ChatGPT' : 'fixture', stderr: '' };
      } });
    assert.deepEqual(calls, ['--version', 'sessions list', 'login status', 'mcp list']);
    assert.ok(homes.every(home => !existsSync(home)));
    assert.ok(existsSync(f.authPath));
  } finally { f.cleanup(); }
});

for (const failure of [null, 'progress', 'cli-auth', 'registry']) {
  test(`reviewer cleans owned staging and service auth (${failure || 'success'})`, async () => {
    const { __test__: { reviewWithCodex, spawnCodexReview } } = await import('../src/reviewer-harness.mjs');
    const f = fixture();
    const saved = { CODEX_AUTH_PATH: process.env.CODEX_AUTH_PATH, AGENT_OS_CODEX_PER_WORKER_AUTH: process.env.AGENT_OS_CODEX_PER_WORKER_AUTH };
    process.env.CODEX_AUTH_PATH = f.authPath;
    process.env.AGENT_OS_CODEX_PER_WORKER_AUTH = '1';
    let home;
    let staged;
    let registryCalls = 0;
    const run = () => reviewWithCodex('+fixture', '', {
      codexCli: process.execPath, reviewerSubprocessCwd: f.root, log: quiet,
      materializePerWorkerCodexAuthImpl: materializer(f, auth => { staged = auth; }),
      assertCodexOAuthImpl: async () => {}, ensureWorkerRegistryReadyImpl: async () => {
        if (++registryCalls === 2 && failure === 'registry') throw new Error('fixture registry failed');
      },
      execFileSyncImpl(command, args, options) {
        home = options.env.CODEX_HOME;
        if (failure === 'cli-auth') throw new Error('synthetic-secret-parser-output');
        return serviceFixtureExec(command, args, options);
      },
      onProgress() { if (failure === 'progress') throw new Error('fixture progress failed'); },
      spawnCodexReviewImpl: async options => {
        const { env, serviceHome } = options;
        assert.equal(failure, null);
        assert.equal(env.CODEX_AUTH_PATH, join(home, 'auth.json'));
        assert.equal(serviceHome.codexHome, home);
        return spawnCodexReview({ ...options, spawnCapturedImpl: async (_command, _args, { env: childEnv }) => {
          assert.equal(childEnv.PWD, f.root); // service auth must preserve the snapshot cwd envelope
          assert.equal(childEnv.CODEX_AUTH_PATH, join(home, 'auth.json'));
          return { stdout: 'Synthetic review completed.', stderr: '' };
        } });
      },
    });
    try {
      if (failure) await assert.rejects(run(), /fixture (?:progress|registry) failed|pre-side-effect/);
      else assert.equal((await run()).reviewText, 'Synthetic review completed.');
      if (failure !== 'registry') { assert.ok(home); assert.equal(existsSync(home), false); }
      assert.ok(staged);
      assert.equal(existsSync(staged.codexHome), false);
      assert.ok(existsSync(f.authPath));
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      f.cleanup();
    }
  });
}

for (const provider of ['codex', 'codex-corp']) {
  for (const failure of [null, 'cli-auth', 'spawn', 'reply-context']) {
    test(`${provider} staging hands auth to service and cleans owned files (${failure || 'exit'})`, async () => {
      const f = fixture();
      const sourceBytes = readFileSync(f.authPath, 'utf8');
      const promptPath = join(f.root, 'prompt.md');
      writeFileSync(promptPath, 'Synthetic remediation.');
      let staged;
      let serviceDir;
      let child;
      let opens = 0;
      const options = {
        workspaceDir: f.root, promptPath, outputPath: join(f.root, 'output.md'),
        logPath: join(f.root, 'worker.log'),
        ...(failure === 'reply-context' ? {} : { replyPath: join(f.root, 'reply.json'), hqRoot: f.root }),
        workerClass: provider === 'codex-corp' ? 'remediator-codex-corp' : 'codex',
        enforceHarnessIdentity: false, log: quiet,
        sourceEnv: { HOME: f.root, CODEX_HOME: dirname(f.authPath), HQ_REPO_ROOT: f.root,
          // Corporate staging cannot be disabled by a primary auth path/kill switch.
          ...(provider === 'codex-corp' ? { CODEX_AUTH_PATH: f.authPath, AGENT_OS_CODEX_PER_WORKER_AUTH: '0' } : {}) },
        materializePerWorkerCodexAuthImpl: materializer(f, auth => { staged = auth; }),
        modelResolution: { resolvedModel: 'fixture-model', resolvedReasoningLevel: 'high' },
        execFileSyncImpl(command, args, options) {
          serviceDir = options.env.CODEX_HOME;
          if (failure === 'cli-auth') throw new Error('synthetic-secret-parser-output');
          return serviceFixtureExec(command, args, options);
        },
        openSyncImpl() { opens += 1; return 51 + opens; }, closeSyncImpl() {},
        spawnImpl(_cmd, _args, { env }) {
          assert.equal(existsSync(staged.codexHome), false);
          assert.equal(env.HOME, f.root);
          assert.equal(env.CODEX_AUTH_PATH, join(serviceDir, 'auth.json'));
          assert.equal(JSON.parse(readFileSync(env.CODEX_AUTH_PATH)).tokens.refresh_token,
            'agent-os-per-worker-placeholder-no-rotate');
          if (failure === 'spawn') throw new Error('synthetic spawn failure');
          child = Object.assign(new EventEmitter(), { pid: 123456, unref() {} });
          return child;
        },
      };
      try {
        if (failure) {
          assert.throws(() => spawnCodexRemediationWorker(options));
          if (failure === 'cli-auth' || failure === 'reply-context') assert.equal(opens, 0);
          if (serviceDir) assert.equal(existsSync(serviceDir), false);
        } else {
          const worker = spawnCodexRemediationWorker(options);
          assert.equal(worker.startupEvidence.resolvedStartup.authPath, staged.authPath);
          assert.equal(worker.startupEvidence.resolvedStartup.effectiveAuthPath, join(serviceDir, 'auth.json'));
          assert.equal(worker.startupEvidence.resolvedStartup.refreshOwner, 'broker');
          mkdirSync(worker.codexSessionRoot);
          writeFileSync(join(worker.codexSessionRoot, 'synthetic.jsonl'), '{}');
          child.emit('exit', 0);
          assert.equal(existsSync(join(serviceDir, 'auth.json')), false);
          // A daemon restart loses closures. Serialized receipt still owns cleanup.
          writeDummyCodexAuth(join(serviceDir, 'auth.json'));
          const persisted = JSON.parse(JSON.stringify({ ...worker, child: undefined }));
          assert.equal(cleanupServiceCodexAuth({ ...persisted, codexAuthOwnerId: 'another-owner' }), false);
          assert.equal(existsSync(join(serviceDir, 'auth.json')), true);
          await waitForLocalRemediationExit(persisted, {
            processKillImpl() { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
          });
          assert.equal(existsSync(join(serviceDir, 'auth.json')), false);
          assert.ok(existsSync(join(worker.codexSessionRoot, 'synthetic.jsonl')));
        }
        assert.ok(staged);
        assert.equal(existsSync(staged.codexHome), false);
        assert.equal(readFileSync(f.authPath, 'utf8'), sourceBytes);
      } finally {
        if (serviceDir) rmSync(serviceDir, { recursive: true, force: true });
        f.cleanup();
      }
    });
  }
}

test('corporate reviewer discovery consumes its broker-staged credential in an isolated file store', async () => {
  const f = fixture();
  const env = { ...f.env, CODEX_BROKER_PROVIDER: 'codex-corp', CODEX_CLI: '/fixture/codex' };
  const auth = prepareCorporateCodexReviewerAuth(env, 'synthetic-session', { materializeImpl: materializer(f) });
  let home;
  try {
    await probeCodexCli({
      env, cwd: f.root, ensureWorkerRegistryReadyImpl: async () => {},
      execFileSyncImpl: serviceFixtureExec,
      execFileImpl: async (_cmd, _args, options) => {
        home = options.env.CODEX_HOME;
        assert.notEqual(home, auth.codexHome);
        assert.equal(options.env.CODEX_AUTH_PATH, join(home, 'auth.json'));
        return { stdout: 'fixture', stderr: '' };
      },
    });
    assert.equal(existsSync(home), false);
    assert.equal(existsSync(auth.authPath), true); // adapter owns staging, not the probe
  } finally {
    auth.cleanup();
    assert.equal(existsSync(auth.codexHome), false);
    assert.ok(existsSync(f.authPath));
    f.cleanup();
  }
});

for (const code of ['ENOENT', 'EACCES']) {
  test(`CLI launch failure ${code} is an infrastructure error, not an OAuth rejection`, () => {
    const f = fixture();
    let isolatedHome;
    try {
      assert.throws(() => prepare(f, { execFileSyncImpl(_cmd, args, { env }) {
        isolatedHome = env.CODEX_HOME;
        assert.deepEqual(args, ['login', 'status']);
        throw Object.assign(new Error(`spawn /fixture/codex ${code}`), { code });
      } }), error => error.name === 'CodexLaunchError' && error.code === code
        && error.failureClass === 'infrastructure' && !/fixture\/codex/.test(error.message));
      if (isolatedHome) assert.equal(existsSync(isolatedHome), false);
    } finally { f.cleanup(); }
  });
}

test('cleanupServiceCodexAuth removes owned auth through a symlinked home path', () => {
  // A reconciling daemon may see the home through a different alias (for
  // example /tmp versus /private/tmp, or another TMPDIR spelling).
  const f = fixture();
  const home = prepare(f);
  const aliasRoot = mkdtempSync(join(tmpdir(), 'service-home-alias-'));
  try {
    const alias = join(aliasRoot, 'alias-home');
    symlinkSync(home.codexHome, alias);
    assert.ok(existsSync(home.authPath));
    assert.equal(cleanupServiceCodexAuth({ codexHome: alias, codexAuthOwnerId: 'another-owner' }), false);
    assert.ok(existsSync(home.authPath));
    assert.equal(cleanupServiceCodexAuth({ codexHome: alias, codexAuthOwnerId: home.codexAuthOwnerId }), true);
    assert.equal(existsSync(home.authPath), false);
    assert.ok(existsSync(f.authPath));
  } finally { home.cleanup(); rmSync(aliasRoot, { recursive: true, force: true }); f.cleanup(); }
});

test('reviewer CLI overrides pin the file credential store under --ignore-user-config', () => {
  const args = serviceCodexConfigArgs();
  const values = args.filter((_, index) => index % 2 === 1);
  assert.ok(args.every((arg, index) => index % 2 === 1 || arg === '--config'));
  assert.ok(values.includes('cli_auth_credentials_store="file"'));
});

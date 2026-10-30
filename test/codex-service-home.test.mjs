import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareServiceCodexHome } from '../src/codex-service-home.mjs';
import { probeCodexCli } from '../src/adapters/reviewer-runtime/cli-direct/discovery.mjs';

test('service home ignores interactive tooling and keeps explicit per-worker auth untouched', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'service-home-fixture-'));
  const interactive = join(fixture, '.codex');
  mkdirSync(interactive);
  const interactiveConfig = '[plugins.browser]\nenabled = true\n[marketplaces.fixture]\nsource = "fixture"\n[desktop]\nenabled = true\n[mcp_servers.fixture]\ncommand = "fixture"\n[projects."/fixture/old"]\ntrust_level = "trusted"\n';
  writeFileSync(join(interactive, 'config.toml'), interactiveConfig);
  const authPath = join(fixture, 'per-worker', 'auth.json');
  const logs = [];
  const home = prepareServiceCodexHome({ env: { HOME: fixture, CODEX_HOME: interactive, CODEX_AUTH_PATH: authPath },
    workspaceDir: '/fixture/job', model: 'fixture-model', effort: 'high', codexCli: '/fixture/missing-codex',
    log: { info: (line) => logs.push(line) } });
  try {
    assert.notEqual(home.env.CODEX_HOME, interactive);
    assert.equal(home.env.CODEX_AUTH_PATH, authPath);
    assert.equal(home.env.HOME, fixture);
    assert.equal(existsSync(join(home.codexHome, 'auth.json')), false);
    assert.equal(statSync(home.codexHome).mode & 0o777, 0o700);
    const config = readFileSync(join(home.codexHome, 'config.toml'), 'utf8');
    assert.doesNotMatch(config, /\[(?:plugins|marketplaces|desktop|mcp_servers)(?:\.|\])/);
    assert.equal((config.match(/\[projects\./g) || []).length, 1);
    assert.match(config, /\[projects\."\/fixture\/job"\]/);
    assert.match(config, /model = "fixture-model"/);
    assert.match(config, /model_reasoning_effort = "high"/);
    assert.match(config, /shell_tool = true/);
    assert.match(config, /plugins = false/);
    assert.equal(home.configDigest, createHash('sha256').update(config).digest('hex'));
    assert.ok(logs[0].includes(`CODEX_HOME=${home.codexHome} config_sha256=${home.configDigest}`));
    assert.equal(readFileSync(join(interactive, 'config.toml'), 'utf8'), interactiveConfig);
  } finally { home.cleanup(); rmSync(fixture, { recursive: true, force: true }); }
});

const catalogFixture = {
  version: 'synthetic',
  models: [
    { slug: 'fixture-model', tool_mode: 'code_mode_only', supports_search_tool: true,
      context_window: 120000, experimental_supported_tools: ['fixture-clock'], extra: { preserved: true } },
    { slug: 'fixture-direct', tool_mode: 'direct', supports_search_tool: true },
    { slug: 'fixture-legacy', display_name: 'Synthetic legacy model' },
  ],
};

test('seeding renders the spawn binary catalog through staged auth and pins only direct tooling changes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'service-catalog-fixture-'));
  const binary = join(fixture, 'codex-fixture');
  const authPath = join(fixture, 'synthetic-auth.json');
  const logs = [];
  // A real subprocess, with synthetic inputs only, verifies argv/env/cwd and
  // that base config exists before fetching. No auth file is read or copied.
  writeFileSync(binary, `#!${process.execPath}
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
assert.deepEqual(process.argv.slice(2), ['debug', 'models']);
assert.equal(process.cwd(), ${JSON.stringify(fixture)});
assert.equal(process.env.CODEX_AUTH_PATH, ${JSON.stringify(authPath)});
assert.notEqual(process.env.CODEX_HOME, ${JSON.stringify(fixture)});
assert.match(readFileSync(join(process.env.CODEX_HOME, 'config.toml'), 'utf8'), /model = "fixture-model"/);
console.log(${JSON.stringify(JSON.stringify(catalogFixture))});
`, { mode: 0o700 });
  const home = prepareServiceCodexHome({ env: { HOME: fixture, CODEX_AUTH_PATH: authPath },
    workspaceDir: fixture, model: 'fixture-model', codexCli: binary,
    log: { info: line => logs.push(line), warn: () => assert.fail('catalog pin should succeed') } });
  try {
    assert.equal(home.catalogPath, join(home.codexHome, 'model-catalog.direct-tools.json'));
    assert.equal(statSync(home.catalogPath).mode & 0o777, 0o600);
    const pinned = JSON.parse(readFileSync(home.catalogPath, 'utf8'));
    const expected = structuredClone(catalogFixture);
    for (const model of expected.models) {
      delete model.tool_mode;
      delete model.supports_search_tool;
    }
    assert.deepEqual(pinned, expected);
    const config = readFileSync(join(home.codexHome, 'config.toml'), 'utf8');
    assert.ok(config.startsWith(`model_catalog_json = ${JSON.stringify(home.catalogPath)}\n`));
    assert.equal(home.configDigest, createHash('sha256').update(config).digest('hex'));
    assert.equal(statSync(join(home.codexHome, 'config.toml')).mode & 0o777, 0o600);
    assert.equal(logs.length, 1);
    assert.ok(logs[0].includes(`model_catalog_json=${home.catalogPath}`));
    assert.equal(existsSync(join(home.codexHome, 'auth.json')), false);
  } finally { home.cleanup(); rmSync(fixture, { recursive: true, force: true }); }
});

for (const failure of ['fetch', 'parse', 'empty', 'entry', 'missing-model', 'write-catalog', 'pin-config']) {
  test(`catalog ${failure} failure leaves a usable unpinned service home`, () => {
    const warnings = [];
    const logs = [];
    const home = prepareServiceCodexHome({ env: { HOME: '/fixture/home' },
      workspaceDir: '/fixture/job', model: 'fixture-model', codexCli: '/fixture/codex',
      execFileSyncImpl(command, args, options) {
        assert.equal(command, '/fixture/codex');
        assert.deepEqual(args, ['debug', 'models']);
        assert.equal(options.timeout, 30_000);
        assert.deepEqual(options.stdio, ['ignore', 'pipe', 'ignore']);
        if (failure === 'fetch') throw Object.assign(new Error('synthetic private output'), { code: 'ETIMEDOUT' });
        if (failure === 'parse') return '{invalid';
        if (failure === 'empty') return '{"models":[]}';
        if (failure === 'entry') return '{"models":[null]}';
        if (failure === 'missing-model') return '{"models":[{"slug":"other-model"}]}';
        mkdirSync(join(options.env.CODEX_HOME,
          failure === 'write-catalog' ? 'model-catalog.direct-tools.json' : 'config.toml.tmp'));
        return JSON.stringify(catalogFixture);
      }, log: { info: line => logs.push(line), warn: line => warnings.push(line) } });
    try {
      assert.equal(home.catalogPath, null);
      const config = readFileSync(join(home.codexHome, 'config.toml'), 'utf8');
      assert.doesNotMatch(config, /model_catalog_json/);
      assert.match(config, /model = "fixture-model"/);
      assert.equal(home.configDigest, createHash('sha256').update(config).digest('hex'));
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /not pinned; using server catalog/);
      assert.doesNotMatch(warnings[0], /synthetic private output/);
      assert.equal(logs.length, 1);
      assert.match(logs[0], /model_catalog_json=server/);
    } finally { home.cleanup(); }
  });
}

test('every Codex reviewer probe is isolated, including OAuth fallback and MCP list', async () => {
  const homes = [];
  const commands = [];
  let ready = false;
  await probeCodexCli({ env: { CODEX_CLI: '/fixture/codex', HOME: '/fixture/home',
    CODEX_HOME: '/fixture/interactive', CODEX_AUTH_PATH: '/fixture/worker/auth.json' },
    cwd: '/fixture/workspace', requireMcpOAuth: true,
    ensureWorkerRegistryReadyImpl: async () => { ready = true; },
    execFileSyncImpl: (command, args, { env }) => {
      assert.equal(ready, true);
      assert.equal(command, '/fixture/codex');
      assert.deepEqual(args, ['debug', 'models']);
      assert.equal(env.CODEX_AUTH_PATH, '/fixture/worker/auth.json');
      const model = JSON.parse(readFileSync(join(env.CODEX_HOME, 'config.toml'), 'utf8').match(/^model = (.+)$/m)[1]);
      return JSON.stringify({ models: [{ slug: model, tool_mode: 'code_mode_only', supports_search_tool: true }] });
    },
    execFileImpl: async (_cmd, args, options) => {
      assert.equal(ready, true);
      commands.push(args.join(' '));
      homes.push(options.env.CODEX_HOME);
      assert.notEqual(options.env.CODEX_HOME, '/fixture/interactive');
      assert.equal(options.env.CODEX_AUTH_PATH, '/fixture/worker/auth.json');
      assert.ok(existsSync(join(options.env.CODEX_HOME, 'config.toml')));
      assert.ok(existsSync(join(options.env.CODEX_HOME, 'model-catalog.direct-tools.json')));
      if (args[0] === 'sessions') throw Object.assign(new Error('unknown subcommand'), { stderr: "unrecognized subcommand 'sessions'" });
      return { stdout: args[0] === 'mcp' ? 'No MCP servers configured.' : 'fixture', stderr: '' };
    } });
  assert.deepEqual(commands, ['--version', 'sessions list', 'login status', 'mcp list']);
  assert.ok(homes.every((home) => !existsSync(home)));
});

for (const fetchFails of [false, true]) {
  test(`Codex reviewer spawns with the isolated catalog override (fetchFails=${fetchFails})`, async () => {
    const { __test__: { spawnCodexReview } } = await import('../src/reviewer-harness.mjs');
    let home;
    await spawnCodexReview({ codexCli: '/fixture/codex', model: 'fixture-model',
      prompt: 'synthetic review', outputPath: '/fixture/output.md',
      cwd: '/fixture/job', env: { HOME: '/fixture/home', CODEX_AUTH_PATH: '/fixture/auth.json' },
      execFileSyncImpl: (_cmd, _args, { env }) => {
        assert.equal(env.CODEX_AUTH_PATH, '/fixture/auth.json');
        if (fetchFails) throw new Error('synthetic fetch failure');
        return JSON.stringify(catalogFixture);
      },
      spawnCapturedImpl: async (command, args, { env }) => {
        assert.equal(command, '/fixture/codex');
        home = env.CODEX_HOME;
        assert.ok(args.includes('--ignore-user-config'));
        const pin = args.find(arg => arg.startsWith('model_catalog_json='));
        if (fetchFails) assert.equal(pin, undefined);
        else assert.equal(pin, `model_catalog_json=${JSON.stringify(join(home, 'model-catalog.direct-tools.json'))}`);
        assert.equal(existsSync(join(home, 'model-catalog.direct-tools.json')), !fetchFails);
        return { stdout: '', stderr: '' };
      } });
    assert.ok(home);
    assert.equal(existsSync(home), false);
  });
}

test('Codex probes preserve registry readiness failures before spawning', async () => {
  const failure = new Error('fixture registry failure');
  await assert.rejects(probeCodexCli({ env: { CODEX_CLI: '/fixture/codex' },
    ensureWorkerRegistryReadyImpl: async () => { throw failure; },
    execFileImpl: async () => assert.fail('readiness failure must prevent the probe'),
  }), (error) => error === failure);
});

for (const baseHome of [null, '/fixture/operator-codex']) {
  test(`Codex discovery preserves default OAuth lookup with CODEX_HOME=${baseHome}`, async () => {
    const sourceEnv = { CODEX_CLI: '/fixture/codex', HOME: '/fixture/user',
      ...(baseHome ? { CODEX_HOME: baseHome } : {}) };
    const calls = [];
    await probeCodexCli({ env: sourceEnv, cwd: '/fixture/job', requireMcpOAuth: true,
      ensureWorkerRegistryReadyImpl: async () => {},
      execFileImpl: async (_command, args, { env }) => {
        calls.push(args.join(' '));
        assert.equal(env.CODEX_AUTH_PATH, join(baseHome || '/fixture/user/.codex', 'auth.json'));
        assert.notEqual(env.CODEX_HOME, baseHome);
        assert.equal(existsSync(join(env.CODEX_HOME, 'auth.json')), false);
        if (args[0] === 'sessions') throw new Error("unrecognized subcommand 'sessions'");
        return { stdout: 'fixture', stderr: '' };
      } });
    assert.deepEqual(calls, ['--version', 'sessions list', 'login status', 'mcp list']);
    assert.equal(sourceEnv.CODEX_AUTH_PATH, undefined);
  });
}

test('reviewWithCodex cleans its service home when preparation progress throws', async () => {
  const { __test__: { reviewWithCodex } } = await import('../src/reviewer-harness.mjs');
  const previous = process.env.AGENT_OS_CODEX_PER_WORKER_AUTH;
  process.env.AGENT_OS_CODEX_PER_WORKER_AUTH = '0';
  let home;
  const failure = new Error('fixture progress callback failed');
  try {
    await assert.rejects(reviewWithCodex('+fixture', '', {
      codexCli: process.execPath, assertCodexOAuthImpl: async () => {},
      ensureWorkerRegistryReadyImpl: async () => {},
      log: { info(line) { home = line.match(/CODEX_HOME=(.*?) config_sha256=/)?.[1]; }, warn() {} },
      onProgress() { assert.ok(existsSync(home)); throw failure; },
      spawnCodexReviewImpl: async () => assert.fail('preparation error must prevent spawn'),
    }), error => error === failure);
    assert.ok(home);
    assert.equal(existsSync(home), false);
  } finally {
    if (previous === undefined) delete process.env.AGENT_OS_CODEX_PER_WORKER_AUTH;
    else process.env.AGENT_OS_CODEX_PER_WORKER_AUTH = previous;
  }
});

test('reviewWithCodex fetches after auth staging and reuses the pinned home', async () => {
  const { __test__: { reviewWithCodex } } = await import('../src/reviewer-harness.mjs');
  const keys = ['AGENT_OS_CODEX_PER_WORKER_AUTH', 'CODEX_AUTH_PATH', 'OPENAI_API_KEY'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.AGENT_OS_CODEX_PER_WORKER_AUTH = '0';
  process.env.CODEX_AUTH_PATH = '/fixture/staged-worker/auth.json';
  process.env.OPENAI_API_KEY = 'synthetic-key-that-must-be-scrubbed';
  let fetchedHome;
  let fetched = false;
  try {
    const result = await reviewWithCodex('+fixture', '', {
      codexCli: process.execPath, assertCodexOAuthImpl: async () => {},
      ensureWorkerRegistryReadyImpl: async () => {},
      log: { info() {}, warn() {} },
      execFileSyncImpl(command, args, { env }) {
        assert.equal(command, process.execPath);
        assert.deepEqual(args, ['debug', 'models']);
        assert.equal(env.CODEX_AUTH_PATH, '/fixture/staged-worker/auth.json');
        assert.equal(env.OPENAI_API_KEY, undefined);
        fetchedHome = env.CODEX_HOME;
        fetched = true;
        const model = JSON.parse(readFileSync(join(fetchedHome, 'config.toml'), 'utf8').match(/^model = (.+)$/m)[1]);
        return JSON.stringify({ models: [{ slug: model, tool_mode: 'code_mode_only', supports_search_tool: true }] });
      },
      spawnCodexReviewImpl: async ({ serviceHome, env }) => {
        assert.equal(fetched, true);
        assert.equal(env.CODEX_HOME, fetchedHome);
        assert.equal(env.CODEX_AUTH_PATH, '/fixture/staged-worker/auth.json');
        assert.equal(serviceHome.catalogPath, join(fetchedHome, 'model-catalog.direct-tools.json'));
        assert.ok(existsSync(serviceHome.catalogPath));
        return { stdout: 'Synthetic review completed.', stderr: '' };
      },
    });
    assert.equal(result.reviewText, 'Synthetic review completed.');
    assert.equal(existsSync(fetchedHome), false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

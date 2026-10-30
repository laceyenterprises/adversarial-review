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
    workspaceDir: '/fixture/job', model: 'fixture-model', effort: 'high', log: { info: (line) => logs.push(line) } });
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

test('every Codex reviewer probe is isolated, including OAuth fallback and MCP list', async () => {
  const homes = [];
  const commands = [];
  let ready = false;
  await probeCodexCli({ env: { CODEX_CLI: '/fixture/codex', HOME: '/fixture/home',
    CODEX_HOME: '/fixture/interactive', CODEX_AUTH_PATH: '/fixture/worker/auth.json' },
    cwd: '/fixture/workspace', requireMcpOAuth: true,
    ensureWorkerRegistryReadyImpl: async () => { ready = true; },
    execFileImpl: async (_cmd, args, options) => {
      assert.equal(ready, true);
      commands.push(args.join(' '));
      homes.push(options.env.CODEX_HOME);
      assert.notEqual(options.env.CODEX_HOME, '/fixture/interactive');
      assert.equal(options.env.CODEX_AUTH_PATH, '/fixture/worker/auth.json');
      assert.ok(existsSync(join(options.env.CODEX_HOME, 'config.toml')));
      if (args[0] === 'sessions') throw Object.assign(new Error('unknown subcommand'), { stderr: "unrecognized subcommand 'sessions'" });
      return { stdout: args[0] === 'mcp' ? 'No MCP servers configured.' : 'fixture', stderr: '' };
    } });
  assert.deepEqual(commands, ['--version', 'sessions list', 'login status', 'mcp list']);
  assert.ok(homes.every((home) => !existsSync(home)));
});

test('Codex probes preserve registry readiness failures before spawning', async () => {
  const failure = new Error('fixture registry failure');
  await assert.rejects(probeCodexCli({ env: { CODEX_CLI: '/fixture/codex' },
    ensureWorkerRegistryReadyImpl: async () => { throw failure; },
    execFileImpl: async () => assert.fail('readiness failure must prevent the probe'),
  }), (error) => error === failure);
});

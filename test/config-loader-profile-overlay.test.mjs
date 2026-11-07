// PROFILENODE-01: the Node loader reads an optional profile overlay
// (config.profile.reference-host.yaml) between config.yaml and
// config.local.yaml, resolving the profile like the platform loaders.
// Fixtures are synthetic and written to a temp dir; no host state is read.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig,
  loadConfigCached,
  resetConfigCache,
} from '../src/config-loader.mjs';
import { resolveGitHubAppBotLogin } from '../src/github-app-identity.mjs';

const TOP = 'version: 1\nentitlements:\n  fixture-agent:\n    git_name: Fixture Base\n    gh_bot_login: base-bot[bot]\n';
const OVERLAY = 'version: 1\nentitlements:\n  fixture-agent:\n    gh_bot_login: overlay-bot[bot]\n    git_email: overlay@example.invalid\n';

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'profile-overlay-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return { dir, topPath: join(dir, 'config.yaml'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('overlay absent: effective config is unchanged and the profile is core', () => {
  const f = fixture({ 'config.yaml': TOP });
  try {
    const cfg = loadConfig({ topPath: f.topPath, env: {} });
    assert.equal(cfg.profile, 'core');
    assert.equal(cfg.profileSource, 'default');
    assert.equal(cfg.get('entitlements.fixture-agent.gh_bot_login'), 'base-bot[bot]');
    // The resolved profile is exposed as a property, not injected into values.
    assert.equal(Object.hasOwn(cfg.values, 'profile'), false);
  } finally {
    f.cleanup();
  }
});

test('overlay present: its keys are visible and merge deeply over config.yaml', () => {
  const f = fixture({ 'config.yaml': TOP, 'config.profile.reference-host.yaml': OVERLAY });
  try {
    const cfg = loadConfig({ topPath: f.topPath, env: {} });
    assert.equal(cfg.profile, 'reference-host');
    assert.equal(cfg.profileSource, 'overlay-present');
    assert.equal(cfg.get('entitlements.fixture-agent.gh_bot_login'), 'overlay-bot[bot]');
    assert.equal(cfg.get('entitlements.fixture-agent.git_email'), 'overlay@example.invalid');
    // Sibling key from config.yaml survives the deep merge.
    assert.equal(cfg.get('entitlements.fixture-agent.git_name'), 'Fixture Base');
    assert.equal(cfg.sources['entitlements.fixture-agent.gh_bot_login'].startsWith('profile:'), true);
  } finally {
    f.cleanup();
  }
});

test('config.local.yaml still wins over the overlay; env wins over both', () => {
  const f = fixture({
    'config.yaml': TOP,
    'config.profile.reference-host.yaml': OVERLAY,
    'config.local.yaml': 'version: 1\nentitlements:\n  fixture-agent:\n    gh_bot_login: local-bot[bot]\n',
  });
  try {
    const cfg = loadConfig({ topPath: f.topPath, env: {} });
    assert.equal(cfg.get('entitlements.fixture-agent.gh_bot_login'), 'local-bot[bot]');
    assert.equal(cfg.get('entitlements.fixture-agent.git_email'), 'overlay@example.invalid');
    const trace = cfg.resolutionTrace('entitlements.fixture-agent.gh_bot_login').map((e) => e.value);
    assert.deepEqual(trace.slice(-3), ['base-bot[bot]', 'overlay-bot[bot]', 'local-bot[bot]']);

    const withEnv = loadConfig({
      topPath: f.topPath,
      env: { AGENT_OS_ENTITLEMENTS_STUB_WORKER_GH_BOT_LOGIN: 'env-bot[bot]' },
    });
    assert.equal(withEnv.get('entitlements.stub-worker.gh_bot_login'), 'env-bot[bot]');
    assert.equal(withEnv.get('entitlements.fixture-agent.gh_bot_login'), 'local-bot[bot]');
  } finally {
    f.cleanup();
  }
});

test('profile resolution: explicit key, then env, then overlay presence, then core', () => {
  const withOverlay = fixture({ 'config.yaml': TOP, 'config.profile.reference-host.yaml': OVERLAY });
  const noOverlay = fixture({ 'config.yaml': TOP });
  const explicitCore = fixture({
    'config.yaml': `${TOP}profile: core\n`,
    'config.profile.reference-host.yaml': OVERLAY,
  });
  const explicitHostNoFile = fixture({ 'config.yaml': `${TOP}profile: reference-host\n` });
  const explicitBeatsEnv = fixture({
    'config.yaml': `${TOP}profile: reference-host\n`,
    'config.profile.reference-host.yaml': OVERLAY,
  });
  const localExplicit = fixture({
    'config.yaml': `${TOP}profile: reference-host\n`,
    'config.local.yaml': 'version: 1\nprofile: core\n',
    'config.profile.reference-host.yaml': OVERLAY,
  });
  try {
    // 4. otherwise core
    assert.equal(loadConfig({ topPath: noOverlay.topPath, env: {} }).profile, 'core');
    // 3. overlay file present
    assert.equal(loadConfig({ topPath: withOverlay.topPath, env: {} }).profile, 'reference-host');
    // 2. env beats overlay presence
    const envCore = loadConfig({ topPath: withOverlay.topPath, env: { AGENT_OS_PROFILE: 'core' } });
    assert.equal(envCore.profile, 'core');
    assert.equal(envCore.profileSource, 'env');
    assert.equal(envCore.get('entitlements.fixture-agent.gh_bot_login'), 'base-bot[bot]');
    // env can name the overlay profile; with no file it is a no-op overlay
    const envHost = loadConfig({ topPath: noOverlay.topPath, env: { AGENT_OS_PROFILE: 'reference-host' } });
    assert.equal(envHost.profile, 'reference-host');
    assert.equal(envHost.get('entitlements.fixture-agent.gh_bot_login'), 'base-bot[bot]');
    // blank env is treated as unset
    assert.equal(loadConfig({ topPath: withOverlay.topPath, env: { AGENT_OS_PROFILE: '  ' } }).profile, 'reference-host');
    // 1. explicit key beats env and overlay presence
    const explicit = loadConfig({ topPath: explicitCore.topPath, env: {} });
    assert.equal(explicit.profile, 'core');
    assert.equal(explicit.profileSource, 'explicit');
    assert.equal(explicit.get('entitlements.fixture-agent.gh_bot_login'), 'base-bot[bot]');
    assert.equal(
      loadConfig({ topPath: explicitBeatsEnv.topPath, env: { AGENT_OS_PROFILE: 'core' } }).get(
        'entitlements.fixture-agent.gh_bot_login',
      ),
      'overlay-bot[bot]',
    );
    // explicit reference-host with the overlay file absent is a no-op
    const hostNoFile = loadConfig({ topPath: explicitHostNoFile.topPath, env: {} });
    assert.equal(hostNoFile.profile, 'reference-host');
    assert.equal(hostNoFile.get('entitlements.fixture-agent.gh_bot_login'), 'base-bot[bot]');
    // the local layer's explicit key wins over the checked-in one
    assert.equal(loadConfig({ topPath: localExplicit.topPath, env: {} }).profile, 'core');
  } finally {
    for (const f of [withOverlay, noOverlay, explicitCore, explicitHostNoFile, explicitBeatsEnv, localExplicit]) f.cleanup();
  }
});

test('an unknown profile name never loads an overlay file', () => {
  const f = fixture({
    'config.yaml': TOP,
    'config.profile.reference-host.yaml': OVERLAY,
    'config.profile.other.yaml': 'version: 1\nentitlements:\n  fixture-agent:\n    gh_bot_login: other-bot[bot]\n',
  });
  try {
    const cfg = loadConfig({ topPath: f.topPath, env: { AGENT_OS_PROFILE: 'other' } });
    assert.equal(cfg.profile, 'other');
    assert.equal(cfg.get('entitlements.fixture-agent.gh_bot_login'), 'base-bot[bot]');
  } finally {
    f.cleanup();
  }
});

test('a non-string explicit profile is rejected by the schema', () => {
  const f = fixture({ 'config.yaml': `${TOP}profile: 7\n` });
  try {
    assert.throws(() => loadConfig({ topPath: f.topPath, env: {} }), /profile/);
  } finally {
    f.cleanup();
  }
});

test('the cached loader tracks overlay edits and AGENT_OS_PROFILE', () => {
  const f = fixture({ 'config.yaml': TOP });
  try {
    resetConfigCache();
    const key = 'entitlements.fixture-agent.gh_bot_login';
    const args = { topPath: f.topPath, modulePaths: [], env: {} };
    assert.equal(loadConfigCached(args).get(key), 'base-bot[bot]');
    writeFileSync(join(f.dir, 'config.profile.reference-host.yaml'), OVERLAY);
    assert.equal(loadConfigCached(args).get(key), 'overlay-bot[bot]');
    writeFileSync(
      join(f.dir, 'config.profile.reference-host.yaml'),
      OVERLAY.replace('overlay-bot', 'overlay-bot-2'),
    );
    assert.equal(loadConfigCached(args).get(key), 'overlay-bot-2[bot]');
    assert.equal(
      loadConfigCached({ ...args, env: { AGENT_OS_PROFILE: 'core' } }).get(key),
      'base-bot[bot]',
    );
  } finally {
    resetConfigCache();
    f.cleanup();
  }
});

test('the entitlement bot-login reader resolves through the overlay', () => {
  const f = fixture({ 'config.yaml': TOP, 'config.profile.reference-host.yaml': OVERLAY });
  try {
    resetConfigCache();
    const login = resolveGitHubAppBotLogin({
      identity: 'fixture-agent',
      env: {},
      topPath: f.topPath,
      modulePaths: [],
      log: { warn() {} },
    });
    assert.equal(login, 'overlay-bot[bot]');

    // Same reader, overlay deselected: falls back to the base layer.
    const base = resolveGitHubAppBotLogin({
      identity: 'fixture-agent',
      env: { AGENT_OS_PROFILE: 'core' },
      topPath: f.topPath,
      modulePaths: [],
      log: { warn() {} },
    });
    assert.equal(base, 'base-bot[bot]');
  } finally {
    resetConfigCache();
    f.cleanup();
  }
});

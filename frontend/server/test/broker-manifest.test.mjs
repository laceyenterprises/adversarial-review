/**
 * The broker config section and its role -> identity manifest (ARF-07 req 1, 4).
 *
 * Every case here is a mapping problem caught at **load** time. A `github_app`
 * role missing its `installationId`, or a `privateKeyReff` typo, is a broken
 * mapping either way — the only question is whether ARF says so at boot or four
 * steps into a standup wizard, after the App has already been created and
 * installed on the repo.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { BrokerConfigError, SecretRefError, UnmappedRoleError } from '../src/broker/errors.mjs';
import { openTokenBroker } from '../src/broker/index.mjs';
import { normalizeBrokerConfig } from '../src/broker/manifest.mjs';
import { loadConfig } from '../src/config.mjs';

const tempDirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'arf-broker-cfg-'));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const APP_ROLE = {
  provider: 'github_app',
  appId: '4197249',
  installationId: '143886388',
  privateKeyRef: 'op://Cliovault/the-hammer.private-key/private key',
  patFallbackRef: 'op://Cliovault/Hammer GH PAT/credential',
};

describe('broker config defaults', () => {
  it('defaults to bundled mode with an empty, unconfigured manifest', () => {
    const config = normalizeBrokerConfig({});
    assert.equal(config.mode, 'bundled');
    assert.equal(config.configured, false);
    assert.equal(config.roles.size, 0);
    assert.equal(config.githubApiUrl, 'https://api.github.com');
    assert.equal(config.refreshLeadSeconds, 60);
    assert.equal(config.requestTimeoutMs, 10000);
  });

  it('normalizes a github_app role from the in-OS descriptor shape', () => {
    const config = normalizeBrokerConfig({ file: { roles: { 'the-hammer': APP_ROLE } } });
    const entry = config.roles.get('the-hammer');
    assert.equal(entry.provider, 'github_app');
    assert.equal(entry.appId, '4197249');
    assert.equal(entry.installationId, '143886388');
    assert.equal(entry.privateKeyRef, APP_ROLE.privateKeyRef);
    assert.equal(entry.patFallbackRef, APP_ROLE.patFallbackRef);
    assert.equal(entry.source, 'config');
    assert.equal(config.configured, true);
  });

  it('accepts numeric app and installation ids without losing precision', () => {
    // A GitHub installation id is larger than a display would suggest and JSON
    // will happily hand it over as a number; the manifest stores it as a string
    // so the URL it lands in is byte-identical to what was configured.
    const config = normalizeBrokerConfig({
      file: { roles: { hammer: { ...APP_ROLE, appId: 4197249, installationId: 143886388 } } },
    });
    assert.equal(config.roles.get('hammer').installationId, '143886388');
  });
});

describe('broker config refuses a broken mapping at load', () => {
  const cases = [
    ['unknown broker key', { modeX: 'bundled' }, /unknown key "modeX"/],
    ['unknown mode', { mode: 'sidecar' }, /must be one of bundled \| external/],
    ['external without an endpoint', { mode: 'external' }, /requires broker\.endpoint/],
    ['a non-URL endpoint', { mode: 'external', endpoint: 'broker.local' }, /must be an absolute URL/],
    ['a non-http endpoint', { mode: 'external', endpoint: 'ftp://b.test' }, /must be http\(s\)/],
    ['a non-object roles map', { roles: [] }, /must be a JSON object/],
    ['a non-object role entry', { roles: { hammer: 'op://V/i/f' } }, /must be a JSON object/],
    ['an unknown role key', { roles: { hammer: { ...APP_ROLE, privateKeyReff: 'x' } } }, /unknown key "privateKeyReff"/],
    ['a github_app role with no appId', { roles: { hammer: { ...APP_ROLE, appId: undefined } } }, /appId must be a non-empty string/],
    ['a github_app role with no installationId', { roles: { hammer: { ...APP_ROLE, installationId: '' } } }, /installationId must be a non-empty string/],
    ['an unknown provider', { roles: { hammer: { provider: 'keychain' } } }, /is not one of/],
    ['a negative timeout', { requestTimeoutMs: -1 }, /must be a positive number/],
  ];

  for (const [name, section, pattern] of cases) {
    it(`refuses ${name}`, () => {
      assert.throws(() => normalizeBrokerConfig({ file: section }), (err) => {
        assert.ok(err instanceof BrokerConfigError, `${name}: expected BrokerConfigError, got ${err.name}`);
        assert.match(err.message, pattern);
        return true;
      });
    });
  }

  it('refuses a raw secret in place of a reference', () => {
    assert.throws(
      () => normalizeBrokerConfig({
        file: { roles: { hammer: { ...APP_ROLE, privateKeyRef: '-----BEGIN PRIVATE KEY-----' } } },
      }),
      (err) => {
        assert.ok(err instanceof SecretRefError);
        assert.match(err.message, /ARF consumes secret references only/);
        return true;
      },
    );
  });

  it('refuses a github_pat role with no tokenRef', () => {
    assert.throws(
      () => normalizeBrokerConfig({ file: { roles: { argus: { provider: 'github_pat' } } } }),
      /tokenRef.*must be a non-empty string/,
    );
  });
});

describe('broker roles file', () => {
  it('loads a manifest from rolesFile and lets inline entries override it', () => {
    const dir = tempDir();
    const path = join(dir, 'roles.json');
    writeFileSync(path, JSON.stringify({
      roles: {
        'the-hammer': APP_ROLE,
        'claude-reviewer': { ...APP_ROLE, appId: '881', installationId: '4100' },
      },
    }));

    const config = normalizeBrokerConfig({
      file: {
        rolesFile: path,
        roles: { 'claude-reviewer': { ...APP_ROLE, appId: '999', installationId: '4100' } },
      },
    });
    assert.equal(config.roles.get('the-hammer').source, 'rolesFile');
    assert.equal(config.roles.get('claude-reviewer').source, 'config');
    assert.equal(config.roles.get('claude-reviewer').appId, '999');
  });

  it('accepts a bare role map as well as a {roles} wrapper', () => {
    const dir = tempDir();
    const path = join(dir, 'roles.json');
    writeFileSync(path, JSON.stringify({ 'the-hammer': APP_ROLE }));
    const config = normalizeBrokerConfig({ file: { rolesFile: path } });
    assert.ok(config.roles.has('the-hammer'));
  });

  it('fails loud on an unreadable or malformed rolesFile', () => {
    const dir = tempDir();
    // A file that exists but cannot be read is a real misconfiguration: the
    // operator's mappings are there and ARF cannot see them, so continuing with
    // zero roles would answer the wrong question. A directory at the path is the
    // portable way to produce that (EISDIR) without depending on running as a
    // user for whom chmod 000 actually denies access.
    mkdirSync(join(dir, 'roles-as-a-directory.json'));
    assert.throws(
      () => normalizeBrokerConfig({ file: { rolesFile: join(dir, 'roles-as-a-directory.json') } }),
      /is unreadable/,
    );
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    assert.throws(() => normalizeBrokerConfig({ file: { rolesFile: bad } }), /not valid JSON/);
  });

  it('treats an absent rolesFile as an empty manifest, not a boot failure', () => {
    // `rolesFile` names the file ARF keeps mappings in, and on a fresh install it
    // does not exist until the first identity is stood up (ARF-05). Refusing to
    // boot without it would make the standup wizard depend on an operator
    // hand-creating `{"roles": {}}` first.
    const dir = tempDir();
    const path = join(dir, 'not-created-yet.json');
    const config = normalizeBrokerConfig({ file: { rolesFile: path } });

    assert.equal(config.rolesFile, path);
    assert.equal(config.rolesFileExists, false);
    assert.equal(config.roles.size, 0);
    // Nothing is weakened: zero roles is a broker every resolveToken fails loud
    // against, so a path typo still surfaces — at first use, naming the path.
    assert.equal(config.configured, false);
  });

  it('resolves a relative rolesFile against baseDir, not the process cwd', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'roles.json'), JSON.stringify({ 'the-hammer': APP_ROLE }));
    const config = normalizeBrokerConfig({ file: { rolesFile: 'roles.json' }, baseDir: dir });
    assert.equal(config.rolesFile, join(dir, 'roles.json'));
    assert.ok(config.roles.has('the-hammer'));
  });

  it('expands a leading ~/ in rolesFile instead of anchoring it under baseDir', () => {
    // Nothing between an operator's JSON config and here runs a shell, so a
    // `~/` arrives literal. Left unexpanded it would name a directory called
    // `~` under baseDir and fail only on the daemon, where baseDir is not the
    // operator's home.
    const dir = tempDir();
    const config = normalizeBrokerConfig({
      file: { rolesFile: '~/.arf/arf-roles-absent-fixture.json' },
      baseDir: dir,
    });
    // Asserted on the resolved path directly rather than by reading it out of an
    // error message: an absent manifest is a legitimate state now, so the path is
    // the thing to check and it is reported plainly.
    assert.equal(config.rolesFile, join(homedir(), '.arf', 'arf-roles-absent-fixture.json'));
    assert.ok(!config.rolesFile.startsWith(dir), 'the path is not anchored under baseDir');
  });

  it('refuses a relative rolesFile when there is no persistent base to anchor it to', () => {
    // The daemon shape: nothing may fall back to `process.cwd()`, which is `/`
    // under launchd and whatever the operator's shell happened to be otherwise.
    assert.throws(
      () => normalizeBrokerConfig({ file: { rolesFile: 'roles.json' } }),
      /is relative and there is no config directory/,
    );
  });
});

describe('broker config through loadConfig', () => {
  function configFileAt(dir, body) {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify(body));
    return path;
  }

  it('is always present, even with no broker section', () => {
    const config = loadConfig({ env: { ARF_STATE_ROOT: tempDir() }, cwd: tempDir() });
    assert.equal(config.broker.mode, 'bundled');
    assert.equal(config.broker.configured, false);
  });

  it('reads the broker section from the config file', () => {
    const dir = tempDir();
    const path = configFileAt(dir, { broker: { roles: { 'the-hammer': APP_ROLE } } });
    const config = loadConfig({ env: { ARF_CONFIG_FILE: path }, cwd: dir });
    assert.equal(config.broker.roles.get('the-hammer').appId, '4197249');
  });

  it('lets ARF_BROKER_* env override the file layer', () => {
    const dir = tempDir();
    const path = configFileAt(dir, {
      broker: { mode: 'bundled', roles: { 'the-hammer': { ...APP_ROLE, scope: 'hammer/merge' } } },
    });
    const config = loadConfig({
      env: {
        ARF_CONFIG_FILE: path,
        ARF_BROKER_MODE: 'external',
        ARF_BROKER_ENDPOINT: 'https://broker.arf.test/',
        ARF_BROKER_REFRESH_LEAD_SECONDS: '120',
      },
      cwd: dir,
    });
    assert.equal(config.broker.mode, 'external');
    assert.equal(config.broker.endpoint, 'https://broker.arf.test');
    assert.equal(config.broker.refreshLeadSeconds, 120);
  });

  it('resolves a relative ARF_BROKER_ROLES_FILE against the state root, not the cwd', () => {
    // ARF runs as a LaunchAgent with cwd=`/`. Anchoring to cwd would look right
    // in a shell run from `~/.arf` and crash the daemon on the same config.
    const stateRoot = tempDir();
    writeFileSync(join(stateRoot, 'roles.json'), JSON.stringify({ 'the-hammer': APP_ROLE }));
    const config = loadConfig({
      env: { ARF_STATE_ROOT: stateRoot, ARF_BROKER_ROLES_FILE: 'roles.json' },
      cwd: tempDir(),
    });
    assert.equal(config.broker.rolesFile, join(stateRoot, 'roles.json'));
    assert.ok(config.broker.roles.has('the-hammer'));
  });

  it('resolves a relative rolesFile against the directory the config file lives in', () => {
    // The config file is the thing the relative path was written next to, so it
    // wins over the state root when the two differ (ARF_CONFIG_FILE elsewhere).
    const confDir = tempDir();
    writeFileSync(join(confDir, 'roles.json'), JSON.stringify({ 'the-hammer': APP_ROLE }));
    const path = configFileAt(confDir, { broker: { rolesFile: 'roles.json' } });
    const config = loadConfig({
      env: { ARF_CONFIG_FILE: path, ARF_STATE_ROOT: tempDir() },
      cwd: tempDir(),
    });
    assert.equal(config.broker.rolesFile, join(confDir, 'roles.json'));
    assert.ok(config.broker.roles.has('the-hammer'));
  });

  it('builds the wizard-facing broker straight from a loaded config', async () => {
    // The one-call seam ARF-05/06 use. Unconfigured by default, and therefore
    // fail-loud by default: a wizard cannot accidentally get a credential from
    // an ARF nobody has given a mapping to.
    const config = loadConfig({ env: { ARF_STATE_ROOT: tempDir() }, cwd: tempDir() });
    const broker = openTokenBroker(config);
    assert.equal(broker.mode, 'bundled');
    assert.equal(broker.hasRole('the-hammer'), false);
    await assert.rejects(() => broker.resolveToken('the-hammer'), UnmappedRoleError);
  });

  it('refuses to boot on a broken broker section', () => {
    // A boot that succeeds with a broken mapping is a standup that fails
    // halfway through, with a GitHub App already created and installed.
    const dir = tempDir();
    const path = configFileAt(dir, {
      broker: { roles: { 'the-hammer': { provider: 'github_app', appId: '1' } } },
    });
    assert.throws(
      () => loadConfig({ env: { ARF_CONFIG_FILE: path }, cwd: dir }),
      BrokerConfigError,
    );
  });
});

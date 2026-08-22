/**
 * The `standup` config section (ARF-06).
 *
 * The interesting cases are the ones that decide what the daemon may execute
 * and where it anchors a relative path — the two places a config mistake shows
 * up only under launchd.
 */

import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { loadConfig } from '../src/config.mjs';
import {
  DEFAULT_RUNTIME_COMMAND_ALLOWLIST, StandupConfigError, normalizeStandupConfig,
} from '../src/standup/config.mjs';
import { tmpStateRoot, withConfigFile } from './helpers/standup-fixtures.mjs';

describe('standup config', () => {
  it('defaults both state files under the state root', () => {
    const stateRoot = tmpStateRoot();
    const config = loadConfig({ env: { ARF_STATE_ROOT: stateRoot } });
    assert.equal(config.standup.harnessManifestPath, join(stateRoot, 'harnesses.json'));
    assert.equal(config.standup.reviewerAllowlistPath, join(stateRoot, 'reviewer-allowlist.json'));
    assert.equal(config.standup.allowRuntimeInstall, false);
    assert.deepEqual(config.standup.runtimeCommandAllowlist, [...DEFAULT_RUNTIME_COMMAND_ALLOWLIST]);
  });

  it('anchors a relative path to the state root, never the process cwd', () => {
    // ARF ships as a LaunchAgent with cwd=/, so anchoring to cwd would turn
    // "harnesses.json" into "/harnesses.json" under the daemon and work fine in
    // a shell — the divergence that only appears in production.
    const stateRoot = tmpStateRoot();
    const config = loadConfig({
      env: withConfigFile(stateRoot, { standup: { harnessManifestPath: 'state/harnesses.json' } }),
      cwd: '/tmp/somewhere-else',
    });
    assert.equal(config.standup.harnessManifestPath, join(stateRoot, 'state', 'harnesses.json'));
  });

  it('expands a leading ~ like every other ARF path key', () => {
    const resolved = normalizeStandupConfig({
      file: { reviewerAllowlistPath: '~/allowlist.json' },
      stateRoot: '/var/arf',
    });
    assert.equal(resolved.reviewerAllowlistPath, join(homedir(), 'allowlist.json'));
  });

  it('extends the runtime allowlist rather than replacing it', () => {
    // Adding one runtime must not silently un-allow the rest.
    const resolved = normalizeStandupConfig({
      file: { runtimeCommandAllowlist: ['agy-nightly'] },
      stateRoot: '/var/arf',
    });
    assert.ok(resolved.runtimeCommandAllowlist.includes('agy-nightly'));
    for (const command of DEFAULT_RUNTIME_COMMAND_ALLOWLIST) {
      assert.ok(resolved.runtimeCommandAllowlist.includes(command));
    }
  });

  it('refuses an unknown key rather than ignoring it', () => {
    assert.throws(
      () => normalizeStandupConfig({ file: { allowRuntimeInstal: true }, stateRoot: '/var/arf' }),
      (err) => {
        assert.ok(err instanceof StandupConfigError);
        assert.match(err.message, /unknown key "allowRuntimeInstal"/);
        return true;
      },
    );
  });

  it('reads the install gate from the environment as a boolean', () => {
    const stateRoot = tmpStateRoot();
    const config = loadConfig({
      env: { ARF_STATE_ROOT: stateRoot, ARF_STANDUP_ALLOW_RUNTIME_INSTALL: 'true' },
    });
    assert.equal(config.standup.allowRuntimeInstall, true);
    assert.throws(
      () => loadConfig({
        env: { ARF_STATE_ROOT: stateRoot, ARF_STANDUP_ALLOW_RUNTIME_INSTALL: 'sometimes' },
      }),
      /must be a boolean/,
    );
  });

  it('refuses a non-numeric probe timeout', () => {
    assert.throws(
      () => normalizeStandupConfig({ file: { runtimeProbeTimeoutMs: -1 }, stateRoot: '/var/arf' }),
      /must be a positive number/,
    );
  });
});

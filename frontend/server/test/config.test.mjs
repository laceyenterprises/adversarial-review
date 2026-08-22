import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ArfConfigError,
  MODE_IN_OS,
  MODE_STANDALONE,
  PIPELINE_REVIEWS_DB_RELPATH,
  STANDALONE_STORE_FILENAME,
  loadConfig,
} from '../src/config.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const tmpRoots = [];
function tmpRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'arf-config-'));
  tmpRoots.push(dir);
  return dir;
}

// Every case pins ARF_STATE_ROOT so a developer's real ~/.arf/config.json can
// never leak into a test result.
function env(extra = {}) {
  return { ARF_STATE_ROOT: tmpRoot(), ...extra };
}

after(() => {
  // mkdtemp dirs under the OS temp root are reaped by the OS; nothing to undo.
});

describe('loadConfig', () => {
  it('expands a leading ~/ in path keys rather than treating it as a directory name', () => {
    // launchd passes plist env vars through without a shell, so `~/` reaches the
    // process literal. Unexpanded it would resolve to a directory called `~`.
    const config = loadConfig({
      env: { ARF_STATE_ROOT: '~/.arf-fixture', ARF_STORE_PATH: '~/.arf-fixture/store.db' },
    });
    assert.equal(config.stateRoot, join(homedir(), '.arf-fixture'));
    assert.equal(config.storePath, join(homedir(), '.arf-fixture', 'store.db'));
  });

  it('defaults to standalone mode with an ARF-owned store path', () => {
    const stateRoot = tmpRoot();
    const config = loadConfig({ env: { ARF_STATE_ROOT: stateRoot } });
    assert.equal(config.mode, MODE_STANDALONE);
    assert.equal(config.storePath, join(stateRoot, STANDALONE_STORE_FILENAME));
    assert.equal(config.storePathSource, 'standalone-default');
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 8787);
  });

  it('derives readOnly from the mode, in both directions', () => {
    assert.equal(loadConfig({ env: env() }).readOnly, false);
    assert.equal(loadConfig({ env: env({ ARF_MODE: MODE_IN_OS }) }).readOnly, true);
  });

  it('has no env knob that can make an in-os store writable', () => {
    // reviews.db is single-writer and watcher-owned; the only way to a writable
    // handle must be choosing standalone mode.
    const config = loadConfig({
      env: env({ ARF_MODE: MODE_IN_OS, ARF_READ_ONLY: 'false', ARF_STORE_READONLY: '0' }),
    });
    assert.equal(config.readOnly, true);
  });

  it('defaults the in-os store path to the pipeline reviews.db', () => {
    const pipelineRoot = tmpRoot();
    const config = loadConfig({ env: env({ ARF_MODE: MODE_IN_OS, ARF_PIPELINE_ROOT: pipelineRoot }) });
    assert.equal(config.storePath, join(pipelineRoot, PIPELINE_REVIEWS_DB_RELPATH));
    assert.equal(config.storePathSource, 'pipeline-default');
  });

  it('defaults pipeline paths to the adversarial-review repo root from the relocated tree', () => {
    const config = loadConfig({ env: env({ ARF_MODE: MODE_IN_OS }) });
    assert.equal(config.pipelineRoot, REPO_ROOT);
    assert.equal(config.storePath, join(REPO_ROOT, 'data', 'reviews.db'));
    assert.deepEqual(config.pipeline.configFiles.map((file) => file.path), [
      join(REPO_ROOT, 'config.yaml'),
      join(REPO_ROOT, 'config.local.yaml'),
    ]);
    assert.equal(config.pipeline.heartbeats.watcher.path, join(REPO_ROOT, 'data', 'watcher-heartbeat.json'));
  });

  it('lets an explicit store path win over both mode defaults', () => {
    const storePath = join(tmpRoot(), 'elsewhere.db');
    for (const mode of [MODE_STANDALONE, MODE_IN_OS]) {
      const config = loadConfig({ env: env({ ARF_MODE: mode, ARF_STORE_PATH: storePath }) });
      assert.equal(config.storePath, storePath);
      assert.equal(config.storePathSource, 'configured');
    }
  });

  it('resolves relative paths against the given cwd', () => {
    const cwd = tmpRoot();
    const config = loadConfig({ env: env({ ARF_STORE_PATH: 'data/review.db' }), cwd });
    assert.equal(config.storePath, join(cwd, 'data', 'review.db'));
  });

  it('reads a JSON config file and lets env override it', () => {
    const stateRoot = tmpRoot();
    const configFile = join(stateRoot, 'arf.json');
    writeFileSync(configFile, JSON.stringify({ mode: MODE_IN_OS, port: 9100, host: '0.0.0.0' }));
    const config = loadConfig({
      env: { ARF_STATE_ROOT: stateRoot, ARF_CONFIG_FILE: configFile, ARF_PORT: '9200' },
    });
    assert.equal(config.mode, MODE_IN_OS);
    assert.equal(config.host, '0.0.0.0');
    assert.equal(config.port, 9200, 'env must win over the file layer');
    assert.equal(config.configFile, configFile);
  });

  it('picks up a config file at the default state-root location', () => {
    const stateRoot = tmpRoot();
    writeFileSync(join(stateRoot, 'config.json'), JSON.stringify({ port: 9300 }));
    const config = loadConfig({ env: { ARF_STATE_ROOT: stateRoot } });
    assert.equal(config.port, 9300);
    assert.equal(config.configFile, join(stateRoot, 'config.json'));
  });

  it('reports no config file when none exists', () => {
    assert.equal(loadConfig({ env: env() }).configFile, null);
  });

  it('fails loud on an unknown config-file key', () => {
    const stateRoot = tmpRoot();
    const configFile = join(stateRoot, 'config.json');
    // A silently-ignored `storePth` typo would point ARF at the default store
    // and the operator would see an empty dashboard with no explanation.
    writeFileSync(configFile, JSON.stringify({ storePth: '/tmp/x.db' }));
    assert.throws(() => loadConfig({ env: { ARF_STATE_ROOT: stateRoot } }), ArfConfigError);
  });

  it('fails loud on a named-but-missing config file', () => {
    assert.throws(
      () => loadConfig({ env: env({ ARF_CONFIG_FILE: join(tmpRoot(), 'absent.json') }) }),
      ArfConfigError,
    );
  });

  it('fails loud on malformed JSON, an unknown mode, and a bad port', () => {
    const stateRoot = tmpRoot();
    const configFile = join(stateRoot, 'config.json');
    writeFileSync(configFile, '{ not json');
    assert.throws(() => loadConfig({ env: { ARF_STATE_ROOT: stateRoot } }), ArfConfigError);

    assert.throws(() => loadConfig({ env: env({ ARF_MODE: 'in_os' }) }), ArfConfigError);
    assert.throws(() => loadConfig({ env: env({ ARF_PORT: 'http' }) }), ArfConfigError);
    assert.throws(() => loadConfig({ env: env({ ARF_PORT: '70000' }) }), ArfConfigError);
    assert.throws(() => loadConfig({ env: env({ ARF_STORE_BUSY_TIMEOUT_MS: '-1' }) }), ArfConfigError);
  });
});

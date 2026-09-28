import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NODE_BIN_ENV, STABLE_NODE_BIN, resolveNodeBin } from '../src/node-interpreter.mjs';
import { createCliDirectReviewerRuntimeAdapter } from '../src/adapters/reviewer-runtime/cli-direct/index.mjs';

// NODEPIN-01 (agent-os SEV1 2026-09-28): a daemon that spawns Node children
// with its own process.execPath pins the versioned Cellar binary it started
// with, and a Homebrew upgrade that moves that binary's dylibs kills every
// child in dyld. Children must go through a stable interpreter instead.

const CELLAR_EXEC_PATH = '/opt/homebrew/Cellar/node/26.3.0/bin/node';
const present = () => true;
const absent = () => false;

test('AGENT_OS_NODE_BIN wins over the stable Homebrew node and execPath', () => {
  assert.equal(
    resolveNodeBin({ env: { [NODE_BIN_ENV]: '/pinned/bin/node' }, execPath: CELLAR_EXEC_PATH, isExecutable: present }),
    '/pinned/bin/node',
  );
});

test('the stable Homebrew node beats the daemon\'s own versioned execPath', () => {
  const probed = [];
  const resolved = resolveNodeBin({
    env: {},
    execPath: CELLAR_EXEC_PATH,
    isExecutable: (path) => {
      probed.push(path);
      return true;
    },
  });
  assert.equal(resolved, STABLE_NODE_BIN);
  assert.equal(STABLE_NODE_BIN, '/opt/homebrew/bin/node');
  assert.deepEqual(probed, [STABLE_NODE_BIN]);
});

test('execPath is the last resort on a host without the Homebrew node', () => {
  assert.equal(
    resolveNodeBin({ env: {}, execPath: '/usr/local/bin/node', isExecutable: absent }),
    '/usr/local/bin/node',
  );
});

test('a blank AGENT_OS_NODE_BIN pin is ignored, and a padded one is trimmed', () => {
  assert.equal(
    resolveNodeBin({ env: { [NODE_BIN_ENV]: '   ' }, execPath: CELLAR_EXEC_PATH, isExecutable: present }),
    STABLE_NODE_BIN,
  );
  assert.equal(
    resolveNodeBin({ env: { [NODE_BIN_ENV]: ' /pinned/node ' }, execPath: CELLAR_EXEC_PATH, isExecutable: absent }),
    '/pinned/node',
  );
});

test('resolution happens at spawn time, not once at import', () => {
  const env = {};
  assert.equal(resolveNodeBin({ env, execPath: CELLAR_EXEC_PATH, isExecutable: absent }), CELLAR_EXEC_PATH);
  env[NODE_BIN_ENV] = '/later/node';
  assert.equal(resolveNodeBin({ env, execPath: CELLAR_EXEC_PATH, isExecutable: absent }), '/later/node');
});

test('the watcher spawns each reviewer through the resolved interpreter', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'nodepin-reviewer-'));
  mkdirSync(join(rootDir, 'domains'), { recursive: true });
  const spawned = [];
  let resolutions = 0;
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      preflightImpl: async () => ({ codexCli: '/tmp/fake-codex' }),
      resolveNodeBinImpl: () => {
        resolutions += 1;
        return '/stable/bin/node';
      },
      spawnCapturedImpl: async (command, args) => {
        spawned.push({ command, args });
        const err = new Error('Command failed with code 1');
        err.exitCode = 1;
        throw err;
      },
      now: () => '2026-09-28T08:00:00.000Z',
    });
    await adapter.spawnReviewer({
      model: 'codex',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 7285 },
      timeoutMs: 100,
      sessionUuid: 'nodepin-reviewer-session',
      forbiddenFallbacks: ['api-key'],
    });
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].command, '/stable/bin/node');
    assert.notEqual(spawned[0].command, process.execPath);
    assert.match(spawned[0].args[0], /reviewer\.mjs$/);
    assert.equal(resolutions, 1, 'the interpreter is resolved per spawn');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('long-lived daemon spawn sites do not reach for process.execPath', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  for (const relPath of [
    'src/adapters/reviewer-runtime/cli-direct/index.mjs',
    'src/alert-delivery.mjs',
    'src/follow-up-workspace-trash.mjs',
    'src/handoff-wake.mjs',
    'src/handoff-telemetry.mjs',
    'src/ama/dispatch-closer.mjs',
    'frontend/supervisor/src/programs.mjs',
  ]) {
    const source = readFileSync(join(repoRoot, relPath), 'utf8');
    const executableUses = source
      .split('\n')
      .filter((line) => line.includes('process.execPath'))
      .filter((line) => !/^\s*(?:\/\/|\*|\/\*\*)/.test(line))
      // The ARF resolver keeps execPath as its documented last resort.
      .filter((line) => !/execPath = process\.execPath,$/.test(line.trim()));
    assert.deepEqual(executableUses, [], `${relPath} spawns node children via process.execPath`);
  }
});

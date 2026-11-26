import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveValidationNode } from '../src/ama/hammer-node-pin.mjs';
import { HAMMER_INFRASTRUCTURE_OUTCOMES } from '../src/ama/hammer-stop-origin.mjs';

const root = join(import.meta.dirname, '..');

function fixture(t) {
  const scratch = mkdtempSync(join(tmpdir(), 'ham-pin-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const cwd = join(scratch, 'target');
  const deploy = join(scratch, 'deploy');
  const workerNode = join(scratch, 'worker', 'bin', 'node');
  const pinnedNode = join(scratch, 'managed runtime', 'bin', 'node');
  const runDir = join(scratch, 'run');
  mkdirSync(cwd);
  mkdirSync(runDir);
  function write(path, body, mode = 0o644) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, { mode });
  }
  for (const [node, version] of [[workerNode, '26.10.0'], [pinnedNode, '22.22.3']]) {
    write(node, `#!/bin/sh\n[ "$1" = --version ] || exit 1\nprintf 'v${version}\\n'\n`, 0o755);
  }
  write(join(deploy, 'scripts/lib/resolve-node-runtime.sh'), 'printf "%s\\n" "${AGENT_OS_NODE_BIN:-$FIXTURE_MANAGED_NODE}"\n');
  const env = { PATH: `${dirname(workerNode)}:${process.env.PATH}`, PYTHONPATH: process.env.PYTHONPATH,
    TMPDIR: scratch, HAM_NODE_BIN: workerNode, HAM_RUN_DIR: runDir, HAM_REPO: 'fixture/project',
    HAM_LOCAL_VALIDATION_CI_DEDUP: '0', AGENT_OS_DEPLOY_CHECKOUT: deploy, AGENT_OS_NODE_BIN: workerNode,
    FIXTURE_MANAGED_NODE: pinnedNode };
  const receipt = join(runDir, 'validation.json');
  const validate = () => spawnSync(process.execPath, [join(root, 'bin/hammer-validate.mjs'), '--canonical', '--', 'some-file'],
    { cwd, env: { ...env, HAM_CLOSE_VALIDATION_RECEIPT: receipt }, encoding: 'utf8', timeout: 15000 });
  return { cwd, workerNode, pinnedNode, env, validate, receipt,
    writeTarget: (path, body) => write(join(cwd, path), body) };
}

test('the canonical mirror uses the exact managed manifest version', t => {
  const { pinnedNode, validate, writeTarget } = fixture(t);
  writeTarget('runtime/node/manifest.json', '{"version":"22.22.3"}');
  writeTarget('.nvmrc', '26\n');
  writeTarget('scripts/ci-mirror/run-ci-mirror.py', `import os
import shutil
import subprocess
print(os.environ["HAM_NODE_BIN"], flush=True)
print(shutil.which("node"), flush=True)
subprocess.run(["node", "--version"], check=True)
`);
  const validation = validate();
  assert.equal(validation.status, 0, validation.stderr);
  assert.match(validation.stderr, /target Node v22\.22\.3/);
  assert.deepEqual(validation.stdout.trim().split('\n'), [pinnedNode, pinnedNode, 'v22.22.3']);
});

test('missing and mismatched pins stop as infrastructure before running the mirror', t => {
  const { env, validate, receipt, writeTarget } = fixture(t);
  env.HAM_REPO = 'fixture/agent-os';
  writeTarget('scripts/ci-mirror/run-ci-mirror.py', 'raise RuntimeError("mirror ran")\n');
  for (const declaration of [null, '{"version":"99.99.99"}']) {
    if (declaration) writeTarget('runtime/node/manifest.json', declaration);
    const validation = validate();
    assert.equal(validation.status, 78, validation.stderr);
    assert.match(validation.stderr, /node-pin-unavailable/);
    assert.doesNotMatch(validation.stderr, /mirror ran/);
    const evidence = JSON.parse(readFileSync(receipt, 'utf8'));
    assert.equal(evidence.validation, 'unknown');
    assert.equal(evidence.outcome, 'node-pin-unavailable');
    assert.equal(evidence.checks[0].result, 'inconclusive');
  }
  assert.ok(HAMMER_INFRASTRUCTURE_OUTCOMES.has('node-pin-unavailable'));
});

test('.nvmrc and engines match installed versions and keep either supported matrix interpreter', t => {
  const { cwd, workerNode, pinnedNode, env, writeTarget } = fixture(t);
  writeTarget('package.json', '{"name":"adversarial-review","engines":{"node":">=22.10 <27"}}');
  for (const [node, version] of [[pinnedNode, '22.22.3'], [workerNode, '26.10.0']]) {
    assert.deepEqual(resolveValidationNode(cwd, { ...env, HAM_NODE_BIN: node }), { node, version });
  }
  writeTarget('.nvmrc', 'v22.22.3 # target version\n');
  assert.deepEqual(resolveValidationNode(cwd, { ...env, PATH: `${dirname(workerNode)}:${dirname(pinnedNode)}` }, workerNode),
    { node: pinnedNode, version: '22.22.3' });
});

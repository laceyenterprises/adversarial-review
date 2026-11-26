import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveValidationNode, validationNodeEnvironment } from '../src/ama/hammer-node-pin.mjs';
import { classifyCloserOutcome } from '../src/ama/closer-inconclusive-retry.mjs';
import { HAMMER_INFRASTRUCTURE_OUTCOMES, registeredHammerStopOrigin } from '../src/ama/hammer-stop-origin.mjs';

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
  const config = join(scratch, 'config.yaml');
  write(config, 'version: 1\ngithub:\n  org: fixture\n');
  const env = { PATH: `${dirname(workerNode)}:${process.env.PATH}`, PYTHONPATH: process.env.PYTHONPATH,
    TMPDIR: scratch, HAM_NODE_BIN: workerNode, HAM_RUN_DIR: runDir, HAM_REPO: 'fixture/project',
    AGENT_OS_CONFIG_PATH: config,
    HAM_LOCAL_VALIDATION_CI_DEDUP: '0', AGENT_OS_DEPLOY_CHECKOUT: deploy, AGENT_OS_NODE_BIN: workerNode,
    FIXTURE_MANAGED_NODE: pinnedNode };
  const receipt = join(runDir, 'validation.json');
  const validate = (nodeArgs = []) => spawnSync(process.execPath, [...nodeArgs, join(root, 'bin/hammer-validate.mjs'), '--canonical', '--', 'some-file'],
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
  const [selected, pathNode, version] = validation.stdout.trim().split('\n');
  assert.equal(selected, pinnedNode);
  assert.match(pathNode, /\/node-bin\/node$/);
  assert.equal(version, 'v22.22.3');
});

test('missing pins are counted; installed-runtime gaps remain retryable', t => {
  const { env, validate, receipt, writeTarget } = fixture(t);
  env.HAM_REPO = 'fixture/agent-os';
  writeTarget('scripts/ci-mirror/run-ci-mirror.py', 'raise RuntimeError("mirror ran")\n');
  for (const [declaration, outcome, kind] of [
    [null, 'node-pin-undeclared', 'real'],
    ['{"version":"99.99.99"}', 'node-pin-unavailable', 'inconclusive'],
  ]) {
    if (declaration) writeTarget('runtime/node/manifest.json', declaration);
    const validation = validate();
    assert.equal(validation.status, outcome === 'node-pin-unavailable' ? 80 : 81, validation.stderr);
    assert.match(validation.stderr, new RegExp(outcome));
    assert.doesNotMatch(validation.stderr, /mirror ran/);
    const evidence = JSON.parse(readFileSync(receipt, 'utf8'));
    assert.equal(evidence.validation, 'unknown');
    assert.equal(evidence.outcome, outcome);
    assert.equal(evidence.checks[0].result, 'inconclusive');
    assert.equal(classifyCloserOutcome({ reason: outcome }).kind, kind);
  }
  assert.ok(HAMMER_INFRASTRUCTURE_OUTCOMES.has('node-pin-unavailable'));
  assert.equal(registeredHammerStopOrigin('node-pin-undeclared'), 'world');
});

test('.nvmrc and engines match installed versions and keep either supported matrix interpreter', t => {
  const { cwd, workerNode, pinnedNode, env, writeTarget } = fixture(t);
  writeTarget('package.json', '{"name":"adversarial-review","engines":{"node":">=22.10 <27"}}');
  for (const [node, version] of [[pinnedNode, '22.22.3'], [workerNode, '26.10.0']]) {
    assert.deepEqual(resolveValidationNode(cwd, { ...env, HAM_NODE_BIN: node }), { node, version });
  }
  writeTarget('.nvmrc', 'v22.22.3 # target version\n');
  assert.deepEqual(resolveValidationNode(cwd, env, workerNode),
    { node: pinnedNode, version: '22.22.3' });
});

test('validation probes explicit runtimes before the managed fallback and skips PATH-only runtimes', t => {
  const { cwd, workerNode, pinnedNode, env, writeTarget } = fixture(t);
  writeTarget('runtime/node/manifest.json', '{"version":"22.22.3"}');
  const resolverMarker = join(cwd, 'resolver-ran');
  const resolver = join(env.AGENT_OS_DEPLOY_CHECKOUT, 'scripts/lib/resolve-node-runtime.sh');
  writeFileSync(resolver, 'touch "$RESOLVER_MARKER"\nprintf "%s\\n" "$FIXTURE_MANAGED_NODE"\n');
  Object.assign(env, { PATH: `${dirname(pinnedNode)}:${env.PATH}`, RESOLVER_MARKER: resolverMarker,
    AGENT_OS_NODE_BIN: pinnedNode, FIXTURE_MANAGED_NODE: workerNode });
  assert.deepEqual(resolveValidationNode(cwd, env, workerNode), { node: pinnedNode, version: '22.22.3' });
  assert.throws(() => readFileSync(resolverMarker), { code: 'ENOENT' });
  env.AGENT_OS_NODE_BIN = workerNode;
  assert.equal(resolveValidationNode(cwd, { ...env, HAM_REPO: 'fixture/agent-os' }, workerNode).reason, 'node-pin-unavailable');
  assert.equal(readFileSync(resolverMarker, 'utf8'), '');
});

test('unrelated repositories fall back without a usable pin and unsupported .nvmrc uses engines', t => {
  const { cwd, env, workerNode, writeTarget } = fixture(t);
  writeTarget('package.json', '{"name":"python-tooling"}');
  assert.deepEqual(resolveValidationNode(cwd, env), {});
  writeTarget('.nvmrc', 'lts/iron\n');
  assert.deepEqual(resolveValidationNode(cwd, env), {});
  writeTarget('package.json', '{"engines":{"node":"26.10.0"}}');
  assert.deepEqual(resolveValidationNode(cwd, env), { node: workerNode, version: '26.10.0' });
  assert.equal(resolveValidationNode(cwd, { ...env, HAM_REPO: 'fixture/agent-os' }).node, workerNode);
});

test('malformed immutable declarations are counted', t => {
  const { cwd, env, writeTarget } = fixture(t);
  env.HAM_REPO = 'fixture/agent-os';
  writeTarget('package.json', '{invalid');
  assert.equal(resolveValidationNode(cwd, env).reason, 'node-pin-undeclared');
  writeTarget('runtime/node/manifest.json', '{invalid');
  assert.equal(resolveValidationNode(cwd, env).reason, 'node-pin-undeclared');
});

test('unrelated repositories retain the service runtime for malformed or unavailable pins', t => {
  const { cwd, env, writeTarget, validate } = fixture(t);
  for (const declaration of ['{invalid', '{"engines":{"node":"20.x"}}']) {
    writeTarget('package.json', declaration);
    const result = resolveValidationNode(cwd, env);
    assert.equal(result.reason, undefined);
    assert.match(result.warning, /using the service runtime/);
    writeTarget('scripts/ci-mirror/run-ci-mirror.py', 'print("python validated")\n');
    const validation = validate();
    assert.equal(validation.status, 0, validation.stderr);
    assert.match(validation.stdout, /python validated/);
    assert.match(validation.stderr, /using the service runtime/);
  }
});

test('strict repositories use configured owner/name with case normalization and require controller identity', t => {
  const { cwd, env } = fixture(t);
  for (const repo of ['FIXTURE/Agent-OS', 'Fixture/Adversarial-Review']) {
    assert.equal(resolveValidationNode(cwd, { ...env, HAM_REPO: repo }).reason, 'node-pin-undeclared');
  }
  for (const repo of ['fork/agent-os', 'fork/adversarial-review', 'prefix-fixture/agent-os', '']) {
    assert.deepEqual(resolveValidationNode(cwd, { ...env, HAM_REPO: repo }), {});
  }
  for (const repo of ['', 'agent-os']) {
    assert.match(resolveValidationNode(cwd, { ...env, HAM_REPO: repo, HAM_CONTROLLER_RECORD: 'controller' }).detail,
      /requires HAM_REPO owner\/name/);
  }
});

test('receipt write failure preserves a dedicated pin-stop status', t => {
  const { env, validate, receipt } = fixture(t);
  env.HAM_REPO = 'fixture/agent-os';
  mkdirSync(receipt);
  const result = validate();
  assert.equal(result.status, 81, result.stderr);
  assert.match(result.stderr, /node-pin-undeclared/);
  assert.match(result.stderr, /local validation receipt unavailable/);
});

test('non-exact manifest versions fall through to usable declarations or service-runtime fallback', t => {
  const { cwd, env, workerNode, pinnedNode, writeTarget } = fixture(t);
  for (const manifest of ['{"version":"22"}', 'null', '{}', '{"version":22}']) {
    writeTarget('runtime/node/manifest.json', manifest);
    assert.deepEqual(resolveValidationNode(cwd, env), {}, manifest);
    for (const repo of ['fixture/agent-os', 'fixture/adversarial-review']) {
      assert.equal(resolveValidationNode(cwd, { ...env, HAM_REPO: repo }).reason, 'node-pin-undeclared');
    }
  }
  writeTarget('package.json', '{"engines":{"node":"26.10.0"}}');
  assert.deepEqual(resolveValidationNode(cwd, env), { node: workerNode, version: '26.10.0' });
  writeTarget('.nvmrc', '22.22.3\n');
  assert.deepEqual(resolveValidationNode(cwd, env), { node: pinnedNode, version: '22.22.3' });
});

test('PATH setup and phase-record failures preserve the classified exit and receipt', t => {
  const { cwd, env, validate, receipt, writeTarget } = fixture(t);
  Object.assign(env, { HAM_HQ_ROOT: cwd, HQ_LAUNCH_REQUEST_ID: 'lrq_fixture', HQ_WORKER_RUN_ID: 'wrun_fixture' });
  writeTarget('package.json', JSON.stringify({ engines: { node: process.versions.node } }));
  writeTarget('failures.mjs', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const mkdir = fs.mkdirSync;
    fs.mkdirSync = (path, ...args) => {
      if (String(path).endsWith('/node-bin')) {
        throw Object.assign(new Error('fixture PATH setup failure'), { code: 'EACCES' });
      }
      if (String(path).endsWith('/hammer-progress/wrun_fixture')) {
        console.error('fixture phase write failed');
        throw Object.assign(new Error('phase write unavailable'), { code: 'EACCES' });
      }
      return mkdir(path, ...args);
    };
    syncBuiltinESMExports();
  `);
  const result = validate(['--import', join(cwd, 'failures.mjs')]);
  assert.equal(result.status, 78, result.stderr);
  assert.match(result.stderr, /unable to prepare target Node PATH \(EACCES\)/);
  assert.match(result.stderr, /fixture phase write failed/);
  const evidence = JSON.parse(readFileSync(receipt, 'utf8'));
  assert.equal(evidence.status, 78);
  assert.equal(evidence.validation, 'unknown');
  assert.equal(evidence.checks[0].reason, 'validation-environment-failed');
});

test('target Node PATH keeps existing tool order', t => {
  const { env, pinnedNode } = fixture(t);
  const scratch = mkdtempSync(join(tmpdir(), 'ham-pin-path-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const originalPath = `/venv/bin:${dirname(pinnedNode)}:/usr/bin`;
  const selected = validationNodeEnvironment({ ...env, PATH: originalPath }, pinnedNode, scratch);
  assert.equal(selected.HAM_NODE_BIN, pinnedNode);
  assert.equal(selected.PATH, `${join(scratch, 'node-bin')}:${originalPath}`);
  assert.equal(readlinkSync(join(scratch, 'node-bin', 'node')), pinnedNode);
});

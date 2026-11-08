import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function fixture(t, scenario) {
  const root = mkdtempSync(join(tmpdir(), 'ci-install-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const stub = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const tool = path.basename(process.argv[1]);
const root = process.env.HOME;
const trace = path.join(root, 'trace.json');
const calls = fs.existsSync(trace) ? JSON.parse(fs.readFileSync(trace)) : [];
const headers = path.join(root, '.cache/node-gyp', process.versions.node);
const sibling = path.join(root, '.cache/node-gyp', 'other-version');
calls.push({tool, args: process.argv.slice(2), V: process.env.V,
  nodedir: process.env.npm_package_config_node_gyp_nodedir,
  stale: fs.existsSync(path.join(headers, 'stale')),
  sibling: fs.existsSync(sibling)});
fs.writeFileSync(trace, JSON.stringify(calls));
const count = calls.filter(c => c.tool === tool).length;
const scenario = process.env.INSTALL_SCENARIO;
if (tool === 'npx') {
  if (scenario === 'headers' || (scenario === 'refresh' && count === 2)) process.exit(19);
  fs.mkdirSync(headers, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  process.exit(0);
}
console.log('compiler-output-' + count);
if (scenario === 'ok' || (scenario === 'retry' && count === 2)) process.exit(0);
fs.writeFileSync(path.join(headers, 'stale'), 'synthetic');
if (scenario === 'unrelated') console.error('npm error registry unavailable; fs-ext is a dependency');
else if (scenario === 'other-addon') console.error('gyp ERR! cwd /synthetic/node_modules/other-addon');
else {
  console.error('gyp ERR! cwd /synthetic/node_modules/fs-ext');
  console.error('gyp ERR! build error');
}
process.exit(23);
`;
  for (const name of ['npm', 'npx']) writeFileSync(join(bin, name), stub, { mode: 0o700 });
  const result = spawnSync(process.execPath, [resolve('bin/ci-install.mjs')], {
    env: { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}`, INSTALL_SCENARIO: scenario },
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.ifError(result.error);
  const calls = JSON.parse(readFileSync(join(root, 'trace.json'), 'utf8'));
  return { result, calls, root };
}

test('prepares exact-version headers before one verbose foreground install', t => {
  const { result, calls, root } = fixture(t, 'ok');
  assert.equal(result.status, 0);
  assert.deepEqual(calls.map(c => c.tool), ['npx', 'npm']);
  assert.deepEqual(calls[0].args, [
    '--yes', '--package=node-gyp@12.4.0', 'node-gyp', 'install', '--ensure',
    `--target=${process.versions.node}`, `--devdir=${join(root, '.cache/node-gyp')}`, '--verbose',
  ]);
  assert.deepEqual(calls[1].args, ['ci', '--foreground-scripts', '--loglevel', 'verbose']);
  assert.equal(calls[1].V, '1');
  assert.equal(calls[1].nodedir, join(root, '.cache/node-gyp', process.versions.node));
});

test('fs-ext failure prints both compiler logs and refreshes only current headers', t => {
  const { result, calls } = fixture(t, 'retry');
  assert.equal(result.status, 0);
  assert.deepEqual(calls.map(c => c.tool), ['npx', 'npm', 'npx', 'npm']);
  assert.equal(calls[2].stale, false);
  assert.equal(calls[2].sibling, true);
  assert.match(result.stdout, /compiler-output-1[\s\S]*gyp ERR! build error[\s\S]*compiler-output-2/);
});

for (const scenario of ['unrelated', 'other-addon']) {
  test(`${scenario} install failure is not retried`, t => {
    const { result, calls } = fixture(t, scenario);
    assert.equal(result.status, 23);
    assert.deepEqual(calls.map(c => c.tool), ['npx', 'npm']);
  });
}

test('a second fs-ext failure remains red with no third attempt', t => {
  const { result, calls } = fixture(t, 'persistent');
  assert.equal(result.status, 23);
  assert.deepEqual(calls.map(c => c.tool), ['npx', 'npm', 'npx', 'npm']);
  assert.match(result.stdout, /compiler-output-2/);
});

for (const scenario of ['headers', 'refresh']) {
  test(`${scenario} preparation failure stops before another npm install`, t => {
    const { result, calls } = fixture(t, scenario);
    assert.equal(result.status, 19);
    assert.deepEqual(calls.map(c => c.tool),
      scenario === 'headers' ? ['npx'] : ['npx', 'npm', 'npx']);
  });
}

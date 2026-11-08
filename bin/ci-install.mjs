// CI-only install reliability; runtime dependencies and locking are unchanged.
import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

const version = process.versions.node;
const devdir = join(homedir(), '.cache', 'node-gyp');
const headers = join(devdir, version);
const env = {
  ...process.env,
  V: '1',
  // Lifecycle node-gyp uses these headers rather than fetching another copy.
  npm_package_config_node_gyp_nodedir: headers,
};

function prepareHeaders() {
  const result = spawnSync('npx', [
    '--yes', '--package=node-gyp@12.4.0', 'node-gyp', 'install', '--ensure',
    `--target=${version}`, `--devdir=${devdir}`, '--verbose',
  ], { stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  return result.status ?? 1;
}

function install() {
  return new Promise(resolve => {
    const child = spawn('npm', ['ci', '--foreground-scripts', '--loglevel', 'verbose'],
      { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    // Print progress immediately and retain the complete diagnostic for matching.
    // Stream decoding preserves characters split across subprocess writes.
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        output += chunk;
        process.stdout.write(chunk);
      });
    }
    child.on('error', error => console.error(error.message));
    child.on('close', status => resolve({ status: status ?? 1, output }));
  });
}

async function main() {
  let status = prepareHeaders();
  if (status !== 0) return status;
  const first = await install();
  if (first.status === 0) return 0;
  // A registry, lockfile, or other package error must fail immediately. Require
  // node-gyp's failed working directory, not a mention in the dependency list.
  if (!/^.*gyp ERR! cwd .*[/\\]node_modules[/\\]fs-ext\s*$/m.test(stripVTControlCharacters(first.output))) {
    return first.status;
  }
  console.error('fs-ext build failed; refreshing Node headers and retrying npm ci once.');
  rmSync(headers, { recursive: true, force: true });
  status = prepareHeaders();
  if (status !== 0) return status;
  return (await install()).status;
}

process.exitCode = await main();

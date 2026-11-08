// CI-only install reliability; runtime dependencies and locking are unchanged.
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const version = process.versions.node;
const devdir = join(homedir(), '.cache', 'node-gyp');
const headers = join(devdir, version);
const logs = mkdtempSync(join(tmpdir(), 'native-install-'));
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

function install(attempt) {
  const file = join(logs, `attempt-${attempt}.log`);
  const fd = openSync(file, 'w', 0o600);
  let result;
  try {
    result = spawnSync('npm', ['ci', '--foreground-scripts', '--loglevel', 'verbose'],
      { env, stdio: ['ignore', fd, fd] });
  } finally {
    closeSync(fd);
  }
  // Never truncate npm's buffered error tail: retain every compiler command and
  // diagnostic, including the first failure when the second attempt succeeds.
  const output = readFileSync(file, 'utf8');
  process.stdout.write(output);
  if (result.error) console.error(result.error.message);
  return { status: result.status ?? 1, output };
}

function main() {
  let status = prepareHeaders();
  if (status !== 0) return status;
  const first = install(1);
  if (first.status === 0) return 0;
  // A registry, lockfile, or other package error must fail immediately. Require
  // node-gyp's failed working directory, not a mention in the dependency list.
  if (!/^.*gyp ERR! cwd .*[/\\]node_modules[/\\]fs-ext\s*$/m.test(first.output)) {
    return first.status;
  }
  console.error('fs-ext build failed; refreshing Node headers and retrying npm ci once.');
  rmSync(headers, { recursive: true, force: true });
  status = prepareHeaders();
  if (status !== 0) return status;
  return install(2).status;
}

try {
  process.exitCode = main();
} finally {
  rmSync(logs, { recursive: true, force: true });
}

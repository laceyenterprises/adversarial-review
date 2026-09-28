import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { constants, tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(testDir);
const checkoutDataDir = path.join(repoRoot, 'data');
const callerTmpDir = tmpdir();
// Leave room under the macOS 104-byte Unix socket path limit for nested fixtures.
const tempBase = Buffer.byteLength(realpathSync(callerTmpDir)) > 60 ? '/tmp' : callerTmpDir;
let sandboxRoot;

function makeWorkerRoot(index) {
  const root = path.join(sandboxRoot, `file-${index}`);
  mkdirSync(root);
  for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
    if (entry.name === 'data' || entry.name === '.git') continue;
    symlinkSync(path.join(repoRoot, entry.name), path.join(root, entry.name),
      entry.isDirectory() ? 'dir' : 'file');
  }
  return root;
}

function listFiles(rootDir) {
  try {
    return new Map(readdirSync(rootDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
      .map((entryPath) => [
        path.relative(rootDir, entryPath),
        createHash('sha256').update(
          lstatSync(entryPath).isSymbolicLink()
            ? Buffer.from(readlinkSync(entryPath))
            : readFileSync(entryPath),
        ).digest('hex'),
      ]));
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
}

function testFiles() {
  const selected = new Set(process.argv.slice(2).map((file) => path.resolve(repoRoot, file)));
  const topLevel = readdirSync(testDir)
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => path.join(testDir, name));
  const adaptersDir = path.join(testDir, 'adapters');
  const adapters = readdirSync(adaptersDir)
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => path.join(adaptersDir, name));
  return [...topLevel, ...adapters].filter((file) => !selected.size || selected.has(file)).sort();
}

const checkoutDataExistedBefore = existsSync(checkoutDataDir);
const checkoutDataBefore = listFiles(checkoutDataDir);
const signalHandlers = new Map();
let child;
let timeout;
let forceKillTimeout;
let receivedSignal;
let timedOut = false;

function signalTestGroup(signal) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function terminateChild(signal) {
  signalTestGroup(signal);
  forceKillTimeout ??= setTimeout(() => signalTestGroup('SIGKILL'), 5_000);
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  const handler = () => {
    receivedSignal ??= signal;
    if (child) terminateChild(signal);
  };
  signalHandlers.set(signal, handler);
  process.on(signal, handler);
}

try {
  sandboxRoot = realpathSync(mkdtempSync(path.join(tempBase, 'art-')));
  const sandboxTmpDir = path.join(sandboxRoot, 'tmp');
  mkdirSync(sandboxTmpDir);
  // Include this run's random sandbox name so concurrent suites cannot trip the guard.
  const fixtureProbePrefix = `adversarial-review-tmp-probe-${path.basename(sandboxRoot)}-`;
  const testPaths = testFiles().map((file, index) => {
    const root = makeWorkerRoot(index);
    return path.join(root, path.relative(repoRoot, file));
  });
  child = spawn(process.execPath, [
    '--preserve-symlinks',
    '--preserve-symlinks-main',
    '--import',
    path.join(testDir, 'helpers', 'child-leak-guard.mjs'),
    '--import',
    path.join(testDir, 'helpers', 'rate-limit-state-isolation.mjs'),
    '--import',
    path.join(testDir, 'helpers', 'temp-sandbox-guard.mjs'),
    '--test',
    '--test-concurrency=8',
    ...testPaths,
  ], {
    cwd: sandboxRoot,
    env: {
      ...process.env,
      ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT: sandboxRoot,
      ADVERSARIAL_REVIEW_TEST_TMP_PROBE_PREFIX: fixtureProbePrefix,
      TMPDIR: sandboxTmpDir,
      TMP: sandboxTmpDir,
      TEMP: sandboxTmpDir,
      PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--preserve-symlinks', '--preserve-symlinks-main'].filter(Boolean).join(' '),
    },
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  });
  const childExit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal }));
  });

  if (receivedSignal) terminateChild(receivedSignal);
  timeout = setTimeout(() => {
    timedOut = true;
    terminateChild('SIGTERM');
  }, 900_000);
  const result = await childExit;

  const checkoutDataAfter = listFiles(checkoutDataDir);
  const leakedFiles = [...checkoutDataAfter].filter(([file, hash]) => checkoutDataBefore.get(file) !== hash).map(([file]) => file);
  if (leakedFiles.length > 0 || (!checkoutDataExistedBefore && existsSync(checkoutDataDir))) {
    console.error(`Test suite wrote into the checkout data directory:\n${leakedFiles.join('\n') || '(directory created)'}`);
    process.exitCode = 1;
  } else if (timedOut) {
    throw Object.assign(new Error('Test suite timed out after 900 seconds'), { code: 'ETIMEDOUT' });
  } else if (process.exitCode !== 1) {
    process.exitCode = result.status ?? 1;
  }
  if (receivedSignal) process.exitCode = 128 + constants.signals[receivedSignal];
} finally {
  clearTimeout(timeout);
  clearTimeout(forceKillTimeout);
  if (receivedSignal || timedOut) signalTestGroup('SIGKILL');
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  if (sandboxRoot) rmSync(sandboxRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

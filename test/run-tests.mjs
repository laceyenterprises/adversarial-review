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
const callerTmpBefore = new Set(readdirSync(callerTmpDir));
// Leave room under the macOS 104-byte Unix socket path limit for nested fixtures.
const tempBase = Buffer.byteLength(realpathSync(callerTmpDir)) > 60 ? '/tmp' : callerTmpDir;
const sandboxRoot = realpathSync(mkdtempSync(path.join(tempBase, 'art-')));
const sandboxTmpDir = path.join(sandboxRoot, 'tmp');
mkdirSync(sandboxTmpDir);
const fixturePrefixes = [
  'adversarial-review-', 'hammer-', 'watcher-', 'reaper-', 'reviewer-',
  'run-ledger-', 'diagnose-stuck-rereview-',
];

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
  const topLevel = readdirSync(testDir)
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => path.join(testDir, name));
  const adaptersDir = path.join(testDir, 'adapters');
  const adapters = readdirSync(adaptersDir)
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => path.join(adaptersDir, name));
  return [...topLevel, ...adapters].sort();
}

const checkoutDataExistedBefore = existsSync(checkoutDataDir);
const checkoutDataBefore = listFiles(checkoutDataDir);
const signalHandlers = new Map();
let timeout;
let forceKillTimeout;
let receivedSignal;
let timedOut = false;

try {
  const testPaths = testFiles().map((file, index) => {
    const root = makeWorkerRoot(index);
    return path.join(root, path.relative(repoRoot, file));
  });
  const child = spawn(process.execPath, [
    '--preserve-symlinks',
    '--preserve-symlinks-main',
    '--import',
    path.join(testDir, 'helpers', 'child-leak-guard.mjs'),
    '--import',
    path.join(testDir, 'helpers', 'rate-limit-state-isolation.mjs'),
    '--test',
    '--test-concurrency=8',
    ...testPaths,
  ], {
    cwd: sandboxRoot,
    env: {
      ...process.env,
      ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT: sandboxRoot,
      TMPDIR: sandboxTmpDir,
      TMP: sandboxTmpDir,
      TEMP: sandboxTmpDir,
      PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--preserve-symlinks', '--preserve-symlinks-main'].filter(Boolean).join(' '),
    },
    stdio: 'inherit',
  });
  const childExit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal }));
  });

  function terminateChild(signal) {
    child.kill(signal);
    forceKillTimeout ??= setTimeout(() => child.kill('SIGKILL'), 5_000);
  }

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    const handler = () => {
      receivedSignal ??= signal;
      terminateChild(signal);
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  timeout = setTimeout(() => {
    timedOut = true;
    terminateChild('SIGTERM');
  }, 900_000);
  const result = await childExit;

  const leakedTempEntries = readdirSync(callerTmpDir).filter((name) =>
    !callerTmpBefore.has(name) && fixturePrefixes.some((prefix) => name.startsWith(prefix)));
  if (leakedTempEntries.length > 0) {
    console.error(`Test suite wrote fixture directories into caller TMPDIR:\n${leakedTempEntries.join('\n')}`);
    process.exitCode = 1;
  }
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
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  rmSync(sandboxRoot, { recursive: true, force: true });
}

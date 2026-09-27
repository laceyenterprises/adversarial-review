import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(testDir);
const checkoutDataDir = path.join(repoRoot, 'data');
const sandboxRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'adversarial-review-tests-')));

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

try {
  const testPaths = testFiles().map((file, index) => {
    const root = makeWorkerRoot(index);
    return path.join(root, path.relative(repoRoot, file));
  });
  const result = spawnSync(process.execPath, [
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
      PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--preserve-symlinks', '--preserve-symlinks-main'].filter(Boolean).join(' '),
    },
    stdio: 'inherit',
    timeout: 900_000,
  });

  const checkoutDataAfter = listFiles(checkoutDataDir);
  const leakedFiles = [...checkoutDataAfter].filter(([file, hash]) => checkoutDataBefore.get(file) !== hash).map(([file]) => file);
  if (leakedFiles.length > 0 || (!checkoutDataExistedBefore && existsSync(checkoutDataDir))) {
    console.error(`Test suite wrote into the checkout data directory:\n${leakedFiles.join('\n') || '(directory created)'}`);
    process.exitCode = 1;
  } else if (result.error) {
    throw result.error;
  } else {
    process.exitCode = result.status ?? 1;
  }
} finally {
  rmSync(sandboxRoot, { recursive: true, force: true });
}

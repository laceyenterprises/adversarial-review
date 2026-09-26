import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(testDir);
const checkoutDataDir = path.join(repoRoot, 'data');
const sandboxRoot = mkdtempSync(path.join(tmpdir(), 'adversarial-review-tests-'));

// A few CLI tests invoke repository-relative paths. Keep those paths readable
// while all cwd-relative state lands in the private sandbox.
for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
  if (entry.name === 'data' || entry.name === '.git') continue;
  symlinkSync(path.join(repoRoot, entry.name), path.join(sandboxRoot, entry.name),
    entry.isDirectory() ? 'dir' : 'file');
}

function listFiles(rootDir) {
  try {
    return readdirSync(rootDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
      .map((entryPath) => path.relative(rootDir, entryPath))
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
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
  const result = spawnSync(process.execPath, [
    '--import',
    path.join(testDir, 'helpers', 'rate-limit-state-isolation.mjs'),
    '--test',
    '--test-concurrency=8',
    ...testFiles(),
  ], {
    cwd: sandboxRoot,
    env: {
      ...process.env,
      ADVERSARIAL_REVIEW_TEST_CWD: sandboxRoot,
      ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT: sandboxRoot,
      ADVERSARIAL_REVIEW_STATE_DIR: path.join(sandboxRoot, 'data'),
    },
    stdio: 'inherit',
    timeout: 900_000,
  });

  const checkoutDataAfter = listFiles(checkoutDataDir);
  const leakedFiles = checkoutDataAfter.filter((file) => !checkoutDataBefore.includes(file));
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

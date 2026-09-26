import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readdirSync, symlinkSync } from 'node:fs';

const sandboxRoot = process.env.ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT;
const isTestWorker = Boolean(process.env.NODE_TEST_CONTEXT && process.argv[1]?.endsWith('.test.mjs'));
let testCwd = process.env.ADVERSARIAL_REVIEW_TEST_CWD || sandboxRoot;

if (sandboxRoot && isTestWorker) {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  testCwd = mkdtempSync(path.join(sandboxRoot, 'worker-'));
  for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
    if (entry.name === 'data' || entry.name === '.git') continue;
    symlinkSync(path.join(repoRoot, entry.name), path.join(testCwd, entry.name),
      entry.isDirectory() ? 'dir' : 'file');
  }
  process.env.ADVERSARIAL_REVIEW_TEST_CWD = testCwd;
}

if (!testCwd) {
  throw new Error('test/run-tests.mjs must set the test sandbox root');
}

process.chdir(testCwd);
if (isTestWorker || !process.env.ADVERSARIAL_REVIEW_STATE_DIR) {
  process.env.ADVERSARIAL_REVIEW_STATE_DIR = path.join(testCwd, 'data');
}
const preloadOption = `--import=${fileURLToPath(import.meta.url)}`;
if (!String(process.env.NODE_OPTIONS || '').includes(preloadOption)) {
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, preloadOption].filter(Boolean).join(' ');
}
process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = path.join(
  testCwd,
  'data',
  'api-cache',
  'rate-limit-state.json',
);

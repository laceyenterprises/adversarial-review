import path from 'node:path';

// Each test file enters through its own symlinked repository root. Production
// modules resolve their normal ROOT under that root with --preserve-symlinks.
// Child processes inherit that root but keep the cwd their caller requested.
const testFile = process.argv[1];
const sandboxRoot = process.env.ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT;
if (!sandboxRoot) {
  throw new Error('run tests through test/run-tests.mjs so state stays outside the checkout');
}
const isTestWorker = Boolean(process.env.NODE_TEST_CONTEXT && testFile?.endsWith('.test.mjs'));
if (isTestWorker) {
  const testDir = path.dirname(testFile);
  const workerRoot = path.dirname(path.basename(testDir) === 'adapters' ? path.dirname(testDir) : testDir);
  const relative = path.relative(sandboxRoot, workerRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`test file escaped the test sandbox: ${testFile}`);
  }
  process.env.ADVERSARIAL_REVIEW_TEST_CWD = workerRoot;
  process.env.ADVERSARIAL_REVIEW_STATE_DIR = path.join(workerRoot, 'data');
  process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = path.join(workerRoot, 'data', 'api-cache', 'rate-limit-state.json');
  process.chdir(workerRoot);
}

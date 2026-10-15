import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Each test file enters through its own symlinked repository root. Production
// modules resolve their normal ROOT under that root with --preserve-symlinks.
// Child processes inherit that root but keep the cwd their caller requested.
const testFile = process.argv[1];
const sandboxRoot = process.env.ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT;
if (!sandboxRoot) {
  // Started outside test/run-tests.mjs (plain `node --test <file>`, `node <file>`,
  // an editor or another CI step). Most production modules write under their own
  // repository root, so the isolation cannot be recreated in-process: re-run this
  // file through the runner, which gives it its own sandbox root, and report the
  // runner's result as this process's result. Test files import this helper first,
  // so no production module has been evaluated yet.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  if (!testFile?.endsWith('.test.mjs') || process.env.ADVERSARIAL_REVIEW_TEST_REEXEC === '1') {
    throw new Error('run tests through test/run-tests.mjs so state stays outside the checkout');
  }
  const env = { ...process.env, ADVERSARIAL_REVIEW_TEST_REEXEC: '1' };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'test', 'run-tests.mjs'),
    path.relative(repoRoot, path.resolve(testFile)),
  ], { cwd: repoRoot, env, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
const isTestWorker = Boolean(process.env.NODE_TEST_CONTEXT && testFile?.endsWith('.test.mjs'));
if (isTestWorker) {
  const testDir = path.dirname(testFile);
  const workerRoot = path.dirname(path.basename(testDir) === 'adapters' ? path.dirname(testDir) : testDir);
  const relative = path.relative(sandboxRoot, workerRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`test file escaped the test sandbox: ${testFile}`);
  }
  // Set roots before any production modules are evaluated, overriding worker
  // environment inherited from the host. Each file and its children own these
  // directories; tests may still explicitly override them after this preload.
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'hq-'));
  const homeRoot = mkdtempSync(path.join(tmpdir(), 'home-'));
  process.env.HQ_ROOT = hqRoot;
  process.env.AGENT_OS_HQ_ROOT = hqRoot;
  process.env.HOME = homeRoot;
  process.env.USERPROFILE = homeRoot;
  process.once('exit', () => {
    rmSync(hqRoot, { recursive: true, force: true });
    rmSync(homeRoot, { recursive: true, force: true });
  });
  // The runner also removes its whole sandbox on failure or termination.
  process.env.ADVERSARIAL_REVIEW_TEST_CWD = workerRoot;
  process.env.ADVERSARIAL_REVIEW_STATE_DIR = path.join(workerRoot, 'data');
  process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = path.join(workerRoot, 'data', 'api-cache', 'rate-limit-state.json');
  process.chdir(workerRoot);
}

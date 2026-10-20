// Offline before/after profile. Optional argv[2] is the baseline git ref.
// Run from the repository root: node test/helpers/run-posted-review-profile.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

// Production imports open a module-local review database. Like the test runner,
// give every import a symlink-preserving fixture root, never the checkout data.
if (!process.env.ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT) {
  const workspace = fileURLToPath(new URL('../..', import.meta.url));
  const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'posted-profile-root-')));
  const fixtureHome = join(fixtureRoot, 'fixture-home');
  mkdirSync(fixtureHome);
  try {
    for (const entry of readdirSync(workspace, { withFileTypes: true })) {
      if (entry.name === 'data') continue;
      symlinkSync(join(workspace, entry.name), join(fixtureRoot, entry.name), entry.isDirectory() ? 'dir' : 'file');
    }
    execFileSync(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main',
      join(fixtureRoot, 'test/helpers/run-posted-review-profile.mjs'), process.argv[2] || 'origin/main'], {
      cwd: fixtureRoot, stdio: 'inherit', timeout: 120_000,
      env: { ...process.env, ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT: fixtureRoot, HOME: fixtureHome },
    });
  } finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
  process.exit(0);
}

// Override inherited credentials/config before importing daemon modules.
for (const key of Object.keys(process.env)) {
  if (!['PATH', 'HOME', 'TMPDIR', 'NODE_TEST_CONTEXT'].includes(key)) delete process.env[key];
}
process.env.GITHUB_TOKEN = 'synthetic-token';
process.env.AGENT_OS_CONFIG_PATH = '/fixture/config.yaml';
process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = join(process.cwd(), 'data/profile-rate-limit-state.json');
process.env.GHA_ADAPTER_BIN = '/fixture/github-adapter';
process.env.AGENT_OS_GITHUB_ADAPTER_AUTO_DISCOVERY = 'false';
const { profilePostedReviews, profileHistoryEvidence } = await import('./posted-review-profile.mjs');
const root = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), 'posted-baseline-'));
const paths = ['src/posted-review-row.mjs', 'src/merge-agent-candidate.mjs',
  'src/github-label-events.mjs', 'src/ama-closure-orchestration.mjs', 'src/hammer-wake.mjs',
  'src/closure-evaluation-cache.mjs', 'src/ama/history-reader.mjs'];
const modulesFor = async baseline => {
  const targets = new Map(paths.map((path, i) => [resolve(root, path), join(scratch, `baseline-${i}.mjs`)]));
  if (baseline) for (const path of paths) {
    const source = execFileSync('git', ['show', `${baseline}:${path}`], { encoding: 'utf8' });
    writeFileSync(targets.get(resolve(root, path)), source.replace(/from '(\.[^']+)'/g, (_, relative) => {
      const original = resolve(root, dirname(path), relative);
      return `from '${pathToFileURL(targets.get(original) || original)}'`;
    }));
  }
  const imported = await Promise.all(paths.map(path => import(pathToFileURL(
    baseline ? targets.get(resolve(root, path)) : resolve(root, path)))));
  const gate = await import('../../src/adversarial-gate-status.mjs');
  const controls = await import('../../src/adapters/operator/github-pr-label-controls/index.mjs');
  return Object.assign({}, ...imported, gate, controls);
};
try {
  const beforeModules = await modulesFor(process.argv[2] || 'origin/main');
  const afterModules = await modulesFor(null);
  // Exclude one warm-up PR per version from the reported counters/timings.
  await profilePostedReviews(beforeModules, { prCount: 1, delayMs: 0 });
  await profilePostedReviews(afterModules, { prCount: 1, delayMs: 0 });
  const before = await profilePostedReviews(beforeModules);
  const after = await profilePostedReviews(afterModules);
  assert.deepEqual(after.outcomes, before.outcomes);
  for (const [label, result] of [['before', before], ['after', after]]) {
    const summary = { ...result };
    delete summary.outcomes;
    console.log(JSON.stringify({ label, ...summary }, null, 2));
  }
  console.log(JSON.stringify({ label: 'immutable-history-before', ...await profileHistoryEvidence(beforeModules) }, null, 2));
  console.log(JSON.stringify({ label: 'immutable-history-after', ...await profileHistoryEvidence(afterModules) }, null, 2));
} finally { rmSync(scratch, { recursive: true, force: true }); }

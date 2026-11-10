import { resolve } from 'node:path';

export const PUBLICATION_CHECK_TIMEOUT_MS = 180_000;

// Deliberately bounded to two existing offline fixtures. Use the whole PR diff:
// the final remediation commit may only edit a test for an earlier source change.
export function selectRemediationPublicationChecks(paths) {
  const simulation = paths.some(path => (path.startsWith('src/finalization/') && path.endsWith('.mjs'))
    || (path.startsWith('test/sim/') && /\.(mjs|json)$/.test(path))
    || path === 'test/finalization-simulator.test.mjs'
    || path === 'src/load-aware-timeout.mjs');
  const migrations = paths.some(path => (path.startsWith('migrations/') && path.endsWith('.sql'))
    || path === 'test/watcher-closure-latency.test.mjs'
    || path === 'test/helpers/posted-review-profile.mjs');
  return [
    ...(simulation ? ['test/finalization-simulator.test.mjs'] : []),
    ...(migrations ? ['test/watcher-closure-latency.test.mjs'] : []),
  ];
}

export async function checkRemediationPublication({ workspaceDir, candidate, paths, git, execFileImpl, env }) {
  const tests = selectRemediationPublicationChecks(paths);
  if (!tests.length) return;
  // The publisher also serves other repositories. Their focused checks remain
  // owned by those repositories, rather than imposing this repo's fixture names.
  // Read identity from the inspected commit, so an uncommitted manifest cannot
  // turn off the fixtures before the clean-workspace check.
  if (!await git(['ls-tree', candidate, '--', 'package.json'])) return;
  const manifest = JSON.parse(await git(['show', `${candidate}:package.json`]));
  if (manifest.name !== 'adversarial-review') return;
  if (await git(['status', '--porcelain', '--untracked-files=normal'])) {
    throw Object.assign(new Error('Commit or remove workspace changes before publication fixtures run.'),
      { code: 'remediation-publication-dirty' });
  }
  try {
    // The existing runner isolates credentials/state and owns test descendants.
    // SIGTERM on the outer bound invokes its process-group cleanup.
    await execFileImpl(process.execPath, [resolve(workspaceDir, 'test/run-tests.mjs'), ...tests],
      { cwd: resolve(workspaceDir), env, timeout: PUBLICATION_CHECK_TIMEOUT_MS,
        killSignal: 'SIGTERM', maxBuffer: 4 * 1024 * 1024 });
  } catch (cause) {
    const detail = [cause.stderr, cause.stdout].map(value => String(value ?? '').trim())
      .filter(Boolean).join('\n') || cause.message;
    throw Object.assign(new Error(`Pre-publication fixtures failed: ${tests.join(', ')}\n${detail}`),
      { code: 'remediation-publication-check-failed', cause });
  }
}

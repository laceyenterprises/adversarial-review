import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { samePrHammerHolderWorktreePaths } from './branch-holder-paths.mjs';

const exec = promisify(execFile);

// Only a plain branch checkout is replayable here. Never replay arbitrary
// shell commands, forced checkouts, branch creation or file restoration.
export async function releaseCheckoutHolder({ command, args, errors, env, stderr }, {
  execFileImpl = exec,
  cwd = process.cwd(),
} = {}) {
  if (basename(command) !== 'git' || args.length !== 2 || args[0] !== 'checkout'
    || !args[1] || args[1].startsWith('-')) return false;
  const root = env.HAM_HQ_ROOT || env.HQ_ROOT;
  if (!root) return false;
  const holders = samePrHammerHolderWorktreePaths(errors, null, root);
  if (holders.length !== 1) return false;
  const holder = holders[0];
  stderr(`HAM checkout holder=${holder}\n`);
  try {
    // Lexical and filesystem identity must agree; no symlink or ../ escape.
    if (realpathSync(root) !== resolve(root)
      || realpathSync(holder) !== holder
      || realpathSync(join(root, 'workers')) !== join(resolve(root), 'workers')
      || basename(holder) !== basename(realpathSync(cwd))) return false;
    const options = { env, encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 };
    const git = async (path, ...gitArgs) => (await execFileImpl('git',
      ['-C', path, ...gitArgs], options)).stdout.trim();
    // A diagnostic alone cannot authorize mutation in a different repository.
    const common = async path => realpathSync(await git(path, 'rev-parse',
      '--path-format=absolute', '--git-common-dir'));
    if (await common(holder) !== await common(cwd)
      || await git(holder, 'symbolic-ref', '--short', 'HEAD') !== args[1]) return false;
    await execFileImpl('hq', ['worker', 'release-branch', '--root', root,
      '--holder', holder, '--branch', args[1]], {
      ...options,
      // The host owns a 90s process-group deadline. Allow its TERM/KILL and
      // pipe cleanup to finish before imposing this caller's outer bound.
      timeout: 120_000,
    });
    // Lost responses or a partial multi-repository result must never be
    // interpreted as release. The next checkout still arbitrates any race.
    if (await git(holder, 'rev-parse', '--abbrev-ref', 'HEAD') !== 'HEAD') return false;
    stderr(`HAM checkout holder released=${holder}; retrying checkout once\n`);
    return true;
  } catch {
    stderr(`HAM checkout holder retained=${holder}; release unproven\n`);
    return false;
  }
}

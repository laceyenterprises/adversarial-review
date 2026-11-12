import { execFile } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { samePrHammerHolderWorktreePaths } from './branch-holder-paths.mjs';
import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';

const exec = promisify(execFile);

// Only a plain branch checkout is replayable here. Never replay arbitrary
// shell commands, forced checkouts, branch creation or file restoration.
export async function releaseCheckoutHolder({ command, args, errors, env, stderr }, {
  execFileImpl = exec,
  cwd = process.cwd(),
  statImpl = statSync,
  callerUid = process.getuid?.(),
  timeoutMs = loadAwareTimeoutMs,
} = {}) {
  if (basename(command) !== 'git' || args.length !== 2 || args[0] !== 'checkout'
    || !args[1] || args[1].startsWith('-')) return false;
  const root = env.HAM_HQ_ROOT || env.HQ_ROOT;
  if (!root) return false;
  const holders = samePrHammerHolderWorktreePaths(errors, null, root);
  if (holders.length !== 1) return false;
  const holder = holders[0];
  stderr(`HAM checkout holder=${holder}\n`);
  let started;
  try {
    // Lexical and filesystem identity must agree; no symlink or ../ escape.
    if (realpathSync(root) !== resolve(root)
      || realpathSync(holder) !== holder
      || realpathSync(join(root, 'workers')) !== join(resolve(root), 'workers')) {
      stderr(`HAM checkout holder retained=${holder}; preflight validation failed\n`);
      return false;
    }
    const probeTimeout = timeoutMs(15_000);
    const releaseTimeout = timeoutMs(120_000);
    stderr(`HAM checkout recovery probeBudget=${probeTimeout}ms releaseBudget=${releaseTimeout}ms; additional to helper command budget\n`);
    started = performance.now();
    const options = { env, encoding: 'utf8', timeout: probeTimeout, maxBuffer: 64 * 1024 };
    // Match provisioning's holderCommand: probes run as the worktree owner.
    // HQ still owns every release eligibility and mutation decision.
    const ownerUid = statImpl(holder).uid;
    let ownerUser;
    if (ownerUid !== callerUid) {
      if (!Number.isInteger(ownerUid) || !Number.isInteger(callerUid)) throw new Error('unknown owner');
      ownerUser = (await execFileImpl('id', ['-un', String(ownerUid)], options)).stdout.trim();
      if (!ownerUser || /\s/.test(ownerUser)) throw new Error('unknown owner');
    }
    const git = async (path, ...gitArgs) => {
      const gitArgsWithPath = ['-c', `safe.directory=${path}`, '-C', path, ...gitArgs];
      const result = path === holder && ownerUser
        ? await execFileImpl('sudo', ['-A', '-H', '-u', ownerUser, 'git', ...gitArgsWithPath], options)
        : await execFileImpl('git', gitArgsWithPath, options);
      return result.stdout.trim();
    };
    // A diagnostic alone cannot authorize mutation in a different repository.
    const common = async path => realpathSync(await git(path, 'rev-parse',
      '--path-format=absolute', '--git-common-dir'));
    if (await common(holder) !== await common(cwd)) {
      stderr(`HAM checkout holder retained=${holder}; repository mismatch\n`);
      return false;
    }
    if (await git(holder, 'symbolic-ref', '--short', 'HEAD') !== args[1]) {
      stderr(`HAM checkout holder retained=${holder}; branch mismatch\n`);
      return false;
    }
    await execFileImpl('hq', ['worker', 'release-branch', '--root', root,
      '--holder', holder, '--branch', args[1]], {
      ...options,
      // The host owns a 90s process-group deadline. Allow its TERM/KILL and
      // pipe cleanup to finish before imposing this caller's outer bound.
      timeout: releaseTimeout,
    });
    // Lost responses or a partial multi-repository result must never be
    // interpreted as release. The next checkout still arbitrates any race.
    if (await git(holder, 'rev-parse', '--abbrev-ref', 'HEAD') !== 'HEAD') {
      stderr(`HAM checkout holder retained=${holder}; detach unproven\n`);
      return false;
    }
    stderr(`HAM checkout holder released=${holder}; retrying checkout once\n`);
    return true;
  } catch {
    stderr(`HAM checkout holder retained=${holder}; release unproven\n`);
    return false;
  } finally {
    if (started !== undefined) stderr(`HAM checkout recovery elapsed=${Math.ceil(performance.now() - started)}ms; additional to helper command budget\n`);
  }
}

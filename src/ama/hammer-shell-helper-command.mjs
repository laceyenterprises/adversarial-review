// HAMCONTROLLERSCRIPT-01: `ham_gh`, `ham_git` and `ham_pr` are shell functions
// defined by the sourced helper file. A bounded step that names one of them as
// its command spawns a process, where no such function exists, so the spawn
// failed with ENOENT. Resolve these names to their deployed executables by
// absolute path from this checkout, independent of PATH.
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HAMMER_SERVICE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const SHELL_HELPERS = Object.freeze({
  ham_gh: () => [join(HAMMER_SERVICE_ROOT, 'bin/metered-gh.mjs'), 'exec-hammer'],
  ham_git: () => [join(HAMMER_SERVICE_ROOT, 'bin/metered-gh.mjs'), 'exec-git'],
  ham_pr: env => {
    if (!env.HAM_REPO || !/^[1-9]\d*$/.test(env.HAM_PR_NUMBER || '')) {
      throw new TypeError('ham_pr requires HAM_REPO and HAM_PR_NUMBER');
    }
    return [join(HAMMER_SERVICE_ROOT, 'bin/hammer-pr-read.mjs'), env.HAM_REPO, env.HAM_PR_NUMBER];
  },
});

export function hammerNodeExecutable(env = process.env, execPath = process.execPath) {
  return isAbsolute(env.HAM_NODE_BIN || '') ? env.HAM_NODE_BIN : execPath;
}

// Any other command is returned unchanged.
export function resolveHammerShellHelper(command, args = [], { env = process.env, execPath = process.execPath } = {}) {
  const prefix = Object.hasOwn(SHELL_HELPERS, command) ? SHELL_HELPERS[command](env) : null;
  if (!prefix) return { command, args };
  return { command: hammerNodeExecutable(env, execPath), args: [...prefix, ...args] };
}

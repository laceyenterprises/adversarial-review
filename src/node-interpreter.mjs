// Stable Node interpreter for child spawns from the long-lived pipeline daemons
// (watcher, follow-up daemon) and everything they import.
//
// `process.execPath` is the realpath of the binary THIS process started with,
// e.g. /opt/homebrew/Cellar/node/26.3.0/bin/node. A daemon that outlives a
// Homebrew upgrade keeps that versioned path, and its dylib dependencies are
// linked through the floating /opt/homebrew/opt/<dep> links, which the upgrade
// moves. Every reviewer or helper child it then spawns with `process.execPath`
// dies in dyld before running a line of JS (agent-os SEV1 2026-09-28,
// NODEPIN-01).
//
// Resolve the interpreter at spawn time instead, in this order:
//   1. AGENT_OS_NODE_BIN, when set: the operator/launchd pin always wins;
//   2. /opt/homebrew/bin/node, when present: the stable Homebrew link, which
//      always names the currently installed node;
//   3. process.execPath: the last resort on a host without Homebrew.
import { accessSync, constants as fsConstants, statSync } from 'node:fs';

export const NODE_BIN_ENV = 'AGENT_OS_NODE_BIN';
export const STABLE_NODE_BIN = '/opt/homebrew/bin/node';

function isExecutableFile(path) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveNodeBin({
  env = process.env,
  execPath = process.execPath,
  isExecutable = isExecutableFile,
} = {}) {
  const pinned = env?.[NODE_BIN_ENV];
  if (typeof pinned === 'string' && pinned.trim()) return pinned.trim();
  if (isExecutable(STABLE_NODE_BIN)) return STABLE_NODE_BIN;
  return execPath;
}

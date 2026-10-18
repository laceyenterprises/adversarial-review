import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHqRoot } from './hq-root.mjs';

// Presence is authority: malformed files and dangling symlinks also stop merges.
// Never cache this read; recovery must work without config reload or the ledger.
export function fleetStopReason({ env = process.env, lstatImpl = lstatSync } = {}) {
  try {
    const directory = join(resolveHqRoot(env), 'control', 'halt');
    for (const name of ['active.json', 'merge-kill.json']) {
      try {
        lstatImpl(join(directory, name));
        return 'fleet-stop-armed';
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return null;
  } catch {
    return 'fleet-stop-unreadable';
  }
}

import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHqRoot } from './hq-root.mjs';
import { deliverAlert, sanitizeAlertIdPrefix } from './alert-delivery.mjs';

const UNREADABLE_EVENT = sanitizeAlertIdPrefix('fleet-stop-unreadable');
const alertedCauses = new Set();
let unreadablePathClass = null;

function recordRecovery(logger) {
  if (unreadablePathClass === null) return;
  logger.info?.(`[fleet-stop] recovered from fleet-stop-unreadable: ${unreadablePathClass} is readable again`);
  unreadablePathClass = null;
}

// Presence is authority: malformed files and dangling symlinks also stop merges.
// Never cache this read; recovery must work without config reload or the ledger.
export function fleetStopReason({
  env = process.env,
  lstatImpl = lstatSync,
  deliverAlertImpl = deliverAlert,
  logger = console,
} = {}) {
  let root;
  let pathClass = 'state root';
  try {
    root = resolveHqRoot(env);
    const directory = join(root, 'control', 'halt');
    pathClass = 'halt directory';
    for (const name of ['active.json', 'merge-kill.json']) {
      try {
        lstatImpl(join(directory, name));
        recordRecovery(logger);
        return name === 'active.json' ? 'fleet-stop-active' : 'fleet-stop-merge-kill';
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    recordRecovery(logger);
    return null;
  } catch (error) {
    unreadablePathClass = pathClass;
    // Identify causes without logging paths, exception messages or file contents.
    const errorCode = /^[A-Z][A-Z0-9_]{0,39}$/u.test(error?.code) ? error.code : 'UNKNOWN';
    const cause = JSON.stringify([typeof root === 'string' ? root : null, pathClass, errorCode]);
    if (!alertedCauses.has(cause)) {
      alertedCauses.add(cause);
      const text = `fleet-stop-unreadable: cannot read ${pathClass} (${errorCode}); autonomous merges remain on hold.`;
      logger.error?.(`[fleet-stop] ERROR ${text}`);
      const deliveryFailed = () => logger.error?.('[fleet-stop] ERROR fleet-stop-unreadable operator alert delivery failed; autonomous merges remain on hold.');
      try {
        // Keep the synchronous merge predicate unchanged. deliverAlert enqueues
        // durably before its promise resolves; its drain owns transport retries.
        Promise.resolve(deliverAlertImpl(text, {
          event: UNREADABLE_EVENT,
          payload: { reason: 'fleet-stop-unreadable', pathClass, errorCode },
          env,
        })).catch(deliveryFailed);
      } catch {
        deliveryFailed();
      }
    }
    return 'fleet-stop-unreadable';
  }
}

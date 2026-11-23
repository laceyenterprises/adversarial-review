import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join } from 'node:path';

let active = false;

// The repeated watcher fixtures check poll behavior and read back atomic
// status writes. Their disposable diagnostic snapshots can omit disk flushes.
export function omitWatcherDiagnosticFlushes(root, registerCleanup) {
  const sandbox = process.env.ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT;
  if (!sandbox || dirname(root) !== sandbox || root !== process.env.ADVERSARIAL_REVIEW_TEST_CWD) {
    throw new Error('Watcher diagnostic flush fixture requires an isolated test root');
  }
  if (active) throw new Error('Watcher diagnostic flush fixture is already active');

  const tempPrefixes = new Map([
    join(root, 'data', 'argus-security-drain-status.json'),
    join(root, 'data', 'pr-lifecycle-reconcile', 'state.json'),
    join(root, 'data', 'ticket-pipeline-pauses', 'daemon-root-status.json'),
  ].map(file => [
    file, join(dirname(file), `.${basename(file)}.${process.pid}.`),
  ]));
  const prefixes = [...tempPrefixes.values()];
  const matchesTempFile = (file, prefix) => typeof file === 'string' && prefix
    && file.startsWith(prefix) && file.endsWith('.tmp');
  const { closeSync, fsyncSync, openSync, renameSync } = fs;
  const diagnosticFds = new Set();
  let renamedParent;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    active = false;
    Object.assign(fs, { closeSync, fsyncSync, openSync, renameSync });
    syncBuiltinESMExports();
  };
  const open = (file, flags, ...args) => {
    // writeFileAtomic opens the parent immediately after publishing a file.
    // Other opens of that directory still receive a real flush.
    const parentSync = flags === 'r' && file === renamedParent;
    renamedParent = undefined;
    const fd = openSync(file, flags, ...args);
    if (parentSync || (flags === 'wx' && prefixes.some(prefix => matchesTempFile(file, prefix)))) {
      diagnosticFds.add(fd);
    }
    return fd;
  };
  const rename = (source, destination) => {
    renameSync(source, destination);
    renamedParent = matchesTempFile(source, tempPrefixes.get(destination)) ? dirname(destination) : undefined;
  };
  const fsync = fd => {
    if (!diagnosticFds.has(fd)) fsyncSync(fd);
  };
  const close = fd => {
    diagnosticFds.delete(fd);
    return closeSync(fd);
  };
  active = true;
  try {
    registerCleanup(restore);
    if (restored) return;
    Object.assign(fs, { closeSync: close, fsyncSync: fsync, openSync: open, renameSync: rename });
    syncBuiltinESMExports();
  } catch (error) {
    restore();
    throw error;
  }
}

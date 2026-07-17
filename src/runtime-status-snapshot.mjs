// Runtime status snapshot (ARC-09, Win 1). The `runtime status` CLI runs in a
// DIFFERENT process from the watcher daemon that owns the live health router,
// so it cannot read the router's in-memory probe/mode state directly. The
// router-owning loop persists `router.status()` here each probe tick; the CLI
// reads the last snapshot for the live "mode/since/probe" lines and folds in the
// durable audit trail + canary file + run ledger for the rest.
//
// This is the intended consumer of ARC-07's exported `router.status()`
// introspection seam — no router internals are touched. A stale or absent
// snapshot degrades gracefully in the renderer (probe shown as "unknown").

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';
import { assertCanonicalOwner } from './adapters/agent-runtime/append-only-owner.mjs';

const SNAPSHOT_SCHEMA_VERSION = 1;
const SNAPSHOT_FILE = ['data', 'runtime-status-snapshot.json'];

function runtimeStatusSnapshotPath(rootDir) {
  return join(rootDir, ...SNAPSHOT_FILE);
}

// Persist a router status snapshot. `status` is the object returned by
// `router.status()` (ARC-07). `capturedAt` lets the CLI report snapshot
// staleness independent of the fields inside `status`.
function writeRuntimeStatusSnapshot(rootDir, status, { now = () => new Date(), ownerGuardOptions } = {}) {
  const snapshot = {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    capturedAt: now().toISOString(),
    status: status ?? null,
  };
  assertCanonicalOwner(rootDir, runtimeStatusSnapshotPath(rootDir), ownerGuardOptions);
  writeFileAtomic(
    runtimeStatusSnapshotPath(rootDir),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    { overwrite: true },
  );
  return snapshot;
}

function readRuntimeStatusSnapshot(rootDir) {
  try {
    const parsed = JSON.parse(readFileSync(runtimeStatusSnapshotPath(rootDir), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    // A corrupt snapshot must not crash the read-only status CLI.
    return null;
  }
}

// Convenience for a router-owning loop: capture and persist in one call.
function persistRouterStatus(rootDir, router, { now = () => new Date(), ownerGuardOptions } = {}) {
  if (!router || typeof router.status !== 'function') {
    throw new TypeError('persistRouterStatus requires a router exposing status()');
  }
  return writeRuntimeStatusSnapshot(rootDir, router.status(), { now, ownerGuardOptions });
}

export {
  SNAPSHOT_SCHEMA_VERSION,
  persistRouterStatus,
  readRuntimeStatusSnapshot,
  runtimeStatusSnapshotPath,
  writeRuntimeStatusSnapshot,
};

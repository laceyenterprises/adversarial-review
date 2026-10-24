import { lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

export const SANDBOX_OWNER_MARKER = '.runner-owner.json';
export const ABANDONED_SANDBOX_MIN_AGE_MS = 24 * 60 * 60 * 1_000;

// Absence is the only safe answer that permits reclamation. PID reuse, EPERM,
// missing markers and unreadable metadata all retain the directory.
export function reclaimAbandonedSandboxes(tempBase, {
  now = Date.now(), uid = process.getuid?.(), kill = process.kill, remove = rmSync,
} = {}) {
  const result = { reclaimed: 0, failed: 0 };
  if (uid === undefined) return result;
  let entries;
  try {
    entries = readdirSync(tempBase, { withFileTypes: true });
  } catch {
    // Reclamation is best-effort, including when the parent cannot be listed.
    return result;
  }
  for (const entry of entries) {
    if (!entry.name.startsWith('art-') || !entry.isDirectory()) continue;
    const root = path.join(tempBase, entry.name);
    try {
      const directory = lstatSync(root);
      if (!directory.isDirectory() || directory.uid !== uid) continue;
      const markerPath = path.join(root, SANDBOX_OWNER_MARKER);
      const marker = lstatSync(markerPath);
      if (!marker.isFile() || marker.uid !== uid) continue;
      if (now - Math.max(directory.mtimeMs, marker.mtimeMs) < ABANDONED_SANDBOX_MIN_AGE_MS) continue;
      const owner = JSON.parse(readFileSync(markerPath, 'utf8'));
      // PID-only markers predate group tracking or were left before spawn
      // completed. Neither proves that an orphaned test group is absent.
      if (owner?.version !== 1 || ![owner.pid, owner.group].every((pid) => Number.isSafeInteger(pid) && pid > 0)) continue;
      const absent = [owner.pid, -owner.group].every((pid) => {
        try { kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
      });
      if (!absent) continue;
      // Another runner may already have reclaimed this entry. Never remove a
      // replacement directory or a changed marker after inspecting its owner.
      const current = lstatSync(root);
      const currentMarker = lstatSync(markerPath);
      if (current.dev !== directory.dev || current.ino !== directory.ino
          || currentMarker.dev !== marker.dev || currentMarker.ino !== marker.ino
          || currentMarker.mtimeMs !== marker.mtimeMs) continue;
      try {
        remove(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        result.reclaimed += 1;
      } catch {
        result.failed += 1;
      }
    } catch {
      // Shared temp directories can disappear or become inaccessible while
      // scanning. Failed cleanup must not prevent an isolated test run.
    }
  }
  return result;
}

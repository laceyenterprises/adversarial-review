import { lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

export const SANDBOX_OWNER_MARKER = '.runner-owner.json';
export const ABANDONED_SANDBOX_MIN_AGE_MS = 24 * 60 * 60 * 1_000;

// Absence is the only safe answer that permits reclamation. PID reuse, EPERM,
// missing markers and unreadable metadata all retain the directory.
export function reclaimAbandonedSandboxes(tempBase, {
  now = Date.now(), uid = process.getuid?.(), kill = process.kill,
} = {}) {
  if (uid === undefined) return 0;
  let entries;
  try {
    entries = readdirSync(tempBase, { withFileTypes: true });
  } catch {
    // Reclamation is best-effort, including when the parent cannot be listed.
    return 0;
  }
  let reclaimed = 0;
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
      if (owner?.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) continue;
      try {
        kill(owner.pid, 0);
        continue;
      } catch (error) {
        if (error.code !== 'ESRCH') continue;
      }
      // Another runner may already have reclaimed this entry. Never remove a
      // replacement directory or a changed marker after inspecting its owner.
      const current = lstatSync(root);
      const currentMarker = lstatSync(markerPath);
      if (current.dev !== directory.dev || current.ino !== directory.ino
          || currentMarker.dev !== marker.dev || currentMarker.ino !== marker.ino
          || currentMarker.mtimeMs !== marker.mtimeMs) continue;
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      reclaimed += 1;
    } catch {
      // Shared temp directories can disappear or become inaccessible while
      // scanning. Failed cleanup must not prevent an isolated test run.
    }
  }
  return reclaimed;
}

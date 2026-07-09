import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export const HANDOFF_WAKE_DIR_MODE = 0o775;
export const HANDOFF_WAKE_MARKER_MODE = 0o664;
export const HANDOFF_WAKE_DAEMONS = Object.freeze({
  followUp: 'follow-up',
  watcher: 'watcher',
});

function sanitizeDaemonName(daemon) {
  const name = String(daemon || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new Error(`invalid handoff wake daemon name: ${daemon}`);
  }
  return name;
}

export function resolveHandoffWakeDir(rootDir) {
  return join(rootDir, 'data', 'handoff-wake');
}

export function ensureHandoffWakeDir(rootDir) {
  const dir = resolveHandoffWakeDir(rootDir);
  mkdirSync(dir, { recursive: true, mode: HANDOFF_WAKE_DIR_MODE });
  try {
    chmodSync(dir, HANDOFF_WAKE_DIR_MODE);
  } catch {
    // chmod may be refused on a shared service directory. The listener/writer
    // paths still handle permission failures as missed wakes; the timer remains
    // the correctness fallback.
  }
  return dir;
}

function markerPrefix(daemon) {
  return `${sanitizeDaemonName(daemon)}.`;
}

function markerPath(rootDir, daemon, nowMs = Date.now(), pid = process.pid) {
  const nonce = `${nowMs}.${pid}.${Math.random().toString(36).slice(2)}`;
  return join(ensureHandoffWakeDir(rootDir), `${markerPrefix(daemon)}${nonce}.wake`);
}

function cleanupDaemonMarkers(dir, daemon, { olderThanMs = Infinity } = {}) {
  const prefix = markerPrefix(daemon);
  let removed = 0;
  let failed = 0;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { removed, failed: failed + 1 };
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
    const path = join(dir, entry.name);
    try {
      const st = statSync(path);
      if (Number.isFinite(olderThanMs) && st.mtimeMs > olderThanMs) continue;
      rmSync(path, { force: true });
      removed += 1;
    } catch {
      // Cross-user cleanup must never make the loop fail. With the documented
      // shared service group and 0775 wake directory, unlink is authorized by
      // directory permissions rather than marker ownership; if a host is not
      // provisioned that way, stale markers are ignored by mtime and the timer
      // remains the fallback.
      failed += 1;
    }
  }
  return { removed, failed };
}

export function signalHandoffWake(rootDir, daemon, { nowMs = Date.now() } = {}) {
  const finalPath = markerPath(rootDir, daemon, nowMs);
  const tmpPath = `${finalPath}.tmp`;
  try {
    const fd = openSync(tmpPath, 'wx', HANDOFF_WAKE_MARKER_MODE);
    try {
      writeFileSync(fd, `${new Date(nowMs).toISOString()}\n`);
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(tmpPath, HANDOFF_WAKE_MARKER_MODE);
    } catch {
      // Best effort; file creation mode plus service umask normally handles it.
    }
    renameSync(tmpPath, finalPath);
    return { signaled: true, path: finalPath };
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Nothing useful to do here; signaling is intentionally best-effort.
    }
    return { signaled: false, error: err };
  }
}

export function inspectHandoffWakePermissions(rootDir) {
  const dir = ensureHandoffWakeDir(rootDir);
  const marker = markerPath(rootDir, 'permission-probe');
  try {
    const fd = openSync(marker, 'w', HANDOFF_WAKE_MARKER_MODE);
    closeSync(fd);
    try {
      chmodSync(marker, HANDOFF_WAKE_MARKER_MODE);
    } catch {
      // Report the actual mode below.
    }
    const dirMode = statSync(dir).mode & 0o777;
    const markerMode = statSync(marker).mode & 0o777;
    rmSync(marker, { force: true });
    return {
      dir,
      dirMode,
      markerMode,
      expectedDirMode: HANDOFF_WAKE_DIR_MODE,
      expectedMarkerMode: HANDOFF_WAKE_MARKER_MODE,
    };
  } finally {
    try {
      rmSync(marker, { force: true });
    } catch {
      // Best effort.
    }
  }
}

export async function sleepUntilTimerOrHandoffWake(
  rootDir,
  daemon,
  delayMs,
  {
    enabled = false,
    signal = null,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    watchImpl = watch,
    nowMs = () => Date.now(),
  } = {},
) {
  if (!enabled) {
    return new Promise((resolve, _reject) => {
      let settled = false;
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeoutImpl(timeout);
        signal?.removeEventListener?.('abort', onAbort);
        fn(value);
      };
      const onAbort = () => done(resolve, { reason: 'abort' });
      const timeout = setTimeoutImpl(() => done(resolve, { reason: 'timer' }), delayMs);
      if (signal?.aborted) {
        done(resolve, { reason: 'abort' });
      } else {
        signal?.addEventListener?.('abort', onAbort, { once: true });
      }
    });
  }

  const dir = ensureHandoffWakeDir(rootDir);
  const startMs = nowMs();
  cleanupDaemonMarkers(dir, daemon, { olderThanMs: startMs - 1 });

  return new Promise((resolve, reject) => {
    let settled = false;
    let watcher = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeoutImpl(timeout);
      signal?.removeEventListener?.('abort', onAbort);
      try {
        watcher?.close?.();
      } catch {
        // Closing a native watcher is best-effort during process shutdown.
      }
      if (result.reason === 'wake') {
        cleanupDaemonMarkers(dir, daemon, { olderThanMs: Infinity });
      }
      resolve(result);
    };
    const onAbort = () => finish({ reason: 'abort' });
    const onWatchEvent = (_eventType, filename) => {
      if (settled || !filename || !String(filename).startsWith(markerPrefix(daemon))) return;
      const path = join(dir, String(filename));
      try {
        if (!existsSync(path)) return;
        const st = statSync(path);
        if (st.mtimeMs + 1 < startMs) return;
      } catch {
        return;
      }
      finish({ reason: 'wake', path });
    };
    const timeout = setTimeoutImpl(() => finish({ reason: 'timer' }), delayMs);
    try {
      watcher = watchImpl(dir, { persistent: true }, onWatchEvent);
      watcher.on?.('error', (err) => {
        if (!settled) reject(err);
      });
    } catch (err) {
      clearTimeoutImpl(timeout);
      signal?.removeEventListener?.('abort', onAbort);
      reject(err);
      return;
    }
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener?.('abort', onAbort, { once: true });
    }
  });
}

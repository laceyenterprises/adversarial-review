import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { normalizeHandoffMaxPerPrHead } from './handoff-rate-cap.mjs';
import { HANDOFF_EVENTS, recordHandoffEvent, recordHandoffWakeEvents } from './handoff-telemetry.mjs';

export const HANDOFF_WAKE_DIR_MODE = 0o775;
export const HANDOFF_WAKE_MARKER_MODE = 0o664;
export const HANDOFF_WAKE_DAEMONS = Object.freeze({
  followUp: 'follow-up',
  watcher: 'watcher',
});

const OWNER_SIGNAL_SCRIPT = `
import { chmodSync, closeSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const signalArgs = process.argv[1] === '[eval]' ? process.argv.slice(2) : process.argv.slice(1);
const [rootDir, daemon, nowRaw, pidRaw, payloadRaw] = signalArgs;
const name = String(daemon || '').trim();
if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(\`invalid handoff wake daemon name: \${daemon}\`);
const dir = join(rootDir, 'data', 'handoff-wake');
mkdirSync(dir, { recursive: true, mode: 0o775 });
try { chmodSync(dir, 0o775); } catch {}
const nowMs = Number(nowRaw);
const nonce = \`\${nowMs}.\${pidRaw}.\${Math.random().toString(36).slice(2)}\`;
const finalPath = join(dir, \`\${name}.\${nonce}.wake\`);
const tmpPath = \`\${finalPath}.tmp\`;
try {
  const fd = openSync(tmpPath, 'wx', 0o664);
  try {
    let payload = null;
    try {
      payload = payloadRaw ? JSON.parse(payloadRaw) : null;
    } catch {}
    writeFileSync(fd, \`\${JSON.stringify(payload || {
      schema_version: 1,
      requested_at: new Date(nowMs).toISOString(),
    }, null, 2)}\\n\`);
  } finally {
    closeSync(fd);
  }
  try { chmodSync(tmpPath, 0o664); } catch {}
  renameSync(tmpPath, finalPath);
  process.stdout.write(finalPath);
} catch (err) {
  try { rmSync(tmpPath, { force: true }); } catch {}
  throw err;
}
`;

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

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function resolveCanonicalOwnerUid(rootDir) {
  const dir = resolveHandoffWakeDir(rootDir);
  try {
    return statSync(dir).uid;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  try {
    return statSync(join(rootDir, 'data')).uid;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  return statSync(rootDir).uid;
}

function resolveUsernameForUid(uid, { spawnSyncImpl = spawnSync } = {}) {
  const result = spawnSyncImpl('id', ['-un', String(uid)], { encoding: 'utf8' });
  if (result?.status !== 0) {
    const detail = String(result?.stderr || result?.error?.message || '').trim();
    throw new Error(`failed to resolve canonical handoff wake owner uid ${uid}${detail ? `: ${detail}` : ''}`);
  }
  const username = String(result.stdout || '').trim();
  if (!username) throw new Error(`failed to resolve canonical handoff wake owner uid ${uid}: empty username`);
  return username;
}

function isWakeMarkerName(filename, daemon) {
  const name = String(filename || '');
  return name.startsWith(markerPrefix(daemon)) && name.endsWith('.wake');
}

function markerPathInDir(dir, daemon, nowMs = Date.now(), pid = process.pid) {
  const nonce = `${nowMs}.${pid}.${Math.random().toString(36).slice(2)}`;
  return join(dir, `${markerPrefix(daemon)}${nonce}.wake`);
}

function buildWakeMarkerPayload({ nowMs, reason = null, repo = null, prNumber = null, headSha = null } = {}) {
  return {
    schema_version: 1,
    requested_at: new Date(nowMs).toISOString(),
    ...(reason ? { reason } : {}),
    ...(repo ? { repo } : {}),
    ...(prNumber ? { pr_number: prNumber } : {}),
    ...(headSha ? { head_sha: headSha } : {}),
  };
}

function readWakeMarkerPayload(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeHandoffWakeMarkerNative(rootDir, daemon, nowMs, payload = null) {
  const dir = ensureHandoffWakeDir(rootDir);
  const finalPath = markerPathInDir(dir, daemon, nowMs);
  const tmpPath = `${finalPath}.tmp`;
  try {
    const fd = openSync(tmpPath, 'wx', HANDOFF_WAKE_MARKER_MODE);
    try {
      const markerPayload = payload || buildWakeMarkerPayload({ nowMs });
      writeFileSync(fd, `${JSON.stringify(markerPayload, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(tmpPath, HANDOFF_WAKE_MARKER_MODE);
    } catch {
      // Best effort; file creation mode plus service umask normally handles it.
    }
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Nothing useful to do here; signaling is intentionally best-effort.
    }
    throw err;
  }
  return { finalPath, tmpPath };
}

function signalHandoffWakeAsOwner(rootDir, daemon, nowMs, ownerUid, payload, { spawnSyncImpl = spawnSync } = {}) {
  const ownerUser = resolveUsernameForUid(ownerUid, { spawnSyncImpl });
  const result = spawnSyncImpl(
    'sudo',
    [
      '-A',
      '-H',
      '-u',
      ownerUser,
      process.execPath,
      '--input-type=module',
      '-e',
      OWNER_SIGNAL_SCRIPT,
      rootDir,
      sanitizeDaemonName(daemon),
      String(nowMs),
      String(process.pid),
      JSON.stringify(payload || buildWakeMarkerPayload({ nowMs })),
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  if (result?.status !== 0) {
    const detail = String(result?.stderr || result?.error?.message || '').trim();
    throw new Error(`handoff wake owner signal failed for ${ownerUser}${detail ? `: ${detail}` : ''}`);
  }
  return { signaled: true, path: String(result.stdout || '').trim() || null, ownerUser };
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
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.wake')) continue;
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

export function signalHandoffWake(
  rootDir,
  daemon,
  {
    nowMs = Date.now(),
    spawnSyncImpl = spawnSync,
    currentUidImpl = currentUid,
    reason = null,
    repo = null,
    prNumber = null,
    headSha = null,
    revisionRef = null,
  } = {},
) {
  let tmpPath = null;
  try {
    sanitizeDaemonName(daemon);
    const payload = buildWakeMarkerPayload({
      nowMs,
      reason,
      repo,
      prNumber,
      headSha: headSha || revisionRef,
    });
    const ownerUid = resolveCanonicalOwnerUid(rootDir);
    const uid = currentUidImpl();
    if (uid !== null && uid !== ownerUid) {
      return signalHandoffWakeAsOwner(rootDir, daemon, nowMs, ownerUid, payload, { spawnSyncImpl });
    }
    const { finalPath, tmpPath: nativeTmpPath } = writeHandoffWakeMarkerNative(rootDir, daemon, nowMs, payload);
    tmpPath = nativeTmpPath;
    return { signaled: true, path: finalPath };
  } catch (err) {
    if (tmpPath) {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        // Nothing useful to do here; signaling is intentionally best-effort.
      }
    }
    return { signaled: false, error: err };
  }
}

export function inspectHandoffWakePermissions(rootDir) {
  const dir = ensureHandoffWakeDir(rootDir);
  const marker = markerPathInDir(dir, 'permission-probe');
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

function makeAbortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
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
    shouldAcceptWake = null,
    recordHandoffWakeEventsImpl = recordHandoffWakeEvents,
    recordHandoffEventImpl = recordHandoffEvent,
  } = {},
) {
  if (!enabled) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeoutImpl(timeout);
        signal?.removeEventListener?.('abort', onAbort);
        fn(value);
      };
      const onAbort = () => done(reject, makeAbortError());
      const timeout = setTimeoutImpl(() => done(resolve, { reason: 'timer' }), delayMs);
      if (signal?.aborted) {
        done(reject, makeAbortError());
      } else {
        signal?.addEventListener?.('abort', onAbort, { once: true });
      }
    });
  }

  return new Promise((resolve, reject) => {
    let dir = null;
    const startMs = nowMs();
    let settled = false;
    let watcher = null;
    const recordFallbackTickCatch = () => {
      if (!dir) return;
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isFile() || !isWakeMarkerName(entry.name, daemon)) continue;
          const path = join(dir, entry.name);
          const payload = readWakeMarkerPayload(path) || {};
          recordHandoffEventImpl({
            rootDir,
            event: HANDOFF_EVENTS.fallbackTickCatch,
            at: new Date(nowMs()).toISOString(),
            step: payload.reason || null,
            repo: payload.repo || null,
            prNumber: payload.pr_number ?? payload.prNumber ?? null,
            headSha: payload.head_sha ?? payload.headSha ?? null,
            target: daemon,
            reason: 'timer',
          });
        }
      } catch {
        // Telemetry is best-effort; the timer remains the correctness path.
      }
    };
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
        try {
          recordHandoffWakeEventsImpl({
            rootDir,
            payload: result.payload || {},
            target: daemon,
            wokeAt: new Date(nowMs()).toISOString(),
          });
        } catch {
          // Handoff telemetry must never break the wake path.
        }
      } else if (result.reason === 'timer') {
        recordFallbackTickCatch();
      }
      if (result.reason === 'wake' && dir) {
        cleanupDaemonMarkers(dir, daemon, { olderThanMs: Infinity });
      }
      resolve(result);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeoutImpl(timeout);
      signal?.removeEventListener?.('abort', onAbort);
      try {
        watcher?.close?.();
      } catch {
        // Closing a native watcher is best-effort during process shutdown.
      }
      reject(makeAbortError());
    };
    const onWatchEvent = (_eventType, filename) => {
      if (settled || !filename || !isWakeMarkerName(filename, daemon)) return;
      const path = join(dir, String(filename));
      try {
        if (!existsSync(path)) return;
      } catch {
        return;
      }
      const payload = readWakeMarkerPayload(path);
      if (typeof shouldAcceptWake === 'function') {
        const accepted = shouldAcceptWake({ path, payload });
        if (accepted === false) {
          try {
            rmSync(path, { force: true });
          } catch {
            // Best effort. A dropped wake must not break the timer fallback.
          }
          return;
        }
      }
      finish({ reason: 'wake', path, payload });
    };
    const timeout = setTimeoutImpl(() => finish({ reason: 'timer' }), delayMs);
    try {
      dir = ensureHandoffWakeDir(rootDir);
      cleanupDaemonMarkers(dir, daemon, { olderThanMs: startMs - 1 });
      watcher = watchImpl(dir, { persistent: true }, onWatchEvent);
      watcher.on?.('error', () => {
        try {
          watcher?.close?.();
        } catch {
          // The timer remains the correctness fallback after watcher failure.
        }
        watcher = null;
      });
    } catch {
      // Directory setup and watcher initialization are best-effort. Keep the
      // scheduled timer active so the daemon loop degrades to its fallback.
      dir = null;
      watcher = null;
    }
    if (dir) {
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isFile() || !isWakeMarkerName(entry.name, daemon)) continue;
          onWatchEvent('rename', entry.name);
          if (settled) break;
        }
      } catch {
        // A failed sweep is equivalent to a missed handoff; the timer remains.
      }
    }
    if (settled) {
      return;
    }
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener?.('abort', onAbort, { once: true });
    }
  });
}

export const FOLLOW_UP_DAEMON_WAKE_TARGET = HANDOFF_WAKE_DAEMONS.followUp;
export const WATCHER_WAKE_TARGET = HANDOFF_WAKE_DAEMONS.watcher;

export function signalFollowUpDaemonWake({ rootDir, ...options } = {}) {
  const result = signalHandoffWake(rootDir, FOLLOW_UP_DAEMON_WAKE_TARGET, options);
  return {
    ...result,
    target: FOLLOW_UP_DAEMON_WAKE_TARGET,
    wakePath: result.path,
  };
}

export async function waitForHandoffWake({
  rootDir,
  target,
  timeoutMs,
  signal = null,
} = {}) {
  const result = await sleepUntilTimerOrHandoffWake(rootDir, target, timeoutMs, {
    enabled: true,
    signal,
  });
  return {
    woke: result.reason === 'wake',
    target,
    wakePath: result.path,
    reason: result.reason === 'timer' ? 'timeout' : result.reason,
  };
}

export function resolveHandoffConfig({ getConfigImpl } = {}) {
  const getConfig = typeof getConfigImpl === 'function' ? getConfigImpl : null;
  const read = (key, fallback) => (getConfig ? getConfig(key, fallback) : fallback);
  return {
    enabled: Boolean(read('roles.adversarial.handoff.enabled', false)),
    reviewToRemediation: Boolean(read('roles.adversarial.handoff.review_to_remediation', false)),
    remediationToRereview: Boolean(read('roles.adversarial.handoff.remediation_to_rereview', false)),
    finalToHammer: Boolean(read('roles.adversarial.handoff.final_to_hammer', false)),
    maxPerPrHead: normalizeHandoffMaxPerPrHead(read('roles.adversarial.handoff.max_per_pr_head', 20)),
  };
}

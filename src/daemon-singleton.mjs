import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import fsExt from 'fs-ext';
import { resolveAdversarialReviewStateDir } from './reviewer-fence.mjs';

const {
  flockSync,
  constants: {
    LOCK_EX,
    LOCK_NB,
    LOCK_UN,
  },
} = fsExt;

const DAEMON_SINGLETON_SCHEMA_VERSION = 1;
const DAEMON_SINGLETON_DIR_NAME = 'daemon-singletons';
const DAEMON_SINGLETON_HELD_CODE = 'ADVERSARIAL_DAEMON_SINGLETON_HELD';
const DAEMON_SINGLETON_OWNER_MISMATCH_CODE = 'ADVERSARIAL_DAEMON_SINGLETON_OWNER_MISMATCH';

class DaemonSingletonLockHeldError extends Error {
  constructor({ daemonName, lockPath, holder }) {
    const holderText = formatDaemonSingletonHolder(holder);
    super(
      `${daemonName} daemon singleton is already held at ${lockPath}` +
      (holderText ? ` (${holderText})` : '')
    );
    this.name = 'DaemonSingletonLockHeldError';
    this.code = DAEMON_SINGLETON_HELD_CODE;
    this.daemonName = daemonName;
    this.lockPath = lockPath;
    this.holder = holder;
  }
}

function normalizeDaemonName(daemonName) {
  const normalized = String(daemonName || '').trim();
  if (!/^[a-z0-9._-]+$/i.test(normalized)) {
    throw new Error(`invalid daemon singleton name: ${JSON.stringify(daemonName)}`);
  }
  return normalized;
}

function currentProcessUid(getUidImpl = process.getuid) {
  if (typeof getUidImpl !== 'function') return null;
  const uid = Number(getUidImpl());
  return Number.isInteger(uid) && uid >= 0 ? uid : null;
}

function nearestExistingPath(path, { existsSyncImpl = existsSync } = {}) {
  let current = path;
  while (current && !existsSyncImpl(current)) {
    const parent = dirname(current);
    if (parent === current) return parent;
    current = parent;
  }
  return current || path;
}

function assertDaemonSingletonOwnerCompatible(
  path,
  {
    getUidImpl = process.getuid,
    existsSyncImpl = existsSync,
    statSyncImpl = statSync,
  } = {}
) {
  const uid = currentProcessUid(getUidImpl);
  if (uid === null) return { checked: false, reason: 'uid-unavailable' };

  const ownerPath = nearestExistingPath(path, { existsSyncImpl });
  const stat = statSyncImpl(ownerPath);
  if (Number(stat.uid) !== uid) {
    const err = new Error(
      `refusing daemon singleton write under ${path}: ${ownerPath} is owned by uid ${stat.uid}, ` +
      `but current process uid is ${uid}`
    );
    err.code = DAEMON_SINGLETON_OWNER_MISMATCH_CODE;
    err.path = path;
    err.ownerPath = ownerPath;
    err.ownerUid = stat.uid;
    err.processUid = uid;
    throw err;
  }
  return { checked: true, ownerPath, uid };
}

function resolveDaemonSingletonDir(rootDir, env = process.env) {
  const stateDir = resolveAdversarialReviewStateDir(rootDir, env);
  assertDaemonSingletonOwnerCompatible(stateDir);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lockDir = join(stateDir, DAEMON_SINGLETON_DIR_NAME);
  assertDaemonSingletonOwnerCompatible(lockDir);
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  assertDaemonSingletonOwnerCompatible(lockDir);
  return lockDir;
}

function resolveDaemonSingletonLockPath({ rootDir, daemonName, env = process.env }) {
  const normalizedName = normalizeDaemonName(daemonName);
  return join(resolveDaemonSingletonDir(rootDir, env), `${normalizedName}.lock`);
}

function buildDaemonSingletonRecord({
  daemonName,
  pid = process.pid,
  ppid = process.ppid,
  argv = process.argv,
  startedAt = new Date().toISOString(),
  host = hostname(),
} = {}) {
  return {
    schemaVersion: DAEMON_SINGLETON_SCHEMA_VERSION,
    daemonName: normalizeDaemonName(daemonName),
    pid,
    ppid,
    host,
    startedAt,
    command: Array.isArray(argv) ? argv.join(' ') : String(argv || ''),
  };
}

function readDaemonSingletonHolder(lockPath) {
  try {
    if (!existsSync(lockPath)) return null;
    const raw = readFileSync(lockPath, 'utf8').trim();
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function formatDaemonSingletonHolder(holder) {
  if (!holder || typeof holder !== 'object') return '';
  const parts = [];
  if (holder.pid) parts.push(`pid=${holder.pid}`);
  if (holder.ppid) parts.push(`ppid=${holder.ppid}`);
  if (holder.host) parts.push(`host=${holder.host}`);
  if (holder.startedAt) parts.push(`startedAt=${holder.startedAt}`);
  if (holder.command) parts.push(`command=${holder.command}`);
  return parts.join(' ');
}

function writeDaemonSingletonRecord(fd, record) {
  ftruncateSync(fd, 0);
  writeSync(fd, `${JSON.stringify(record, null, 2)}\n`, 0, 'utf8');
  fsyncSync(fd);
}

function acquireDaemonSingleton({
  rootDir,
  daemonName,
  env = process.env,
  argv = process.argv,
  startedAt = new Date().toISOString(),
  logger = console,
} = {}) {
  const normalizedName = normalizeDaemonName(daemonName);
  const lockPath = resolveDaemonSingletonLockPath({ rootDir, daemonName: normalizedName, env });
  const fd = openSync(lockPath, 'a+', 0o600);
  try {
    flockSync(fd, LOCK_EX | LOCK_NB);
  } catch (err) {
    closeSync(fd);
    const holder = readDaemonSingletonHolder(lockPath);
    if (err?.code === 'EWOULDBLOCK' || err?.code === 'EAGAIN') {
      throw new DaemonSingletonLockHeldError({ daemonName: normalizedName, lockPath, holder });
    }
    throw err;
  }

  const record = buildDaemonSingletonRecord({
    daemonName: normalizedName,
    argv,
    startedAt,
  });
  writeDaemonSingletonRecord(fd, record);
  logger?.log?.(`daemon singleton acquired name=${normalizedName} lock=${lockPath} pid=${record.pid}`);

  let released = false;
  function release() {
    if (released) return;
    released = true;
    try {
      flockSync(fd, LOCK_UN);
    } catch {}
    try {
      closeSync(fd);
    } catch {}
  }

  return {
    lockPath,
    record,
    release,
  };
}

export {
  DAEMON_SINGLETON_HELD_CODE,
  DAEMON_SINGLETON_OWNER_MISMATCH_CODE,
  DAEMON_SINGLETON_SCHEMA_VERSION,
  DaemonSingletonLockHeldError,
  acquireDaemonSingleton,
  assertDaemonSingletonOwnerCompatible,
  buildDaemonSingletonRecord,
  formatDaemonSingletonHolder,
  readDaemonSingletonHolder,
  resolveDaemonSingletonDir,
  resolveDaemonSingletonLockPath,
};

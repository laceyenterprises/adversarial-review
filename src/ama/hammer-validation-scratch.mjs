import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOCKET_PATH_HARNESS_FAULT } from '../harness-fault.mjs';

const PREFIX = 'ar-hv-';
const NAME = /^ar-hv-[a-f0-9]{8}$/;
const OWNER = '.validator-pid';
const MAX_SOCKET_BYTES = 92;
// The longest observed fixture uses 52 suffix bytes. Reserve 64 for nested
// temp fixtures, leaving at least 12 bytes below Darwin's 104-byte sun_path.
// The canonical Darwin root /private/tmp/ar-hv-xxxxxxxx is 27 bytes.
// With the suffix it uses 91 of the 92 budgeted bytes, one byte of margin.
const SOCKET_SUFFIX_BYTES = 64;
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
const REAP_INTERVAL_MS = 60 * 60 * 1000;

export function assertValidationSocketBudget(root) {
  const bytes = Buffer.byteLength(root) + SOCKET_SUFFIX_BYTES;
  if (bytes > MAX_SOCKET_BYTES) {
    throw new Error(`${SOCKET_PATH_HARNESS_FAULT}: temp root ${root} and fixture suffix need ${bytes} bytes (budget ${MAX_SOCKET_BYTES})`);
  }
}

export function validationScratchEnv(env, root) {
  const result = { ...env, TMPDIR: root, TMP: root, TEMP: root };
  // Replace the closer's fixed pytest basetemp while preserving caller flags.
  if (env.HAM_RUN_DIR && env.PYTEST_ADDOPTS) {
    const path = join(root, 'p');
    const quotedPath = /[\s'"\\]/.test(path) ? `'${path.replaceAll("'", "'\\''")}'` : path;
    result.PYTEST_ADDOPTS = env.PYTEST_ADDOPTS.replace(
      /(^|\s)--basetemp=(?:"(?:\\.|[^"\\])*"|'[^']*'|\S+)/g,
      (_option, space) => `${space}--basetemp=${quotedPath}`);
  }
  return result;
}

function validatorAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function readOwner(path) {
  const file = await open(join(path, OWNER), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 10) return '';
    const buffer = Buffer.alloc(11);
    const { bytesRead } = await file.read(buffer);
    return buffer.toString('utf8', 0, bytesRead);
  } finally { await file.close(); }
}

async function orphanCandidate(path, now) {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700
      || now - Math.max(stat.mtimeMs, stat.birthtimeMs) < ORPHAN_GRACE_MS) return null;
    let owner;
    try { owner = await readOwner(path); }
    catch (error) { if (error.code !== 'ENOENT') return null; }
    if (owner !== undefined && (!/^[1-9]\d{0,9}$/.test(owner) || validatorAlive(Number(owner)))) return null;
    return stat;
  } catch { return null; }
}

async function readProcessSnapshot() {
  const { readHammerScratchProcessSnapshot } = await import('./hammer-scratch-sweep.mjs');
  return readHammerScratchProcessSnapshot({ timeout: 3000, logger: {} });
}

async function claimReapInterval(base, now) {
  const uid = process.getuid();
  const { default: fsExt } = await import('fs-ext');
  const marker = await open(join(base, `.ar-hv-reap-${uid}`),
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = await marker.stat();
    if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) return false;
    try { fsExt.flockSync(marker.fd, 'exnb'); }
    catch (error) {
      if (['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) return false;
      throw error;
    }
    // A fresh marker is empty. Checkpoint before scanning so a failed census
    // or an interrupted validator still gives other launches a cooldown.
    const last = await marker.stat();
    if (last.size && now - last.mtimeMs < REAP_INTERVAL_MS) return false;
    await marker.write('1', 0);
    await marker.utimes(now / 1000, now / 1000);
    return true;
  } finally { await marker.close(); }
}

export async function reapValidationScratch(base, { now = Date.now(), snapshot = readProcessSnapshot } = {}) {
  if (!await claimReapInterval(base, now)) return;
  const candidates = new Map();
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || !NAME.test(entry.name)) continue;
    const path = join(base, entry.name);
    const stat = await orphanCandidate(path, now);
    if (stat) candidates.set(path, stat);
  }
  if (!candidates.size) return;
  const { ps, lsof, cwdTimedOut } = await snapshot();
  if (cwdTimedOut || !ps?.trim() || !lsof?.trim()) return;
  for (const [path, before] of candidates) {
    if (ps.includes(path) || lsof.includes(path)) continue;
    const after = await orphanCandidate(path, now);
    if (after?.ino === before.ino && after.dev === before.dev) {
      await rm(path, { recursive: true, force: true });
    }
  }
}

async function createScratchIn(base) {
  // On Darwin /tmp resolves to /private/tmp. Pass the real spelling to tools
  // that canonicalize paths before binding sockets or resolving imports.
  const parent = await realpath(base);
  assertValidationSocketBudget(join(parent, `${PREFIX}00000000`));
  for (;;) {
    const path = join(parent, PREFIX + randomBytes(4).toString('hex'));
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    try {
      await chmod(path, 0o700);
      await writeFile(join(path, OWNER), String(process.pid), { mode: 0o600, flag: 'wx' });
      return path;
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      throw error;
    }
  }
}

export async function createValidationScratch(base = '/tmp') {
  try { return await createScratchIn(base); }
  catch (error) {
    const fallback = tmpdir();
    if (fallback === base || !['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ERR_ACCESS_DENIED'].includes(error.code)) {
      throw error;
    }
    return createScratchIn(fallback);
  }
}

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';

// One file per digest avoids lost updates from concurrent token refreshers.
// Only broker-verified identities enter this cache; raw tokens never do.
const MAX_BINDING_AGE_MS = 60 * 60_000;
const DIGEST = /^[a-f0-9]{24}$/;
const INSTALLATION = /^installation-\d+-\d+$/;
const PARSED_BINDING_TTL_MS = 1000;
const parsedBindings = new Map();

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function ownedDirectory(directory, uid) {
  const stat = lstatSync(directory);
  return stat.isDirectory() && (!Number.isInteger(uid) || stat.uid === uid)
    && (stat.mode & 0o022) === 0;
}

export function readBudgetBinding(directory, digest, now = Date.now(), {
  uid = currentUid(), fstatSyncImpl = fstatSync, readFileSyncImpl = readFileSync,
} = {}) {
  if (!DIGEST.test(digest)) return null;
  try {
    if (!ownedDirectory(directory, uid)) return null;
    const path = join(directory, `${digest}.json`);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSyncImpl(fd);
      if (!stat.isFile() || (Number.isInteger(uid) && stat.uid !== uid)) return null;
      const identity = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
      const cached = parsedBindings.get(path);
      if (cached?.identity === identity && cached.observedAt <= now && cached.until > now) {
        return cached.credential;
      }

      const binding = JSON.parse(readFileSyncImpl(fd, 'utf8'));
      if (binding.digest !== digest || !INSTALLATION.test(binding.credential)
        || !Number.isFinite(binding.expiresAt) || binding.expiresAt <= now
        || binding.expiresAt > now + MAX_BINDING_AGE_MS) return null;

      parsedBindings.set(path, { identity, credential: binding.credential, observedAt: now,
        until: Math.min(now + PARSED_BINDING_TTL_MS, binding.expiresAt) });
      while (parsedBindings.size > 256) parsedBindings.delete(parsedBindings.keys().next().value);
      return binding.credential;
    } finally { closeSync(fd); }
  } catch { /* Missing, expired or unreadable metadata retains digest isolation. */ }
  return null;
}

export function writeBudgetBinding(directory, digest, credential, expiresAt, now = Date.now()) {
  if (!DIGEST.test(digest) || !INSTALLATION.test(credential)) return;
  const expiry = Math.min(Number.isFinite(expiresAt) ? expiresAt : now + MAX_BINDING_AGE_MS,
    now + MAX_BINDING_AGE_MS);
  if (expiry <= now) return;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!ownedDirectory(directory, currentUid())) return;
    writeFileAtomic(join(directory, `${digest}.json`),
      JSON.stringify({ digest, credential, expiresAt: expiry }), { mode: 0o600 });
    // Rotation must not leave an ever-growing directory of expired digests.
    for (const name of readdirSync(directory)) {
      if (!/^[a-f0-9]{24}\.json$/.test(name)) continue;
      try {
        const binding = JSON.parse(readFileSync(join(directory, name), 'utf8'));
        if (Number.isFinite(binding.expiresAt) && binding.expiresAt <= now) {
          rmSync(join(directory, name), { force: true });
        }
      } catch { /* Never replace or delete metadata we could not read. */ }
    }
  } catch { /* Metadata failure must not prevent a successful broker refresh. */ }
}

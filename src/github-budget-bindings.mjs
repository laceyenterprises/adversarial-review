import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';

// One file per digest avoids lost updates from concurrent token refreshers.
// Only broker-verified identities enter this cache; raw tokens never do.
const MAX_BINDING_AGE_MS = 60 * 60_000;
const DIGEST = /^[a-f0-9]{24}$/;
const INSTALLATION = /^installation-\d+-\d+$/;

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function ownedDirectory(directory, uid) {
  const stat = lstatSync(directory);
  return stat.isDirectory() && (!Number.isInteger(uid) || stat.uid === uid)
    && (stat.mode & 0o022) === 0;
}

export function readBudgetBinding(directory, digest, now = Date.now(), {
  uid = currentUid(), fstatSyncImpl = fstatSync,
} = {}) {
  if (!DIGEST.test(digest)) return null;
  try {
    if (!ownedDirectory(directory, uid)) return null;
    const fd = openSync(join(directory, `${digest}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
    let binding;
    try {
      const stat = fstatSyncImpl(fd);
      if (!stat.isFile() || (Number.isInteger(uid) && stat.uid !== uid)) return null;
      binding = JSON.parse(readFileSync(fd, 'utf8'));
    } finally { closeSync(fd); }
    if (binding.digest === digest && INSTALLATION.test(binding.credential)
      && Number.isFinite(binding.expiresAt) && binding.expiresAt > now
      && binding.expiresAt <= now + MAX_BINDING_AGE_MS) return binding.credential;
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

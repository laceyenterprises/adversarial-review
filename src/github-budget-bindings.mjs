import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';

// One file per digest avoids lost updates from concurrent token refreshers.
// Only broker-verified identities enter this cache; raw tokens never do.
const MAX_BINDING_AGE_MS = 60 * 60_000;
const DIGEST = /^[a-f0-9]{24}$/;
const INSTALLATION = /^installation-\d+-\d+$/;

export function readBudgetBinding(directory, digest, now = Date.now()) {
  if (!DIGEST.test(digest)) return null;
  try {
    const binding = JSON.parse(readFileSync(join(directory, `${digest}.json`), 'utf8'));
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

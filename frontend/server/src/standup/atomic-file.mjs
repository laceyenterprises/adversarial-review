/**
 * The write-temp-then-rename primitive both standup writers share (ARF-05).
 *
 * Two files on this path are replaced in place while other processes may be
 * reading them: the run record (`run-store.mjs`) and the role→token manifest
 * (`role-mapping.mjs`). Both want the same guarantee — a reader sees either the
 * whole previous file or the whole new one, never a half-written one — and both
 * get it the same way, by writing beside the target and renaming over it.
 *
 * It lives in one module because the two writers had the same scratch-path bug
 * independently: a temp name keyed on `process.pid` alone is not the unique thing
 * it looks like, and fixing it in one file would have left the other.
 */

import { randomBytes } from 'node:crypto';

/**
 * A scratch path beside `target` that no other writer can be using.
 *
 * Same directory on purpose: the rename that follows is then same-device and
 * therefore atomic, where `/tmp` could be a different filesystem and the rename
 * would degrade to a copy, losing the guarantee the temp file exists for.
 *
 * The name carries a random nonce as well as the pid, because a pid is not
 * unique the way it appears to be. Two ARF processes in containers sharing a
 * state volume can hold the same pid; a pid is reused after a crash, and the
 * stale `.tmp` a crashed writer left behind is exactly the file the next writer
 * with that pid would clobber. A nonce makes every attempt's scratch file its
 * own, whichever process and whichever concurrent run produced it.
 *
 * The `.tmp` suffix is load-bearing too: `run-store.list()` reads only `.json`,
 * so a scratch file is never mistaken for a record.
 *
 * @param {string} target the final path the temp file will be renamed onto
 * @returns {string}
 */
export function tempPathFor(target) {
  return `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
}

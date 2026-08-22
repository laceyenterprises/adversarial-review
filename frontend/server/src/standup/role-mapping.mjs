/**
 * Writing a role -> token mapping into the manifest ARF-07 reads (ARF-05).
 *
 * The wire step's product is a mapping, and ARF-07 owns what a mapping *is*.
 * This module does the one thing ARF-07 deliberately does not: persist a new
 * entry into `broker.rolesFile`, the JSON manifest the broker config already
 * points at. Everything about the entry's shape — which fields a `github_app`
 * role needs, which an `external` role needs, that a ref must be a ref — stays
 * `manifest.mjs`'s judgement, and is re-validated there when the broker reloads.
 *
 * ## Why persist, rather than hand the broker an in-memory entry
 *
 * Because "wired" has to survive a restart. An entry patched into a live broker
 * object would let the wizard report step 4 green while the next boot of ARF —
 * or the pipeline daemon reading the same manifest — had no mapping at all. The
 * step writes the file, reloads the broker *from disk*, and only then asks it to
 * resolve a token. What the operator is shown succeeding is therefore the same
 * thing a restarted process would see.
 *
 * ## Why an existing file is merged, not replaced
 *
 * `rolesFile` is a manifest an operator may hand-maintain for several roles. A
 * standup for one role rewriting the whole file would silently drop the others.
 * Both accepted shapes are preserved — a bare role map, and the `{"roles": {…}}`
 * wrapper — because the reader accepts both and changing which one a file uses
 * is not a standup's business.
 *
 * The same argument covers the file's ownership and mode, which a rename replaces
 * just as wholesale as its contents: ARF preserves what it found, and refuses the
 * merge rather than taking a manifest over. See `inheritOwnership`.
 */

import {
  chmodSync, chownSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { BrokerConfigError } from '../broker/errors.mjs';
import {
  BROKER_MODE_EXTERNAL, PROVIDER_EXTERNAL, PROVIDER_GITHUB_APP, normalizeRoleEntry,
} from '../broker/manifest.mjs';
import { tempPathFor } from './atomic-file.mjs';

/**
 * Build the manifest entry for a role from what the lifecycle steps captured.
 *
 * Mode-aware because the two modes name an identity differently: bundled mode
 * mints locally and needs the App coordinates plus a key reference, external mode
 * asks a broker and needs the scope/principal that tells it *which* identity to
 * mint. Both are validated by `normalizeRoleEntry` before this returns, so a
 * mapping that the broker would refuse at load never reaches the file.
 *
 * @param {object} options
 * @param {string} options.role
 * @param {string} options.mode broker mode
 * @param {object} options.outputs step outputs (appId, installationId, refs, botLogin)
 * @param {object} options.params effective run params
 * @returns {object} a plain JSON entry, ready to write
 */
export function buildRoleEntry({ role, mode, outputs, params }) {
  const entry = mode === BROKER_MODE_EXTERNAL
    ? {
      provider: PROVIDER_EXTERNAL,
      // The scope is what names the identity to the far broker. Defaulting it to
      // the role name is a real default, not a guess: it is the identifier the
      // operator already chose for this identity, and `manifest.mjs` refuses an
      // external entry with neither scope nor principal precisely because a
      // request carrying neither cannot be told apart from a request for the
      // broker's default credential.
      scope: params.scope ?? role,
      ...(params.principal ? { principal: params.principal } : {}),
      ...(outputs.appId ? { appId: outputs.appId } : {}),
      ...(outputs.installationId ? { installationId: outputs.installationId } : {}),
    }
    : {
      provider: PROVIDER_GITHUB_APP,
      appId: outputs.appId,
      installationId: outputs.installationId,
      privateKeyRef: outputs.privateKeyRef,
      ...(outputs.patFallbackRef ? { patFallbackRef: outputs.patFallbackRef } : {}),
    };

  // Validated against the same rules the broker applies at load. A mapping that
  // would refuse to boot ARF is not written to disk in the first place.
  normalizeRoleEntry(role, entry, mode);
  return entry;
}

function readManifest(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    // An absent manifest is the ordinary first-standup case: create it.
    if (err && err.code === 'ENOENT') return { wrapped: false, roles: {}, existed: false };
    throw new BrokerConfigError(`broker.rolesFile ${path} is unreadable: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Refused rather than overwritten. A manifest ARF cannot parse may still hold
    // other roles' mappings, and clobbering it to make one standup succeed would
    // take the rest of the fleet's identities down with it.
    throw new BrokerConfigError(
      `broker.rolesFile ${path} is not valid JSON and will not be overwritten: ${err.message}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BrokerConfigError(`broker.rolesFile ${path} must contain a JSON object`);
  }
  const wrapped = parsed.roles !== undefined;
  const roles = wrapped ? parsed.roles : parsed;
  if (roles === null || typeof roles !== 'object' || Array.isArray(roles)) {
    throw new BrokerConfigError(`broker.rolesFile ${path} roles must be a JSON object`);
  }
  return { wrapped, roles, existed: true, outer: parsed };
}

/**
 * Carry an existing manifest's ownership and mode onto the file replacing it.
 *
 * `renameSync` replaces a file wholesale — the inode, and with it the owner and
 * the mode, are the *new* file's. So a merge that did not do this would quietly
 * hand the manifest to ARF's user at `0600` the moment a standup succeeded, and
 * every other reader of that same file would lose it: the pipeline daemon running
 * as another user, an operator account relying on group read. That is a
 * cross-process outage caused by a write that reported success, which is the
 * shape of the 501:20 class. ARF preserves what it found instead.
 *
 * A file ARF creates still gets `0600`. There is nobody to lock out yet, and the
 * manifest decides which identity ARF acts as — a mapping another account can
 * rewrite is a way to make ARF post as something else.
 *
 * Ownership that cannot be preserved is a refusal, not a shrug: renaming anyway
 * is precisely the takeover this exists to prevent, and doing it silently is what
 * would make the outage hard to trace back here.
 */
function inheritOwnership(temp, path) {
  let existing;
  try {
    existing = statSync(path);
  } catch {
    // Vanished between the read and the write. There is nothing to inherit, and
    // the temp file's own `0600` is the right mode for a file ARF is creating.
    return;
  }

  chmodSync(temp, existing.mode & 0o7777);

  // Compared against the temp file rather than against the process identity: a
  // setgid directory may already have given it the right group, and a chown that
  // is a no-op should not be attempted (nor its EPERM reported) on a host where
  // ARF is not privileged to make it.
  const scratch = statSync(temp);
  if (scratch.uid === existing.uid && scratch.gid === existing.gid) return;

  try {
    chownSync(temp, existing.uid, existing.gid);
  } catch (err) {
    throw new BrokerConfigError(
      `broker.rolesFile ${path} is owned by uid=${existing.uid} gid=${existing.gid} and ARF cannot `
      + `preserve that ownership (${err.message}); refusing to take the manifest over, because `
      + 'replacing it would lock out every other reader of it',
    );
  }
}

/**
 * Merge one role entry into the manifest at `path`.
 *
 * @param {object} options
 * @param {string} options.path  resolved `broker.rolesFile`
 * @param {string} options.role
 * @param {object} options.entry
 * @returns {{path: string, created: boolean, replaced: boolean, roles: string[]}}
 */
export function writeRoleMapping({ path, role, entry }) {
  const manifest = readManifest(path);
  const replaced = Object.hasOwn(manifest.roles, role);
  const roles = { ...manifest.roles, [role]: entry };
  // An existing file keeps whichever of the two accepted shapes it already uses —
  // rewriting an operator's bare map into a wrapper (or back) is not a standup's
  // business. A file ARF creates gets the wrapper, because it is the shape the
  // config file's own `broker.roles` section has, so the two read alike.
  const wrapped = manifest.existed ? manifest.wrapped : true;
  const document = wrapped ? { ...(manifest.outer ?? {}), roles } : roles;

  mkdirSync(dirname(path), { recursive: true });
  // Same-directory temp then rename: the broker reload that follows reads this
  // file immediately, and a half-written manifest would fail the very step that
  // just wrote it — while also being what any other reader saw in the meantime.
  // Uniquely named as well as same-directory: two roles stood up concurrently
  // share this one `path`, so a scratch name keyed on the pid alone would be the
  // same name for both. See `atomic-file.mjs`.
  const temp = tempPathFor(path);
  try {
    // 0600: the manifest holds no secret values, but it is the file that decides
    // which identity ARF acts as, and a mapping another account can rewrite is a
    // way to make ARF post as something else. An existing manifest keeps its own
    // ownership and mode instead — see `inheritOwnership`.
    writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    if (manifest.existed) inheritOwnership(temp, path);
    renameSync(temp, path);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file may never have been created; nothing to clean up.
    }
    // A refusal this module already stated in full is passed through: wrapping it
    // in "could not be written" would bury why it was not written.
    if (err instanceof BrokerConfigError) throw err;
    throw new BrokerConfigError(`broker.rolesFile ${path} could not be written: ${err.message}`);
  }

  return {
    path,
    created: !manifest.existed,
    replaced,
    roles: Object.keys(roles).sort(),
  };
}

/**
 * Compare a mapping that already exists against the identity just stood up.
 *
 * Returns the mismatching field, or null when they agree. Only coordinates the
 * existing entry actually asserts are compared — an external-mode entry legitimately
 * carries no App coordinates, and treating "unstated" as "wrong" would refuse a
 * correct mapping.
 *
 * @param {object} existing a `describe()` role row
 * @param {object} outputs step outputs
 */
export function mappingMismatch(existing, outputs) {
  for (const field of ['appId', 'installationId']) {
    const actual = existing?.[field];
    const expected = outputs?.[field];
    if (!actual || !expected) continue;
    if (String(actual) !== String(expected)) {
      return { field, expected: String(expected), actual: String(actual) };
    }
  }
  return null;
}

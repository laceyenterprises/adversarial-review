/**
 * The identity standup request, validated at the door (ARF-05).
 *
 * Everything a run is given arrives here first, and two of the checks are worth
 * more than the rest:
 *
 * - **`privateKeyRef` / `patFallbackRef` go through `parseSecretRef`.** SPEC §7:
 *   ARF never handles raw secret values. A PEM or a `ghp_…` pasted into a field
 *   where a reference belongs is refused with a 400 *before* a run exists, so it
 *   never reaches a step, a log line, or the durable run record. Accepting it as
 *   an opaque string would put the material in a file on disk, and the wizard
 *   would look like it worked.
 *
 * - **The role name is checked with the manifest's own predicate.** The broker
 *   refuses wildcard and catch-all keys by construction (`manifest.mjs`), and the
 *   wizard has to refuse the same set — a role name it accepted but the manifest
 *   would not is a run that necessarily fails at the wire step, and a role name
 *   containing a path separator would escape the run store's directory.
 *
 * Unknown keys are a hard error for the reason the config loader gives: a
 * silently-ignored `privateKeyReff` leaves a run looking configured and failing
 * three steps later with the operator's actual input nowhere in evidence.
 */

import { isValidRoleName } from '../broker/manifest.mjs';
import { parseSecretRef } from '../broker/secrets.mjs';
import { StandupParamsError } from './errors.mjs';

/** `owner/repo`, using the character set GitHub actually allows in both halves. */
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A GitHub owner (org or user) login. */
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** Numeric GitHub ids arrive as strings or numbers depending on who serialized them. */
const NUMERIC_ID_PATTERN = /^[0-9]+$/;

export const STANDUP_PARAM_KEYS = Object.freeze([
  'role',
  'appId',
  'privateKeyRef',
  'patFallbackRef',
  'org',
  'repos',
  'installationId',
  'scope',
  'principal',
  'verifyRepo',
  'verifyIssue',
]);

const KNOWN_KEYS = new Set(STANDUP_PARAM_KEYS);

function requireObject(value, what) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StandupParamsError(`${what} must be a JSON object`);
  }
  return value;
}

function optionalString(value, what, pattern = null) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = typeof value === 'number' && Number.isInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || text.trim() === '') {
    throw new StandupParamsError(`${what} must be a non-empty string`);
  }
  const trimmed = text.trim();
  if (pattern && !pattern.test(trimmed)) {
    throw new StandupParamsError(`${what} ${JSON.stringify(trimmed)} is not in the expected form`);
  }
  return trimmed;
}

function optionalSecretRef(value, what, role) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  // parseSecretRef is the refusal: a raw secret has no recognised scheme, so it
  // fails here rather than being stored as an opaque string.
  return parseSecretRef(value, { field: what, role }).raw;
}

function optionalRepos(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const list = Array.isArray(value) ? value : [value];
  const repos = [];
  for (const item of list) {
    const repo = optionalString(item, 'params.repos[]', REPO_PATTERN);
    if (repo === null || repo === undefined) continue;
    // De-duplicated, because every repo in the list resolves to the same
    // account-level installation and asking GitHub twice for it proves nothing.
    if (!repos.includes(repo)) repos.push(repo);
  }
  return repos;
}

function optionalIssueNumber(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const num = typeof value === 'string' && NUMERIC_ID_PATTERN.test(value.trim())
    ? Number(value.trim())
    : value;
  if (!Number.isInteger(num) || num <= 0) {
    throw new StandupParamsError(
      `params.verifyIssue must be a positive integer issue or PR number, got ${JSON.stringify(value)}`,
    );
  }
  return num;
}

/**
 * Validate and normalize a standup request body.
 *
 * Absent keys are **omitted** from the result; an explicit `null` is **kept** as
 * null. The difference is what makes a resume usable: a re-run that sends only
 * the field that was missing keeps everything the prior run recorded, while a
 * re-run that sends `"appId": null` deliberately clears it (see `mergeParams`).
 *
 * @param {unknown} raw
 * @returns {object} frozen, normalized params
 */
export function normalizeStandupParams(raw) {
  const body = requireObject(raw ?? {}, 'request body');
  for (const key of Object.keys(body)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new StandupParamsError(
        `unknown parameter ${JSON.stringify(key)} (known: ${STANDUP_PARAM_KEYS.join(', ')})`,
      );
    }
  }

  const role = optionalString(body.role, 'params.role');
  if (!role) {
    throw new StandupParamsError('params.role is required — a standup stands up one role');
  }
  if (!isValidRoleName(role)) {
    throw new StandupParamsError(
      `params.role ${JSON.stringify(role)} is not a valid role name. ARF accepts `
      + '[A-Za-z0-9][A-Za-z0-9._-]* only: wildcard and catch-all names are refused so no '
      + 'mapping can exist that an unrequested identity would match.',
    );
  }

  const params = { role };
  const set = (key, value) => {
    if (value !== undefined) params[key] = value;
  };

  set('appId', optionalString(body.appId, 'params.appId', NUMERIC_ID_PATTERN));
  set('privateKeyRef', optionalSecretRef(body.privateKeyRef, 'params.privateKeyRef', role));
  set('patFallbackRef', optionalSecretRef(body.patFallbackRef, 'params.patFallbackRef', role));
  set('org', optionalString(body.org, 'params.org', OWNER_PATTERN));
  set('repos', optionalRepos(body.repos));
  set('installationId', optionalString(body.installationId, 'params.installationId', NUMERIC_ID_PATTERN));
  set('scope', optionalString(body.scope, 'params.scope'));
  set('principal', optionalString(body.principal, 'params.principal'));
  set('verifyRepo', optionalString(body.verifyRepo, 'params.verifyRepo', REPO_PATTERN));
  set('verifyIssue', optionalIssueNumber(body.verifyIssue));

  return Object.freeze(params);
}

/**
 * Layer a new request over what a prior run recorded.
 *
 * A resume should not make the operator restate the whole request just to supply
 * the one field that was missing, so recorded params are the base. An explicit
 * `null` in the new request survives the merge as null — that is how a value is
 * cleared rather than inherited forever.
 *
 * @param {object|null|undefined} prior params from the run record
 * @param {object} next  params from this request
 */
export function mergeParams(prior, next) {
  if (!prior || typeof prior !== 'object') return next;
  const merged = { ...prior, ...next };
  // The role is the record's identity, not a mergeable field: a request for a
  // different role reads a different record, so this can only ever agree.
  merged.role = next.role;
  return Object.freeze(merged);
}

/**
 * The subset of params that is safe to persist.
 *
 * Built from the allowlist rather than by subtracting from the request, so a
 * field added later is stored only once someone has decided it should be. Every
 * key here is a reference, a coordinate, or a number — the record never holds
 * secret material, which the params validation above has already guaranteed by
 * refusing anything that is not a reference.
 */
export function persistableParams(params) {
  const out = {};
  for (const key of STANDUP_PARAM_KEYS) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    out[key] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}

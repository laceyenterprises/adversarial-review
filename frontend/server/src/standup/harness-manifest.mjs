/**
 * The harness manifest: a worker/reviewer class, its entitlement, its bot
 * identity, and how it authenticates to a model provider (ARF-06).
 *
 * `modules/worker-pool/worker-classes.json` is the **reference model** for this
 * shape — read to learn what a class declaration has to carry, never imported
 * (SPEC §5: standalone, ARF owns an equivalent manifest). The fields that
 * survived the translation are the ones that are load-bearing there:
 * `allowedModels` is a fail-closed allowlist, `defaultModel` is the validated
 * fallback, `entitlement` names the token/secret policy the class runs under,
 * and `botIdentity` is the account its posts are attributed to.
 *
 * ## Everything is validated at registration, not at first use
 *
 * A class registered without an entitlement, without a bot identity, or with a
 * `defaultModel` outside its own `allowedModels` is refused here — before
 * anything is written and long before a review is dispatched under it. That
 * ordering is the whole point, and it is borrowed from a scar this fleet already
 * has: the worker-class registry once accepted role classes whose secret/vault
 * policy coverage was incomplete, and the gap surfaced at deploy-secret smoke
 * time as a frozen deployment rather than at registration as a refusal
 * (`docs/INCIDENT-SEV1-role-class-vault-policy-coverage-deploy-freeze-2026-07-31.md`).
 * A manifest that cannot be stood up should fail while an operator is still
 * looking at the form.
 *
 * ## Posting logins are derived, not typed
 *
 * A GitHub App does not post as its slug — it posts as `<slug>[bot]`. An
 * operator who registers `claude-reviewer` for an App identity and puts exactly
 * that string in the reviewer allowlist has built an allowlist that will never
 * match a single one of that App's reviews, and the failure is silent: reviews
 * get posted, nothing counts them, and the PRs read as unreviewed. That is the
 * trap this ticket exists to close, so the `[bot]` form is *derived* from the
 * identity kind rather than trusted to be typed correctly, and every declared
 * alias is carried alongside it (the in-OS entitlement descriptors carry a
 * comma-separated list of login forms per identity for exactly this reason —
 * the live account and the legacy config form differ, and the AMA reviewer
 * authority accepts both).
 */

import { parseSecretRef } from '../broker/secrets.mjs';

export class HarnessManifestError extends Error {
  constructor(message, { field = null } = {}) {
    super(message);
    this.name = 'HarnessManifestError';
    this.code = 'harness_manifest';
    this.field = field;
  }
}

/** How a harness authenticates to its model provider. */
export const MODEL_AUTH_BROKER_OAUTH = 'broker-oauth';
export const MODEL_AUTH_STANDALONE_TOKEN = 'standalone-token';
export const MODEL_AUTH_MODES = Object.freeze([MODEL_AUTH_BROKER_OAUTH, MODEL_AUTH_STANDALONE_TOKEN]);

/** What the class is stood up to do. Mirrors the worker-class `tags` role split. */
export const HARNESS_KINDS = Object.freeze(['reviewer', 'remediator', 'worker', 'scanner']);

/** Identity kinds, which decide the posting-login derivation above. */
export const IDENTITY_GITHUB_APP = 'github_app';
export const IDENTITY_GITHUB_USER = 'github_user';
export const IDENTITY_KINDS = Object.freeze([IDENTITY_GITHUB_APP, IDENTITY_GITHUB_USER]);

/** Manifest schema version, so a later ARF can migrate a file it did not write. */
export const HARNESS_MANIFEST_VERSION = 1;

/** Class and entitlement names: the same conservative shape the registry uses. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * A GitHub login, optionally in its App form. GitHub allows 39 characters of
 * alphanumerics and single hyphens; `[bot]` is the suffix it appends to an App's
 * slug when the App authors something.
 */
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$/;

const BOT_SUFFIX = '[bot]';

const SPEC_KEYS = new Set([
  'class', 'kind', 'entitlement', 'allowedModels', 'defaultModel', 'botIdentity',
  'modelAuth', 'runtime', 'reviewerAllowlist', 'tags', 'notes',
]);
const IDENTITY_KEYS = new Set(['login', 'kind', 'aliases', 'brokerRole', 'email']);
const MODEL_AUTH_KEYS = new Set(['mode', 'brokerRole', 'tokenRef', 'provider', 'notes']);
const RUNTIME_KEYS = new Set(['command', 'minVersion']);
const ALLOWLIST_KEYS = new Set(['enabled', 'note']);

function requireObject(value, what) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HarnessManifestError(`${what} must be a JSON object`, { field: what });
  }
  return value;
}

function requireKnownKeys(value, known, what) {
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      throw new HarnessManifestError(
        `${what} has unknown key ${JSON.stringify(key)} (known: ${[...known].join(', ')})`,
        { field: `${what}.${key}` },
      );
    }
  }
  return value;
}

function requireString(value, what) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HarnessManifestError(`${what} is required and must be a non-empty string`, { field: what });
  }
  return value.trim();
}

function optionalString(value, what) {
  return value === undefined || value === null ? null : requireString(value, what);
}

function requireStringArray(value, what, { min = 0 } = {}) {
  if (!Array.isArray(value)) {
    throw new HarnessManifestError(`${what} must be an array of strings`, { field: what });
  }
  const items = value.map((entry, index) => requireString(entry, `${what}[${index}]`));
  if (items.length < min) {
    throw new HarnessManifestError(`${what} must have at least ${min} entry`, { field: what });
  }
  return items;
}

function requireName(value, what) {
  const text = requireString(value, what);
  if (!NAME_PATTERN.test(text)) {
    throw new HarnessManifestError(
      `${what} ${JSON.stringify(text)} must match ${NAME_PATTERN} `
      + '(lower-case, no spaces) — it is used as a manifest key and a directory-safe id',
      { field: what },
    );
  }
  return text;
}

function requireLogin(value, what) {
  const text = requireString(value, what);
  if (!LOGIN_PATTERN.test(text)) {
    throw new HarnessManifestError(
      `${what} ${JSON.stringify(text)} is not a GitHub login `
      + '(alphanumerics and single hyphens, up to 39 characters, optionally suffixed "[bot]")',
      { field: what },
    );
  }
  return text;
}

/** Strip the App suffix, if present. Case-insensitive: GitHub logins are. */
export function stripBotSuffix(login) {
  const text = String(login).trim();
  return text.toLowerCase().endsWith(BOT_SUFFIX) ? text.slice(0, -BOT_SUFFIX.length) : text;
}

/**
 * Every login form this identity may post under, primary first.
 *
 * For a GitHub App the primary is always the `[bot]` form, because that is the
 * author GitHub actually reports on the App's comments and reviews — the slug on
 * its own never appears as an author. Declared aliases follow, deduplicated
 * case-insensitively; they exist because a fleet accumulates naming forms
 * (`lacey-<model>-reviewer` vs `<model>-reviewer-lacey`) and an allowlist that
 * knows only one of them counts only some of the reviews.
 *
 * @param {{login: string, kind: string, aliases: string[]}} identity
 * @returns {string[]}
 */
export function postingLogins(identity) {
  const slug = stripBotSuffix(identity.login);
  const primary = identity.kind === IDENTITY_GITHUB_APP ? `${slug}${BOT_SUFFIX}` : identity.login;
  const seen = new Set();
  const out = [];
  for (const candidate of [primary, ...identity.aliases]) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function normalizeIdentity(raw, what) {
  requireObject(raw, what);
  requireKnownKeys(raw, IDENTITY_KEYS, what);
  const kind = raw.kind === undefined ? IDENTITY_GITHUB_APP : requireString(raw.kind, `${what}.kind`);
  if (!IDENTITY_KINDS.includes(kind)) {
    throw new HarnessManifestError(
      `${what}.kind must be one of ${IDENTITY_KINDS.join(' | ')}, got ${JSON.stringify(kind)}`,
      { field: `${what}.kind` },
    );
  }
  const login = requireLogin(raw.login, `${what}.login`);
  if (kind === IDENTITY_GITHUB_USER && login.toLowerCase().endsWith(BOT_SUFFIX)) {
    // `[bot]` is not a suffix a user account can carry; accepting it would
    // record a login no post will ever be attributed to.
    throw new HarnessManifestError(
      `${what}.login ${JSON.stringify(login)} carries the "[bot]" App suffix but `
      + `${what}.kind is ${IDENTITY_GITHUB_USER}`,
      { field: `${what}.login` },
    );
  }
  const aliases = raw.aliases === undefined
    ? []
    : requireStringArray(raw.aliases, `${what}.aliases`).map(
      (alias, index) => requireLogin(alias, `${what}.aliases[${index}]`),
    );
  const identity = {
    login,
    kind,
    aliases,
    // The broker role whose credential this identity posts with, when there is
    // one. Optional: a standalone harness can be stood up before any GitHub
    // identity is minted, and pretending otherwise would make ARF-07 a hard
    // dependency of a flow that does not need it.
    brokerRole: optionalString(raw.brokerRole, `${what}.brokerRole`),
    email: optionalString(raw.email, `${what}.email`),
  };
  identity.postingLogins = postingLogins(identity);
  return Object.freeze(identity);
}

function normalizeModelAuth(raw, what) {
  requireObject(raw, what);
  requireKnownKeys(raw, MODEL_AUTH_KEYS, what);
  const mode = requireString(raw.mode, `${what}.mode`);
  if (!MODEL_AUTH_MODES.includes(mode)) {
    throw new HarnessManifestError(
      `${what}.mode must be one of ${MODEL_AUTH_MODES.join(' | ')}, got ${JSON.stringify(mode)}`,
      { field: `${what}.mode` },
    );
  }

  const entry = {
    mode,
    brokerRole: null,
    tokenRef: null,
    provider: optionalString(raw.provider, `${what}.provider`),
    notes: optionalString(raw.notes, `${what}.notes`),
  };

  if (mode === MODEL_AUTH_BROKER_OAUTH) {
    // The role is what the ARF-07 seam keys on, and an unmapped role is refused
    // there rather than fulfilled from ambient credentials. Requiring it here
    // means the refusal happens at registration, with the operator present.
    entry.brokerRole = requireString(raw.brokerRole, `${what}.brokerRole`);
    if (raw.tokenRef !== undefined && raw.tokenRef !== null) {
      throw new HarnessManifestError(
        `${what}.tokenRef is not valid in mode=${MODEL_AUTH_BROKER_OAUTH} — a broker-OAuth `
        + 'harness gets its credential from the broker. Two credential sources on one '
        + 'harness is exactly the ambiguity that lets the wrong identity act.',
        { field: `${what}.tokenRef` },
      );
    }
    return Object.freeze(entry);
  }

  // standalone-token: a secret *reference*, resolved directly. No broker is
  // constructed, contacted, or required — that is the mode's entire point
  // (SPEC §2: ARF must run fully standalone outside the OS).
  entry.tokenRef = parseSecretRef(raw.tokenRef, { field: `${what}.tokenRef` }).raw;
  if (raw.brokerRole !== undefined && raw.brokerRole !== null) {
    throw new HarnessManifestError(
      `${what}.brokerRole is not valid in mode=${MODEL_AUTH_STANDALONE_TOKEN} — a standalone `
      + 'harness must not depend on a broker at all.',
      { field: `${what}.brokerRole` },
    );
  }
  return Object.freeze(entry);
}

function normalizeRuntime(raw, what) {
  if (raw === undefined || raw === null) return null;
  requireObject(raw, what);
  requireKnownKeys(raw, RUNTIME_KEYS, what);
  return Object.freeze({
    command: requireString(raw.command, `${what}.command`),
    // Probe/install argv is server policy, not request data. `execFile` avoids
    // shells, but interpreter flags such as `node -e` or `python3 -c` are still
    // executable behavior if a request can supply them.
    versionArgs: Object.freeze(['--version']),
    installCommand: null,
    installArgs: Object.freeze([]),
    minVersion: optionalString(raw.minVersion, `${what}.minVersion`),
  });
}

/**
 * Validate and normalize a harness spec as it arrives from the panel or a config
 * file. Throws `HarnessManifestError` on anything that could not be stood up.
 *
 * @param {object} raw
 * @returns {object} frozen normalized spec
 */
export function normalizeHarnessSpec(raw) {
  requireObject(raw, 'harness');
  requireKnownKeys(raw, SPEC_KEYS, 'harness');

  const harnessClass = requireName(raw.class, 'harness.class');
  const kind = raw.kind === undefined ? 'reviewer' : requireString(raw.kind, 'harness.kind');
  if (!HARNESS_KINDS.includes(kind)) {
    throw new HarnessManifestError(
      `harness.kind must be one of ${HARNESS_KINDS.join(' | ')}, got ${JSON.stringify(kind)}`,
      { field: 'harness.kind' },
    );
  }

  // Not optional, and not defaulted. An entitlement is the name of the secret /
  // token policy the class runs under; inventing one would produce a class that
  // registers cleanly and cannot be granted anything.
  const entitlement = requireName(raw.entitlement, 'harness.entitlement');

  const allowedModels = requireStringArray(raw.allowedModels, 'harness.allowedModels', { min: 1 });
  const duplicate = allowedModels.find((model, index) => allowedModels.indexOf(model) !== index);
  if (duplicate) {
    throw new HarnessManifestError(
      `harness.allowedModels lists ${JSON.stringify(duplicate)} twice`,
      { field: 'harness.allowedModels' },
    );
  }

  const defaultModel = raw.defaultModel === undefined
    ? allowedModels[0]
    : requireString(raw.defaultModel, 'harness.defaultModel');
  if (!allowedModels.includes(defaultModel)) {
    // `allowedModels` is a fail-closed allowlist in the registry this shape is
    // modelled on: a default outside it is a class whose every dispatch fails
    // validation, which is a slow, confusing way to learn about a typo.
    throw new HarnessManifestError(
      `harness.defaultModel ${JSON.stringify(defaultModel)} is not in harness.allowedModels `
      + `(${allowedModels.join(', ')}) — allowedModels is a fail-closed allowlist, so this class `
      + 'could never dispatch.',
      { field: 'harness.defaultModel' },
    );
  }

  const allowlistRaw = raw.reviewerAllowlist === undefined ? {} : raw.reviewerAllowlist;
  requireObject(allowlistRaw, 'harness.reviewerAllowlist');
  requireKnownKeys(allowlistRaw, ALLOWLIST_KEYS, 'harness.reviewerAllowlist');
  if (allowlistRaw.enabled !== undefined && typeof allowlistRaw.enabled !== 'boolean') {
    // Not coerced. `"false"` is a truthy string, and a truthy string that turns
    // allowlist wiring on when the operator meant to turn it off is a harmless
    // mistake; the opposite spelling is not.
    throw new HarnessManifestError(
      'harness.reviewerAllowlist.enabled must be a boolean',
      { field: 'harness.reviewerAllowlist.enabled' },
    );
  }

  const spec = {
    class: harnessClass,
    kind,
    entitlement,
    allowedModels: Object.freeze(allowedModels),
    defaultModel,
    botIdentity: normalizeIdentity(raw.botIdentity, 'harness.botIdentity'),
    modelAuth: normalizeModelAuth(raw.modelAuth, 'harness.modelAuth'),
    runtime: normalizeRuntime(raw.runtime, 'harness.runtime'),
    reviewerAllowlist: Object.freeze({
      // Default on for anything whose posts are supposed to count as reviews.
      // A reviewer or remediator standing up without an allowlist entry is the
      // failure this ticket is about, so opting out has to be typed.
      enabled: allowlistRaw.enabled === undefined
        ? (kind === 'reviewer' || kind === 'remediator')
        : allowlistRaw.enabled,
      note: optionalString(allowlistRaw.note, 'harness.reviewerAllowlist.note'),
    }),
    tags: Object.freeze(raw.tags === undefined ? [] : requireStringArray(raw.tags, 'harness.tags')),
    notes: optionalString(raw.notes, 'harness.notes'),
  };

  return Object.freeze(spec);
}

/** An empty, well-formed harness-manifest document. */
export function emptyHarnessManifest() {
  return { version: HARNESS_MANIFEST_VERSION, harnesses: {} };
}

/**
 * Project a normalized spec into the record that is persisted.
 *
 * `status` starts at `registering` and only ever reaches `ready` when every step
 * of the wizard passed, including allowlist verification. There is no path that
 * writes `ready` from a partial run: a half-stood-up harness that reads as ready
 * is how a reviewer ends up posting reviews nobody counts.
 */
export function harnessRecord(spec, { registeredAt }) {
  return {
    class: spec.class,
    kind: spec.kind,
    entitlement: spec.entitlement,
    allowedModels: [...spec.allowedModels],
    defaultModel: spec.defaultModel,
    botIdentity: {
      login: spec.botIdentity.login,
      kind: spec.botIdentity.kind,
      aliases: [...spec.botIdentity.aliases],
      postingLogins: [...spec.botIdentity.postingLogins],
      brokerRole: spec.botIdentity.brokerRole,
      email: spec.botIdentity.email,
    },
    modelAuth: {
      mode: spec.modelAuth.mode,
      brokerRole: spec.modelAuth.brokerRole,
      // A reference, never a value (SPEC §7).
      tokenRef: spec.modelAuth.tokenRef,
      provider: spec.modelAuth.provider,
      provisioned: false,
      credential: null,
    },
    runtime: spec.runtime
      ? {
        ...spec.runtime,
        versionArgs: [...spec.runtime.versionArgs],
        installArgs: [...spec.runtime.installArgs],
        verified: false,
        resolvedPath: null,
        version: null,
      }
      : null,
    reviewerAllowlist: {
      enabled: spec.reviewerAllowlist.enabled,
      note: spec.reviewerAllowlist.note,
      wired: false,
      verified: false,
      logins: [...spec.botIdentity.postingLogins],
    },
    tags: [...spec.tags],
    notes: spec.notes,
    status: 'registering',
    failedStep: null,
    registeredAt,
    updatedAt: registeredAt,
  };
}

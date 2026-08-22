/**
 * The gate document, writer side (ARF-08).
 *
 * `gate/gate-client.mjs` is the *reader* and is deliberately permissive about
 * fields it does not know, so an older pipeline keeps working when a newer ARF
 * adds one. This module is the writer and is the opposite: it refuses unknown
 * keys, wrong types, and unknown path ids outright.
 *
 * The asymmetry is the point. A reader that rejected an unrecognised field
 * would turn "ARF shipped a new field" into "every merge path refuses"; a
 * writer that accepted one would let a hand-edited `armd: false` be written
 * back and read as an absent entry. Both directions fail closed, but only one
 * of them can afford to be strict.
 *
 * Pure functions only: no filesystem, no clock of its own. `gate-store.mjs`
 * supplies both.
 */

import { GATE_VERSION, MASTER_SCOPE, MERGE_PATHS, MERGE_PATH_IDS } from '../../../gate/gate-contract.mjs';

/** Longest an actor / reason may be. Attribution, not a changelog entry. */
const MAX_ACTOR_LENGTH = 128;
const MAX_REASON_LENGTH = 512;

const TOP_LEVEL_KEYS = new Set(['gateVersion', 'seq', 'updatedAt', 'master', 'paths']);
const ENTRY_KEYS = new Set(['armed', 'actor', 'reason', 'at']);

export class GateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GateError';
    this.code = code;
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireEntry(raw, where) {
  if (!isObject(raw)) throw new GateError('gate_malformed', `${where} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!ENTRY_KEYS.has(key)) {
      throw new GateError(
        'gate_malformed',
        `${where} has unknown key "${key}" (known: ${[...ENTRY_KEYS].join(', ')})`,
      );
    }
  }
  if (typeof raw.armed !== 'boolean') {
    throw new GateError('gate_malformed', `${where}.armed must be a boolean`);
  }
  for (const key of ['actor', 'reason', 'at']) {
    if (raw[key] !== null && raw[key] !== undefined && typeof raw[key] !== 'string') {
      throw new GateError('gate_malformed', `${where}.${key} must be a string or null`);
    }
  }
  return {
    armed: raw.armed,
    actor: raw.actor ?? null,
    reason: raw.reason ?? null,
    at: raw.at ?? null,
  };
}

/**
 * Validate `actor` / `reason`, which every change is required to carry.
 *
 * An unattributed kill-switch flip is not an acceptable audit record: the whole
 * value of the audit trail is answering "who stopped merges, and why" without a
 * chat-log archaeology exercise. So the API cannot accept a change without both.
 */
export function requireAttribution({ actor, reason }) {
  const cleanActor = typeof actor === 'string' ? actor.trim() : '';
  const cleanReason = typeof reason === 'string' ? reason.trim() : '';
  if (cleanActor === '') {
    throw new GateError('bad_request', 'actor is required: an unattributed arm/disarm is not auditable');
  }
  if (cleanReason === '') {
    throw new GateError('bad_request', 'reason is required: an unexplained arm/disarm is not auditable');
  }
  if (cleanActor.length > MAX_ACTOR_LENGTH) {
    throw new GateError('bad_request', `actor exceeds ${MAX_ACTOR_LENGTH} characters`);
  }
  if (cleanReason.length > MAX_REASON_LENGTH) {
    throw new GateError('bad_request', `reason exceeds ${MAX_REASON_LENGTH} characters`);
  }
  return { actor: cleanActor, reason: cleanReason };
}

/**
 * Validate a scope: a merge path id, or the master scope.
 *
 * A typo'd path id is refused rather than treated as the master scope. The
 * failure that would produce — an operator typing `--path hamer` and being told
 * everything is disarmed — is the one this whole surface exists to prevent.
 */
export function requireScope(scope) {
  if (scope === MASTER_SCOPE) return MASTER_SCOPE;
  if (MERGE_PATH_IDS.includes(scope)) return scope;
  throw new GateError(
    'bad_request',
    `scope must be "${MASTER_SCOPE}" or one of ${MERGE_PATH_IDS.join(', ')}, got ${JSON.stringify(scope)}`,
  );
}

/**
 * A fresh gate document with every path at `armed`.
 *
 * Created armed by default. Installing the gate is a packaging step; making it
 * *stop* things is an operator decision, and an install that silently halted a
 * running pipeline would be a worse surprise than one that does not. The
 * refusal-on-absence in the reader is what covers the other direction: once a
 * merge path is wired to a gate, deleting the file does not re-open it.
 */
export function createGateDocument({ armed = true, actor, reason, at }) {
  const attribution = requireAttribution({ actor, reason });
  const entry = { armed, ...attribution, at };
  return {
    gateVersion: GATE_VERSION,
    seq: 1,
    updatedAt: at,
    master: { ...entry },
    paths: Object.fromEntries(MERGE_PATH_IDS.map((id) => [id, { ...entry }])),
  };
}

/**
 * Parse a document strictly, for the read half of a read-modify-write.
 *
 * @param {unknown} raw parsed JSON
 * @returns {object} the normalized document
 */
export function normalizeGateDocument(raw) {
  if (!isObject(raw)) throw new GateError('gate_malformed', 'gate document must be a JSON object');
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new GateError(
        'gate_malformed',
        `gate document has unknown key "${key}" (known: ${[...TOP_LEVEL_KEYS].join(', ')})`,
      );
    }
  }
  if (raw.gateVersion !== GATE_VERSION) {
    // A document from a future ARF is not something to rewrite from an older
    // one: the write would silently downgrade whatever the newer version meant.
    throw new GateError(
      'gate_version_unsupported',
      `gate document is version ${JSON.stringify(raw.gateVersion)}; this ARF writes version ${GATE_VERSION}`,
    );
  }
  if (!Number.isInteger(raw.seq) || raw.seq < 1) {
    throw new GateError('gate_malformed', 'gate document seq must be a positive integer');
  }
  if (typeof raw.updatedAt !== 'string') {
    throw new GateError('gate_malformed', 'gate document updatedAt must be a string');
  }
  if (!isObject(raw.paths)) throw new GateError('gate_malformed', 'gate document paths must be an object');
  for (const id of Object.keys(raw.paths)) {
    if (!MERGE_PATH_IDS.includes(id)) {
      throw new GateError(
        'gate_malformed',
        `gate document carries unknown merge path "${id}" (known: ${MERGE_PATH_IDS.join(', ')})`,
      );
    }
  }

  const paths = {};
  for (const id of MERGE_PATH_IDS) {
    if (raw.paths[id] === undefined) {
      // A path this ARF knows about but the document does not carry. The reader
      // already refuses it (`path-absent`); normalizing it in as disarmed makes
      // the panel say so too, and the next write records it explicitly.
      paths[id] = { armed: false, actor: null, reason: null, at: null, missing: true };
      continue;
    }
    paths[id] = { ...requireEntry(raw.paths[id], `paths.${id}`), missing: false };
  }

  return {
    gateVersion: GATE_VERSION,
    seq: raw.seq,
    updatedAt: raw.updatedAt,
    master: requireEntry(raw.master, 'master'),
    paths,
  };
}

/** The on-disk form: normalization's `missing` marker is an ARF-side annotation. */
export function serializeGateDocument(document) {
  return {
    gateVersion: GATE_VERSION,
    seq: document.seq,
    updatedAt: document.updatedAt,
    master: {
      armed: document.master.armed,
      actor: document.master.actor,
      reason: document.master.reason,
      at: document.master.at,
    },
    paths: Object.fromEntries(MERGE_PATH_IDS.map((id) => {
      const entry = document.paths[id];
      return [id, { armed: entry.armed, actor: entry.actor, reason: entry.reason, at: entry.at }];
    })),
  };
}

/**
 * Apply one arm/disarm, returning a new document.
 *
 * `seq` increments on every write, including a no-op flip to the value already
 * held. That matters for the audit: "disarmed again at 04:12" is a real event
 * an operator performed, and collapsing it would lose the record of a second
 * operator arriving and confirming the stop.
 *
 * Disarming the master scope does **not** rewrite the per-path entries. The two
 * are independent so that arming back out of an emergency stop restores exactly
 * the per-path posture that was in force before it, rather than arming paths an
 * operator had deliberately left disarmed.
 */
export function applyGateChange(document, { scope, armed, actor, reason, at }) {
  const target = requireScope(scope);
  const attribution = requireAttribution({ actor, reason });
  if (typeof armed !== 'boolean') {
    throw new GateError('bad_request', `armed must be a boolean, got ${JSON.stringify(armed)}`);
  }
  const entry = { armed, ...attribution, at };
  const next = {
    gateVersion: GATE_VERSION,
    seq: document.seq + 1,
    updatedAt: at,
    master: { ...document.master },
    paths: Object.fromEntries(
      MERGE_PATH_IDS.map((id) => [id, { ...document.paths[id] }]),
    ),
  };
  if (target === MASTER_SCOPE) next.master = { ...entry };
  else next.paths[target] = { ...entry, missing: false };
  return next;
}

/**
 * The panel/API projection: the document plus what it means per path.
 *
 * `effective` is the answer a merge path would get right now, derived here the
 * same way the reader derives it — master first, then the per-path entry — so
 * the panel cannot show a path as armed that the gate would refuse.
 */
export function describeGateDocument(document) {
  return {
    gateVersion: document.gateVersion,
    seq: document.seq,
    updatedAt: document.updatedAt,
    master: { ...document.master },
    paths: MERGE_PATHS.map((path) => {
      const entry = document.paths[path.id];
      const effective = document.master.armed && entry.armed && !entry.missing;
      return {
        id: path.id,
        label: path.label,
        msm: path.msm,
        executor: path.executor,
        role: path.role,
        armed: entry.armed,
        // Split out so a renderer can say *why* an armed path still cannot
        // merge, rather than showing a contradiction between two green rows.
        masterArmed: document.master.armed,
        effective,
        effectiveReason: entry.missing
          ? 'the gate document carries no entry for this path; the reader refuses it'
          : !document.master.armed
            ? 'the master scope is disarmed (emergency stop)'
            : entry.armed
              ? 'armed'
              : 'this path is disarmed',
        actor: entry.actor,
        reason: entry.reason,
        at: entry.at,
      };
    }),
  };
}

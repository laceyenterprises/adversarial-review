/**
 * The honoring read path (ARF-08) — Node.
 *
 * This is the module a Node merge path embeds. It answers one question, in
 * constant time, with no restart required to see a flip. Import `ArfGate` from
 * this file, then:
 *
 *     const gate = new ArfGate(process.env.ARF_GATE_FILE);
 *     const decision = gate.decide('hammer');
 *     if (!decision.allowed) return refuse(decision);   // decision.code says why
 *
 * ## Why there is no cache
 *
 * The obvious optimisation is to `stat` the file and re-read only when the
 * mtime moved. It is deliberately not done, and the reason is a correctness
 * one rather than a taste one: mtime resolution is filesystem-dependent (one
 * second on HFS+), so two writes inside the same tick that produce the same
 * file size are indistinguishable to a stat-only check. The cache would then
 * serve the *pre-disarm* document for as long as the process ran — the exact
 * failure this ticket exists to remove, reintroduced one layer down.
 *
 * A cache would also buy nothing worth that risk. The read is one `open`, one
 * `fstat`, one `read` of a few hundred bytes, one `close` — four syscalls
 * against a page that is in the OS cache after the first call. A merge decision
 * that is about to make several GitHub API round-trips does not need it.
 *
 * ## Fail closed, always
 *
 * Every way of not getting a clear "armed" answer refuses the merge: no file,
 * no read permission, a truncated write, bytes that are not valid UTF-8, an
 * unknown version, a path the document does not carry. The refusal carries
 * `failClosed: true` so a caller
 * can tell "an operator disarmed this" from "the gate is broken" — but both
 * stop the merge, because a kill switch that opens when it breaks is not one.
 *
 * The one thing that is *not* fail-closed is having no gate at all: a merge
 * path that was never configured with a gate path never calls this module. That
 * is an operator's explicit decision to run without the gate, not a silent
 * fallback — `ArfGate` refuses to construct without a path.
 *
 * Imports: `node:fs` only. This file is written to be copied into a pipeline
 * repo verbatim if importing across trees is inconvenient; its only local
 * import is the contract beside it.
 */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

import {
  DECISION_CODES,
  GATE_VERSION,
  MASTER_SCOPE,
  MAX_GATE_BYTES,
  MERGE_PATH_IDS,
  exitCodeFor,
  isMergePath,
} from './gate-contract.mjs';

/**
 * The decoder every gate read goes through.
 *
 * `Buffer#toString('utf8')` is lenient: it replaces a malformed byte sequence
 * with U+FFFD and hands back a string, so a document with an invalid byte inside
 * a non-decision field — a `reason`, say — parses as perfectly good JSON here
 * while the Python client's `raw.decode("utf-8")` refuses the same file. That is
 * the `config-schema.multi-loader-parity` failure in its most dangerous form: the
 * Node merge paths would keep merging under a gate the Python backstop calls
 * broken. `fatal` makes the two contracts identical.
 *
 * `ignoreBOM: true` is not a relaxation — it means "do not strip a leading BOM",
 * which is what keeps a BOM-prefixed document malformed in *both* runtimes
 * rather than silently readable in this one.
 */
const GATE_TEXT_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Read at most `maxBytes` of `path` in one open/fstat/read/close.
 *
 * `fstat` on the already-open descriptor rather than `stat` on the path: the
 * size check and the read then describe the same file, so a document swapped
 * between the two calls cannot be read past its checked size. The oversize
 * refusal happens *before* the read, which is what keeps the cost constant
 * whatever the file on disk has become.
 *
 * @param {string} path
 * @param {number} maxBytes
 * @returns {{code: string|null, text: string|null, detail: string|null, bytes: number}}
 */
export function readGateBytes(path, maxBytes = MAX_GATE_BYTES) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return { code: 'gate-missing', text: null, detail: `no gate document at ${path}`, bytes: 0 };
    }
    return {
      code: 'gate-unreadable',
      text: null,
      detail: `${path}: ${err && err.message ? err.message : String(err)}`,
      bytes: 0,
    };
  }
  try {
    const size = fstatSync(fd).size;
    if (size > maxBytes) {
      return {
        code: 'gate-oversize',
        text: null,
        detail: `${path} is ${size} bytes; a gate document is bounded at ${maxBytes}`,
        bytes: size,
      };
    }
    const buffer = Buffer.allocUnsafe(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buffer, read, size - read, read);
      // A short read at a position inside the reported size means the file was
      // truncated under us — a half-written document, which JSON.parse would
      // reject anyway. Stop and let it.
      if (n <= 0) break;
      read += n;
    }
    let text;
    try {
      text = GATE_TEXT_DECODER.decode(buffer.subarray(0, read));
    } catch (err) {
      // Bytes that are not UTF-8 are not a gate document. Refusing here rather
      // than letting U+FFFD substitution carry them into `JSON.parse` is what
      // stops this client from allowing a merge the Python client refuses.
      return {
        code: 'gate-malformed',
        text: null,
        detail: `${path}: ${err && err.message ? err.message : String(err)}`,
        bytes: read,
      };
    }
    return { code: null, text, detail: null, bytes: read };
  } catch (err) {
    return {
      code: 'gate-unreadable',
      text: null,
      detail: `${path}: ${err && err.message ? err.message : String(err)}`,
      bytes: 0,
    };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // A descriptor that will not close is not a reason to fail a decision that
      // already has its answer; the process exiting reclaims it.
    }
  }
}

function refusal(pathId, code, detail, gate = null) {
  const spec = DECISION_CODES[code];
  return {
    path: pathId,
    allowed: false,
    code,
    failClosed: spec.failClosed,
    reason: detail ? `${spec.summary}: ${detail}` : spec.summary,
    gate,
    setBy: null,
    setAt: null,
    setReason: null,
  };
}

/** Whether a value is a plain (non-array, non-null) object. */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function gateSummary(document, path) {
  return {
    path,
    version: document.gateVersion,
    seq: Number.isInteger(document.seq) ? document.seq : null,
    updatedAt: typeof document.updatedAt === 'string' ? document.updatedAt : null,
  };
}

/**
 * Parse a gate document, refusing anything that is not unambiguously one.
 *
 * Additive fields are ignored — a later ARF may add them and this reader must
 * keep working — but every field a decision *depends* on is required and typed.
 * A `master.armed` that is the string `"false"` is malformed, not falsy: a gate
 * whose booleans are guessed at is not a gate.
 *
 * @param {string} text
 * @param {string} path for the refusal message
 * @returns {{document: object|null, code: string|null, detail: string|null}}
 */
export function parseGateDocument(text, path = '<gate>') {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { document: null, code: 'gate-malformed', detail: `${path}: ${err.message}` };
  }
  if (!isObject(parsed)) {
    return { document: null, code: 'gate-malformed', detail: `${path}: not a JSON object` };
  }
  if (parsed.gateVersion !== GATE_VERSION) {
    return {
      document: null,
      code: 'gate-version-unsupported',
      detail: `${path}: gateVersion ${JSON.stringify(parsed.gateVersion)}, this client speaks ${GATE_VERSION}`,
    };
  }
  if (!isObject(parsed.master) || typeof parsed.master.armed !== 'boolean') {
    return {
      document: null,
      code: 'gate-malformed',
      detail: `${path}: master.armed must be a boolean`,
    };
  }
  if (!isObject(parsed.paths)) {
    return { document: null, code: 'gate-malformed', detail: `${path}: paths must be an object` };
  }
  return { document: parsed, code: null, detail: null };
}

/**
 * Decide one merge path against an already-parsed document.
 *
 * Order is the safety property: the master scope is checked before the per-path
 * entry is looked up, so an emergency stop covers a path this document does not
 * enumerate — including one a newer ARF would add.
 *
 * @param {object} document
 * @param {string} pathId
 * @param {string} [gatePath]
 */
export function decideFromDocument(document, pathId, gatePath = '<gate>') {
  if (!isMergePath(pathId)) {
    return refusal(pathId, 'unknown-path', `known: ${MERGE_PATH_IDS.join(', ')}`);
  }
  const gate = gateSummary(document, gatePath);

  if (document.master.armed === false) {
    const master = document.master;
    return {
      path: pathId,
      allowed: false,
      code: 'disarmed-master',
      failClosed: false,
      reason: `${DECISION_CODES['disarmed-master'].summary}`,
      gate,
      setBy: typeof master.actor === 'string' ? master.actor : null,
      setAt: typeof master.at === 'string' ? master.at : null,
      setReason: typeof master.reason === 'string' ? master.reason : null,
    };
  }

  const entry = document.paths[pathId];
  if (!isObject(entry) || typeof entry.armed !== 'boolean') {
    return refusal(
      pathId,
      'path-absent',
      `${gatePath} carries no boolean paths.${pathId}.armed`,
      gate,
    );
  }

  const attribution = {
    setBy: typeof entry.actor === 'string' ? entry.actor : null,
    setAt: typeof entry.at === 'string' ? entry.at : null,
    setReason: typeof entry.reason === 'string' ? entry.reason : null,
  };
  const code = entry.armed ? 'armed' : 'disarmed-path';
  return {
    path: pathId,
    allowed: entry.armed,
    code,
    failClosed: false,
    reason: DECISION_CODES[code].summary,
    gate,
    ...attribution,
  };
}

/**
 * A gate bound to a path.
 *
 * Holds no state between calls beyond that path — deliberately, so there is
 * nothing that can go stale and no reason to bounce the process holding it.
 */
export class ArfGate {
  /**
   * @param {string} gatePath absolute path to the gate document
   * @param {object} [options]
   * @param {number} [options.maxBytes]
   * @param {(path: string, maxBytes: number) => object} [options.readBytes] injectable
   *   reader; the tests use it to count filesystem operations per decision.
   */
  constructor(gatePath, { maxBytes = MAX_GATE_BYTES, readBytes = readGateBytes } = {}) {
    if (typeof gatePath !== 'string' || gatePath.trim() === '') {
      // No default and no ambient discovery. A merge path that reaches here
      // without a configured gate has a configuration bug, and inventing a path
      // would turn it into a silent "no gate, merge away".
      throw new TypeError('ArfGate requires the gate document path (e.g. process.env.ARF_GATE_FILE)');
    }
    this.gatePath = gatePath;
    this.maxBytes = maxBytes;
    this.readBytes = readBytes;
  }

  /**
   * Load and parse the document, or the refusal code that stopped it.
   *
   * @returns {{document: object|null, code: string|null, detail: string|null}}
   */
  load() {
    const read = this.readBytes(this.gatePath, this.maxBytes);
    if (read.code) return { document: null, code: read.code, detail: read.detail };
    return parseGateDocument(read.text, this.gatePath);
  }

  /**
   * Decide a single merge path. One document read, whatever the load.
   *
   * @param {string} pathId one of the contract's merge path ids
   */
  decide(pathId) {
    const { document, code, detail } = this.load();
    if (!document) return refusal(pathId, code, detail);
    return decideFromDocument(document, pathId, this.gatePath);
  }

  /**
   * Decide every merge path from **one** read.
   *
   * Not a convenience: a caller that looped `decide()` over the paths would read
   * the document once per path and could observe a flip landing mid-loop, so
   * `hammer` and `daemon-clean` would answer from different documents. This is
   * how a caller gets a coherent snapshot.
   */
  decideAll() {
    const { document, code, detail } = this.load();
    const out = {};
    for (const id of MERGE_PATH_IDS) {
      out[id] = document
        ? decideFromDocument(document, id, this.gatePath)
        : refusal(id, code, detail);
    }
    return out;
  }

  /** The exit code `arf gate check` returns for a path. */
  exitCodeFor(pathId) {
    return exitCodeFor(this.decide(pathId));
  }
}

export { GATE_VERSION, MASTER_SCOPE, MAX_GATE_BYTES, MERGE_PATH_IDS, exitCodeFor, isMergePath };

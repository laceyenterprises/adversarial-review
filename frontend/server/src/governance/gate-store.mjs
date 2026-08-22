/**
 * The gate's write side and its audit trail (ARF-08).
 *
 * ARF is the only writer. The merge paths only ever read, through
 * `gate/gate-client.mjs` (Node) or `gate/arf_gate.py` (Python) — which is what
 * keeps the honoring side lock-free, sidecar-free, and safe to run as a
 * different OS user than ARF.
 *
 * Three properties this module is responsible for:
 *
 * **A reader never sees a partial document.** Every write goes to a scratch
 * file beside the target and is renamed over it, so a reader in the middle of a
 * flip gets the whole previous document or the whole new one. Same directory,
 * so the rename is same-device and therefore atomic.
 *
 * **Two concurrent flips do not lose one.** Arm/disarm is a read-modify-write
 * over a shared file — an operator in the panel and an operator at the CLI can
 * collide, and last-writer-wins would silently drop a disarm. The read, the
 * modify, and the rename happen under an exclusive lock file, and the API also
 * accepts an `expectedSeq` so a panel that read the state minutes ago cannot
 * clobber a flip it never saw.
 *
 * **A cross-uid reader can still read it.** The document and its directory are
 * written world-readable (0644 / 0755) on purpose: the pipeline daemons may run
 * as `agentos-worker` while ARF runs as the HQ owner, and a gate the honoring
 * side cannot open is a gate that fail-closes the pipeline the first time an
 * operator installs it.
 *
 * `describe()` computes its per-path answers by running the **reader client** —
 * not a second derivation. A panel that derived arm state independently could
 * disagree with the pipeline, and a governance panel that disagrees with the
 * thing it governs is worse than no panel.
 */

import {
  appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

import { ArfGate, readGateBytes } from '../../../gate/gate-client.mjs';
import { GATE_VERSION, MASTER_SCOPE, MERGE_PATH_IDS } from '../../../gate/gate-contract.mjs';
import { tempPathFor } from '../standup/atomic-file.mjs';
import {
  GateError, applyGateChange, createGateDocument, describeGateDocument, normalizeGateDocument,
  requireAttribution, requireScope, serializeGateDocument,
} from './gate-document.mjs';

/** World-readable by design — see the module header. */
const FILE_MODE = 0o644;
const DIR_MODE = 0o755;

/**
 * How long a lock whose holder *cannot be identified* may exist before a later
 * writer treats it as abandoned.
 *
 * This is deliberately not a timeout on a lock whose holder is known and alive.
 * A writer stalled in filesystem I/O past this age is still holding the lock,
 * and breaking it would put two read-modify-writes over the same document
 * concurrently — the lost-update this lock exists to prevent. It only applies to
 * a lock file we cannot read a live pid out of at all (a crash between the
 * `open` and the write leaves a zero-byte one), because otherwise that debris
 * would disarm the arm/disarm surface permanently.
 */
const LOCK_ABANDONED_MS = 10_000;
const LOCK_POLL_MS = 20;
const LOCK_ATTEMPTS = 100;

/** Bytes of the audit tail a read may walk. Bounds the panel's cost. */
const AUDIT_TAIL_BYTES = 64 * 1024;

/**
 * A synchronous sleep, for the lock retry loop.
 *
 * The whole store surface is synchronous (it mirrors the store adapter's shape),
 * and arm/disarm is a rare operator action, so a short blocking wait is simpler
 * and easier to reason about than making one path async. `Atomics.wait` is the
 * only way to do it without a dependency or a busy loop that pins a core.
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Whether `pid` is a live process.
 *
 * `EPERM` means it exists and belongs to somebody else — which is the normal
 * answer when ARF and the pipeline run as different users, and reading it as
 * "dead" would let a second writer steal a live lock.
 */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

export class GateStore {
  /**
   * @param {object} options
   * @param {string} options.gatePath
   * @param {string} options.auditPath
   * @param {() => number} [options.now]
   * @param {number} [options.lockAttempts] contended-lock retry budget
   * @param {number} [options.lockPollMs] wait between lock attempts
   */
  constructor({ gatePath, auditPath, now = Date.now, lockAttempts = LOCK_ATTEMPTS, lockPollMs = LOCK_POLL_MS }) {
    this.gatePath = gatePath;
    this.auditPath = auditPath;
    this.lockPath = `${gatePath}.lock`;
    this.now = now;
    // Injectable only so the tests can drive the wait-for-a-live-holder path in
    // milliseconds rather than seconds. Nothing in the app passes them, and a
    // load-dependent multi-second wait in a test is a flake, not coverage.
    this.lockAttempts = lockAttempts;
    this.lockPollMs = lockPollMs;
    // The same client a merge path embeds, so `describe()` cannot drift from
    // what the pipeline is actually told.
    this.reader = new ArfGate(gatePath);
  }

  /** ISO timestamp from the injected clock. */
  #stamp() {
    return new Date(this.now()).toISOString();
  }

  #ensureDir() {
    mkdirSync(dirname(this.gatePath), { recursive: true, mode: DIR_MODE });
  }

  /**
   * Prove the audit trail is writable *before* the gate document is mutated.
   *
   * A flip is two filesystem operations and the first one is durable: with
   * `ARF_GATE_AUDIT_FILE` pointed at a directory that does not exist, `init`
   * renamed `gate.json` into place and *then* threw `ENOENT` appending the audit
   * record. The caller saw the install fail while the gate was already live and
   * unattributed, and because `init` is idempotent, re-running it returned
   * `created: false` — so the missing record could never be recovered.
   *
   * Creating the audit directory and opening the file for append first turns
   * that whole class into a refusal that changes nothing on disk.
   */
  #prepareAudit() {
    try {
      mkdirSync(dirname(this.auditPath), { recursive: true, mode: DIR_MODE });
      closeSync(openSync(this.auditPath, 'a', FILE_MODE));
    } catch (err) {
      throw new GateError(
        'gate_unwritable',
        `the gate audit trail at ${this.auditPath} cannot be opened for append (${err?.message ?? err}); `
        + 'refusing before the gate is changed, so no unaudited flip can go into force',
      );
    }
  }

  /**
   * Read and strictly normalize the document, or `null` when there is none.
   *
   * Throws on a document that exists but is not a gate: an operator asking for
   * gate state when the file is corrupt needs to be told that, not handed an
   * empty state that reads like a fresh install.
   */
  read() {
    const raw = readGateBytes(this.gatePath);
    if (raw.code === 'gate-missing') return null;
    if (raw.code) throw new GateError(raw.code.replace(/-/g, '_'), raw.detail);
    let parsed;
    try {
      parsed = JSON.parse(raw.text);
    } catch (err) {
      throw new GateError('gate_malformed', `${this.gatePath}: ${err.message}`);
    }
    return normalizeGateDocument(parsed);
  }

  /**
   * How old the lock file is, in ms, or `Infinity` when that cannot be told.
   *
   * Prefers the filesystem's mtime over the `at` the holder recorded, because
   * this is only consulted for locks whose *contents* were unusable — a lock
   * truncated by a crash has no trustworthy `at` to read.
   */
  #lockAgeMs(holder) {
    try {
      return this.now() - statSync(this.lockPath).mtimeMs;
    } catch {
      const heldAt = Date.parse(holder?.at);
      return Number.isFinite(heldAt) ? this.now() - heldAt : Infinity;
    }
  }

  /**
   * Acquire the write lock, or throw once it is clear nobody is going to let go.
   *
   * Age alone never breaks a lock. The previous rule — `ageMs > LOCK_STALE_MS ||
   * !processAlive(pid)` — let a second writer unlink the lock of a *live* first
   * writer that had merely been slow (a filesystem stall inside the gate/audit
   * I/O is enough), so both read-modify-write sections ran concurrently and the
   * later rename silently dropped the earlier flip. That is precisely the
   * lost-update this lock exists to prevent, and an audit trail that has lost a
   * disarm is worse than no lock at all.
   *
   * So: a holder that is provably dead is broken immediately, whatever its age;
   * a holder that is alive is waited for, whatever its age; and only a lock we
   * cannot read a pid out of at all falls back to age, so crash debris cannot
   * jam arm/disarm forever. Waiting the full budget out is a retryable
   * `gate_locked`, not a steal.
   *
   * @returns {string} the owner token this call wrote, for `#unlock` to verify.
   */
  #lock() {
    this.#ensureDir();
    for (let attempt = 0; attempt < this.lockAttempts; attempt += 1) {
      const owner = randomUUID();
      let fd = null;
      let written = false;
      try {
        fd = openSync(this.lockPath, 'wx', FILE_MODE);
        writeFileSync(fd, JSON.stringify({ pid: process.pid, owner, at: this.#stamp() }));
        written = true;
        return owner;
      } catch (err) {
        if (!err || err.code !== 'EEXIST') {
          throw new GateError('gate_unwritable', `cannot lock ${this.gatePath}: ${err?.message ?? err}`);
        }
      } finally {
        // Closed on the success path and on a write failure alike: a descriptor
        // leaked per attempt would exhaust the process's limit over a long run.
        if (fd !== null) closeSync(fd);
        // We created the file but could not stamp it. Leaving it would be
        // unattributable debris that only the age fallback could ever clear, so
        // take it back out now.
        if (fd !== null && !written) {
          try {
            unlinkSync(this.lockPath);
          } catch {
            // Nothing better to do; the age fallback remains the backstop.
          }
        }
      }
      // Someone holds it. Identify them before deciding anything.
      let holder = null;
      try {
        holder = JSON.parse(readFileSync(this.lockPath, 'utf8'));
      } catch {
        // Unreadable, half-written, or removed between the EEXIST and this read.
      }
      const holderPid = Number.isInteger(holder?.pid) ? holder.pid : null;
      if (holderPid !== null) {
        if (processAlive(holderPid)) {
          // Live holder. Slow is not the same as gone; wait it out.
          sleepSync(this.lockPollMs);
          continue;
        }
        // Provably dead holder — safe to break at any age.
        this.#breakLock();
        continue;
      }
      // No usable pid. Treat a fresh one as held (a writer mid-`open`), and only
      // an old one as crash debris.
      if (this.#lockAgeMs(holder) > LOCK_ABANDONED_MS) {
        this.#breakLock();
        continue;
      }
      sleepSync(this.lockPollMs);
    }
    throw new GateError(
      'gate_locked',
      `${this.lockPath} is held by another writer; retry, or remove it if no ARF process is running`,
    );
  }

  /** Remove a lock this process has decided is not held by anyone live. */
  #breakLock() {
    try {
      unlinkSync(this.lockPath);
    } catch {
      // Another writer got there first; the next attempt will find out.
    }
  }

  /**
   * Release the lock this call acquired — and only that one.
   *
   * The token check is what makes the release safe in the presence of the
   * break path above: if our lock was broken and another writer re-created it,
   * an unconditional `unlink` here would remove *their* live lock on our way
   * out and hand a third writer a lock the second still thinks it holds.
   *
   * @param {string} owner the token `#lock()` returned
   */
  #unlock(owner) {
    let holder = null;
    try {
      holder = JSON.parse(readFileSync(this.lockPath, 'utf8'));
    } catch {
      // Already gone, or unreadable. Either way there is nothing of ours to
      // remove: a lock we cannot prove is ours is one we must not unlink.
      return;
    }
    if (holder?.owner !== owner) return;
    try {
      unlinkSync(this.lockPath);
    } catch {
      // Removed underneath us. Nothing to undo.
    }
  }

  /** Write-temp-then-rename, with the mode set before the rename. */
  #writeDocument(document) {
    const temp = tempPathFor(this.gatePath);
    // The mode goes on at creation rather than after the rename: a chmod after
    // the rename leaves a window in which the live document is unreadable to the
    // pipeline, and an unreadable gate fail-closes every merge path.
    writeFileSync(temp, `${JSON.stringify(serializeGateDocument(document), null, 2)}\n`, { mode: FILE_MODE });
    renameSync(temp, this.gatePath);
  }

  /**
   * Append one audit record. Call `#prepareAudit()` before mutating the gate.
   *
   * The pre-flight removes the ordinary reasons this fails, but it cannot make
   * the append infallible — a full disk, or the path being removed inside the
   * window, still can. When that happens the gate change is already durable, so
   * the error says so explicitly rather than reporting a generic write failure
   * that reads like nothing happened.
   */
  #appendAudit(record) {
    try {
      appendFileSync(this.auditPath, `${JSON.stringify(record)}\n`, { mode: FILE_MODE });
    } catch (err) {
      throw new GateError(
        'gate_audit_unwritable',
        `the gate change IS in force (seq ${record.seq}, ${record.event} ${record.scope}) but its audit record `
        + `could not be appended to ${this.auditPath}: ${err?.message ?? err}. Read ${this.gatePath} for the `
        + 'posture now in effect and restore the audit trail before the next flip.',
      );
    }
  }

  /**
   * Create the gate if it does not exist. Idempotent: an existing gate is
   * returned untouched rather than reset, so re-running an install script
   * cannot re-arm a path an operator disarmed.
   */
  init({ actor, reason, armed = true }) {
    requireAttribution({ actor, reason });
    const owner = this.#lock();
    try {
      let existing;
      try {
        existing = this.read();
      } catch (err) {
        // A document that exists but will not parse is not something to
        // overwrite: it could be a newer ARF's gate, and replacing it would
        // silently re-arm whatever that version was holding. Removing it is an
        // operator decision, so say that rather than making it here.
        throw new GateError(
          err.code ?? 'gate_malformed',
          `${this.gatePath} exists but is not a readable gate (${err.message}). Inspect it and remove `
          + 'it deliberately before re-installing; init will not overwrite a document it cannot read.',
        );
      }
      if (existing) return { created: false, document: existing };
      // Before anything durable changes: an install that writes gate.json and
      // then cannot record it is unrecoverable, because the next init sees the
      // gate and returns created:false.
      this.#prepareAudit();
      const at = this.#stamp();
      const document = createGateDocument({ armed, actor, reason, at });
      this.#writeDocument(document);
      this.#appendAudit({
        at, seq: document.seq, event: 'init', scope: MASTER_SCOPE, armed, actor, reason: String(reason).trim(),
        gateVersion: GATE_VERSION,
      });
      return { created: true, document };
    } finally {
      this.#unlock(owner);
    }
  }

  /**
   * Arm or disarm one scope.
   *
   * @param {object} change
   * @param {string} change.scope a merge path id, or `all`
   * @param {boolean} change.armed
   * @param {string} change.actor
   * @param {string} change.reason
   * @param {number} [change.expectedSeq] refuse if the document has moved since
   *   the caller read it — a panel open in a background tab must not be able to
   *   re-arm over a disarm it never saw.
   */
  set({ scope, armed, actor, reason, expectedSeq }) {
    const target = requireScope(scope);
    const attribution = requireAttribution({ actor, reason });
    const owner = this.#lock();
    try {
      const current = this.read();
      if (!current) {
        throw new GateError(
          'gate_missing',
          `no gate document at ${this.gatePath}; run "arf gate init" before arming or disarming`,
        );
      }
      if (expectedSeq !== undefined && expectedSeq !== null && current.seq !== expectedSeq) {
        throw new GateError(
          'gate_conflict',
          `gate has moved: expected seq ${expectedSeq}, found ${current.seq}; re-read and retry`,
        );
      }
      // Same ordering as init: prove the flip can be recorded before it is made.
      this.#prepareAudit();
      const at = this.#stamp();
      const next = applyGateChange(current, { scope: target, armed, at, ...attribution });
      this.#writeDocument(next);
      this.#appendAudit({
        at,
        seq: next.seq,
        event: armed ? 'arm' : 'disarm',
        scope: target,
        armed,
        ...attribution,
        gateVersion: GATE_VERSION,
        // The resulting posture, so one audit line answers "what was in force
        // after this" without replaying every line before it.
        effective: Object.fromEntries(MERGE_PATH_IDS.map((id) => [
          id, next.master.armed && next.paths[id].armed && !next.paths[id].missing,
        ])),
      });
      return { document: next, previousSeq: current.seq };
    } finally {
      this.#unlock(owner);
    }
  }

  /**
   * The last `limit` audit records, newest last.
   *
   * Only the tail of the file is read, so this stays bounded however long the
   * pipeline has been running. A truncated first line — the usual consequence of
   * starting a read mid-file — is dropped rather than reported as a corrupt
   * record.
   */
  auditTail(limit = 20) {
    // `slice(-0)` is `slice(0)`, which is the whole array — a caller asking for
    // no audit would be handed all of it.
    if (!Number.isInteger(limit) || limit < 1) return [];
    let fd;
    try {
      fd = openSync(this.auditPath, 'r');
    } catch {
      return [];
    }
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - AUDIT_TAIL_BYTES);
      const length = size - start;
      const buffer = Buffer.allocUnsafe(length);
      let read = 0;
      while (read < length) {
        const n = readSync(fd, buffer, read, length - read, start + read);
        if (n <= 0) break;
        read += n;
      }
      const lines = buffer.subarray(0, read).toString('utf8').split('\n');
      if (start > 0) lines.shift();
      const records = [];
      for (const line of lines) {
        if (line.trim() === '') continue;
        try {
          records.push(JSON.parse(line));
        } catch {
          // A line that is not JSON is a torn append, not a record. Skipping it
          // is right: an audit reader that threw would make one bad line hide
          // every good one after it.
        }
      }
      return records.slice(-limit);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * The `ar-govern` payload: what the gate says, and what a merge path is told.
   *
   * Never throws. A missing or corrupt gate is *reported*, because this is the
   * surface an operator opens to find out why merges stopped, and it failing
   * for the same reason merges are failing helps nobody.
   */
  describe({ auditLimit = 20 } = {}) {
    // The decisions come from the reader client — the same code the pipeline
    // runs — so this cannot report a path as armed that the gate would refuse.
    const decisions = this.reader.decideAll();
    const base = {
      gatePath: this.gatePath,
      auditPath: this.auditPath,
      gateVersion: GATE_VERSION,
      mergePaths: MERGE_PATH_IDS,
      decisions,
      // What a merge path would be told right now, per path, in one place.
      effective: Object.fromEntries(
        MERGE_PATH_IDS.map((id) => [id, decisions[id].allowed]),
      ),
      audit: this.auditTail(auditLimit),
    };

    let stat = null;
    try {
      const s = statSync(this.gatePath);
      stat = { sizeBytes: s.size, mode: (s.mode & 0o777).toString(8), modifiedAt: new Date(s.mtimeMs).toISOString() };
    } catch {
      stat = null;
    }

    let document = null;
    let error = null;
    try {
      document = this.read();
    } catch (err) {
      error = { code: err.code ?? 'gate_error', detail: String(err?.message ?? err) };
    }

    return {
      ...base,
      installed: document !== null,
      file: stat,
      error,
      gate: document ? describeGateDocument(document) : null,
    };
  }
}

/** Open the gate store the config points at. */
export function openGateStore(config, { now } = {}) {
  return new GateStore({
    gatePath: config.governance.gatePath,
    auditPath: config.governance.gateAuditPath,
    now,
  });
}

export { GateError };

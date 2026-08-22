/**
 * The arm/disarm gate contract (ARF-08) — the vocabulary both ends share.
 *
 * This module states, as data, everything a merge path and ARF must agree on:
 * the document version, the merge paths that can be armed, the decision codes,
 * and the process exit codes the shell integration uses. It is the single
 * source of truth, and `arf_gate.py` restates it; `test/gate-parity.test.mjs`
 * diffs the two and fails on drift.
 *
 * That diff is not ceremony. The recorded `config-schema.multi-loader-parity`
 * class is exactly this shape — a schema with more than one strict reader,
 * changed in one of them, taking a daemon down (or, here, changing what a kill
 * switch means) because the other never learned the new key.
 *
 * ## Why the gate is a small JSON file and not a table
 *
 * The gate is read on the merge hot path, by processes that may run as a
 * different OS user than ARF, and it must answer in constant time.
 *
 *   - **Constant time.** The document holds one entry per merge path — a fixed
 *     three — and nothing that grows with the number of PRs, reviews, findings,
 *     or rounds in flight. A gate whose read cost tracks load answers slowest
 *     under exactly the conditions an operator reaches for it.
 *   - **No sidecars.** SQLite in WAL mode creates `-wal` / `-shm` beside the
 *     database, owned by the *reading* process; a cross-uid reader therefore
 *     locks the writer out of its own file (SPEC §6, and the same outage class
 *     the store adapter guards). A plain file read creates nothing, takes no
 *     lock, and cannot lock anyone out.
 *   - **No bounce.** The document is read at the *decision*, not at boot, so a
 *     flip is in effect for an already-running daemon on its very next merge
 *     decision. That is the whole point of the ticket: the config-flag design
 *     it replaces needs a file edit plus a `launchctl bootout`/`bootstrap`
 *     before the flip means anything, and on 2026-07-26 two such halts did not
 *     stop live merges.
 *
 * ## Reader strictness is asymmetric, on purpose
 *
 * Readers (`gate-client.mjs`, `arf_gate.py`) **fail closed**: a missing,
 * unreadable, oversized, malformed, or unknown-version document refuses the
 * merge rather than allowing it. Unknown *additional* fields are ignored, so a
 * later ARF can add a field without stopping every pipeline that has not
 * updated yet.
 *
 * The writer (`server/src/governance/gate-store.mjs`) is the opposite: it
 * refuses unknown keys outright, so a hand-edited `armd: false` is rejected at
 * write time instead of becoming a path that reads as absent.
 */

/**
 * Gate document version.
 *
 * Bumped only when the *meaning* of an existing field changes — never to add
 * one. A reader that does not recognise the version refuses, because the
 * alternative is a client interpreting a v2 field's absence as "armed".
 */
export const GATE_VERSION = 1;

/**
 * Hard cap on the document a reader will load.
 *
 * The gate is a few hundred bytes by construction. The cap is what makes "O(1)
 * read" a property rather than an intention: an unbounded read of a file
 * something else has grown is neither constant-time nor safe, and a gate that
 * has grown is a bug whose correct handling is refusal, not a slow allow.
 */
export const MAX_GATE_BYTES = 64 * 1024;

/**
 * The merge paths, with the same ids ARF-04's Screen B derivation uses.
 *
 * Three, not two. The MSM model has two — `hammer` and `daemon-clean` — and the
 * ticket is about representing both. But the Python auto-merge daemon is a
 * third merge-capable actor that neither existing kill-switch key stops: it
 * never reads `autonomous_merge_execution_enabled`, and `enabled: false`
 * removes its deferral to the AMA closer rather than disabling it, so the "off"
 * position of that switch makes the backstop merge *sooner*. A gate that armed
 * only the two MSM paths would let an operator disarm both, read "stopped", and
 * watch merges continue.
 */
export const MERGE_PATHS = Object.freeze([
  Object.freeze({
    id: 'hammer',
    label: 'hammer',
    msm: true,
    executor: 'adversarial-watcher',
    role: 'Common path. Remediates every final finding, rebases, revalidates CI at the '
      + 'rebased head, and merges under its own lease.',
  }),
  Object.freeze({
    id: 'daemon-clean',
    label: 'daemon-clean',
    msm: true,
    executor: 'adversarial-watcher',
    role: 'Rare path. On a fully-clean settled review with green required checks, a '
      + 'mergeable PR, and a matching head, the watcher clicks merge inline.',
  }),
  Object.freeze({
    id: 'python-backstop',
    label: 'auto-merge backstop',
    msm: false,
    executor: 'auto-merge-daemon',
    role: 'Worker-pool lane that merges CLEAN + MERGEABLE gate decisions once the AMA '
      + 'deferral window lapses. No merge-authority config key disarms it.',
  }),
]);

/** Path ids, in document order. */
export const MERGE_PATH_IDS = Object.freeze(MERGE_PATHS.map((path) => path.id));

/** The two paths that make up the MSM two-path merge model. */
export const MSM_PATH_IDS = Object.freeze(MERGE_PATHS.filter((p) => p.msm).map((p) => p.id));

/**
 * The scope a single arm/disarm applies to.
 *
 * `all` is the emergency stop: one atomic write that disarms every path,
 * including a path a future ARF adds that this document does not enumerate —
 * because `master.armed: false` is checked before any per-path entry is even
 * looked up.
 */
export const MASTER_SCOPE = 'all';

/**
 * Every decision code a reader can return, and whether it permits a merge.
 *
 * `failClosed` marks the codes that refuse because the gate could not be
 * *established*, as opposed to refusing because an operator disarmed the path.
 * A caller logs the two differently: one is governance working, the other is
 * ARF or its state root being broken and needing an operator.
 */
export const DECISION_CODES = Object.freeze({
  armed: Object.freeze({ allowed: true, failClosed: false, summary: 'the gate arms this merge path' }),
  'disarmed-path': Object.freeze({ allowed: false, failClosed: false, summary: 'this merge path is disarmed' }),
  'disarmed-master': Object.freeze({ allowed: false, failClosed: false, summary: 'every merge path is disarmed (emergency stop)' }),
  'gate-missing': Object.freeze({ allowed: false, failClosed: true, summary: 'no gate document at the configured path' }),
  'gate-unreadable': Object.freeze({ allowed: false, failClosed: true, summary: 'the gate document could not be read' }),
  'gate-oversize': Object.freeze({ allowed: false, failClosed: true, summary: 'the gate document exceeds the size a gate can legitimately be' }),
  'gate-malformed': Object.freeze({ allowed: false, failClosed: true, summary: 'the gate document is not a well-formed gate' }),
  'gate-version-unsupported': Object.freeze({ allowed: false, failClosed: true, summary: 'the gate document is a version this client does not understand' }),
  'path-absent': Object.freeze({ allowed: false, failClosed: true, summary: 'the gate document carries no entry for this merge path' }),
  'unknown-path': Object.freeze({ allowed: false, failClosed: true, summary: 'not a merge path this contract defines' }),
});

/** Decision codes, in a stable order, for the parity diff. */
export const DECISION_CODE_IDS = Object.freeze(Object.keys(DECISION_CODES));

/**
 * Process exit codes for `arf gate check`, the integration a shell merge path
 * uses (`arf gate check --path hammer || exit`).
 *
 * `disarmed` and `refused` are separate values so a wrapper can page on one and
 * stay quiet on the other: a disarmed path is an operator decision, a
 * fail-closed refusal is a broken gate. Both stop the merge.
 */
export const EXIT_CODES = Object.freeze({
  allowed: 0,
  usage: 2,
  disarmed: 3,
  refused: 4,
});

/**
 * The whole contract as plain data.
 *
 * `arf_gate.py` exposes an identical `contract()`, and the parity test diffs
 * them. Anything a reader's behaviour depends on belongs in here — a constant
 * left out of this payload is a constant the parity gate cannot protect.
 */
export function contract() {
  return {
    gateVersion: GATE_VERSION,
    maxGateBytes: MAX_GATE_BYTES,
    masterScope: MASTER_SCOPE,
    mergePathIds: [...MERGE_PATH_IDS],
    msmPathIds: [...MSM_PATH_IDS],
    mergePaths: MERGE_PATHS.map((path) => ({ ...path })),
    decisionCodes: Object.fromEntries(
      DECISION_CODE_IDS.map((id) => [id, { ...DECISION_CODES[id] }]),
    ),
    exitCodes: { ...EXIT_CODES },
  };
}

/** Whether `id` is a merge path this contract defines. */
export function isMergePath(id) {
  return MERGE_PATH_IDS.includes(id);
}

/** The exit code a decision maps to. */
export function exitCodeFor(decision) {
  if (decision.allowed) return EXIT_CODES.allowed;
  return decision.failClosed ? EXIT_CODES.refused : EXIT_CODES.disarmed;
}

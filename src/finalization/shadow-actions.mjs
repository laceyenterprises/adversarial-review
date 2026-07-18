// Merge Authority v2 shadow mode — the v1 action vocabulary (ARC-16;
// docs/SPEC-merge-authority-v2.md §5). Shadow mode records, for every live
// finalization tick, a `(v1 action, v2 decision)` pair: what the frozen v1
// merge authority actually DID, next to what the pure v2 fold WOULD have
// decided. This module is the normalized vocabulary for the v1 half of that
// pair, plus a mapping from v1's frozen daemon-merge disposition onto it, so the
// divergence classifier compares like against like. Pure: no I/O, no clock.
//
// Contract shapes live in `../kernel/contracts.d.ts` (ShadowV1Action).

import { DAEMON_MERGE_DISPOSITION } from '../ama/daemon-merge.mjs';

/**
 * @typedef {import('../kernel/contracts.js').ShadowV1Action} ShadowV1Action
 * @typedef {import('../kernel/contracts.js').ShadowV1ActionKind} ShadowV1ActionKind
 */

/**
 * The normalized vocabulary for what frozen v1 did on a finalization tick.
 * `hammer-dispatch` is v1's terminal exhaustion hammer (a remediation dispatch
 * that then lands); `none` is "v1 held authority but took no action this tick".
 */
export const V1_ACTION_KINDS = Object.freeze([
  'merged',
  'hammer-dispatch',
  'remediate',
  'wait',
  'close',
  'escalate',
  'halt',
  'none',
]);

const V1_ACTION_KIND_SET = new Set(V1_ACTION_KINDS);

// Coarse comparison buckets. Two actions/decisions AGREE when they land in the
// same bucket — this is what "v1 and v2 concur" means for divergence counting.
// `escalate`/`halt` share a `stop` bucket: both page an operator and mutate
// nothing, so v1-escalate vs v2-halt is concurrence, not a divergence.
const V1_BUCKET = Object.freeze({
  merged: 'land',
  'hammer-dispatch': 'remediate',
  remediate: 'remediate',
  wait: 'wait',
  none: 'wait',
  close: 'close',
  escalate: 'stop',
  halt: 'stop',
});

const V2_BUCKET = Object.freeze({
  'finalize-now': 'land',
  remediate: 'remediate',
  close: 'close',
  wait: 'wait',
  escalate: 'stop',
  halt: 'stop',
});

/** The comparison bucket for a normalized v1 action kind. */
export function v1ActionBucket(kind) {
  return V1_BUCKET[kind] ?? null;
}

/** The comparison bucket for a v2 eligibility decision kind. */
export function v2DecisionBucket(kind) {
  return V2_BUCKET[kind] ?? null;
}

/**
 * Normalize the v1 half of a shadow pair. Accepts a bare kind string or a
 * `{ kind, detail?, sourceRef? }` object; validates the kind against the frozen
 * vocabulary so a typo can never silently become an "agree".
 *
 * @param {ShadowV1ActionKind | ShadowV1Action} raw
 * @returns {ShadowV1Action}
 */
export function normalizeV1Action(raw) {
  if (typeof raw === 'string') {
    if (!V1_ACTION_KIND_SET.has(raw)) {
      throw new TypeError(`unknown v1 action kind: ${JSON.stringify(raw)}`);
    }
    return { kind: raw };
  }
  if (!raw || typeof raw !== 'object' || !V1_ACTION_KIND_SET.has(raw.kind)) {
    throw new TypeError(`v1 action requires a kind in ${V1_ACTION_KINDS.join('|')}`);
  }
  /** @type {ShadowV1Action} */
  const action = { kind: raw.kind };
  if (raw.detail != null) action.detail = String(raw.detail);
  if (raw.sourceRef != null) action.sourceRef = String(raw.sourceRef);
  return action;
}

/**
 * Map v1's frozen daemon-merge disposition (`DAEMON_MERGE_DISPOSITION`) onto the
 * normalized shadow vocabulary. `failed-closed` is a fail-closed page (`stop`),
 * `deferred` re-evaluates next tick (`wait`), `not-taken` means v1 declined
 * authority this tick (`none`). The hammer/close actions are observed elsewhere
 * (they are not daemon-clean-merge dispositions).
 *
 * @param {string} disposition
 * @returns {ShadowV1Action}
 */
export function v1ActionFromDaemonDisposition(disposition) {
  switch (disposition) {
    case DAEMON_MERGE_DISPOSITION.MERGED:
      return { kind: 'merged' };
    case DAEMON_MERGE_DISPOSITION.FAILED_CLOSED:
      return { kind: 'escalate', detail: 'v1 daemon-merge failed closed' };
    case DAEMON_MERGE_DISPOSITION.DEFERRED:
      return { kind: 'wait' };
    case DAEMON_MERGE_DISPOSITION.NOT_TAKEN:
      return { kind: 'none' };
    default:
      throw new TypeError(`unknown daemon-merge disposition: ${JSON.stringify(disposition)}`);
  }
}

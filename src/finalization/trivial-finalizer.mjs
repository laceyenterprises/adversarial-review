// Trivial finalizers for non-code domains (v2 app architecture Phase 3 /
// ARC-14). A non-code subject — e.g. a `research-finding` — has no merge, no CI,
// and no lease: "finalization" is simply marking the subject terminal or
// archiving it once its review is clean. This module implements that behind the
// `FinalizationPort`, reusing the kernel's verdict disposition logic so the
// decision matches how the review pipeline already reads a subject's outcome.
//
// `evaluate` is pure and deterministic in `subjectState` (its `observedAt` is
// the fold timestamp); `execute` performs the terminal action via an injected
// `markTerminal(subjectRef)` callback so the module carries no I/O of its own.
// Contract shapes live in `../kernel/contracts.d.ts`.

import { classifyVerdictDisposition, resolveLatestVerdict } from '../kernel/pipeline.mjs';
import { finalizeNow, halt, makeOutcome, remediate, wait } from './finalization-port.mjs';

/**
 * @typedef {import('../kernel/contracts.js').SubjectRef} SubjectRef
 * @typedef {import('../kernel/contracts.js').SubjectState} SubjectState
 * @typedef {import('../kernel/contracts.js').FinalizationDecision} FinalizationDecision
 * @typedef {import('../kernel/contracts.js').FinalizationOutcome} FinalizationOutcome
 * @typedef {import('../kernel/contracts.js').FinalizationPort} FinalizationPort
 */

/** The terminal action a trivial finalizer performs on `finalize-now`. */
export const TRIVIAL_FINALIZER_MODES = Object.freeze(['mark-terminal', 'archive']);

function isTerminalState(subjectState) {
  if (subjectState?.terminal === true) return true;
  const lifecycle = subjectState?.lifecycle;
  return lifecycle === 'finalized' || lifecycle === 'terminal';
}

function remediationBudgetRemaining(subjectState) {
  const completed = Number(subjectState?.completedRemediationRounds ?? 0);
  const max = Number(subjectState?.maxRemediationRounds ?? 0);
  if (!Number.isFinite(completed) || !Number.isFinite(max)) return 0;
  return Math.max(0, max - completed);
}

/**
 * Create a trivial finalization port for a non-code domain.
 *
 * `evaluate(subjectState)`:
 *   - already terminal            → `finalize-now` (idempotent; `execute` skips)
 *   - operator halt / haltReason  → `halt`
 *   - clean current-revision verdict → `finalize-now`
 *   - blocking verdict, budget left  → `remediate` (next round, active stage)
 *   - blocking verdict, budget spent → `halt` (a non-code domain never
 *     force-lands; it pages instead of merging past unresolved findings)
 *   - no / indeterminate current-revision verdict → `wait`
 *
 * `execute(decision)`:
 *   - `finalize-now` on a live subject → `markTerminal(subjectRef)` → `executed`
 *     (`skipped` when the subject is already terminal — idempotent)
 *   - every other kind → `skipped` with action `none` (a trivial finalizer owns
 *     only the terminal action; remediation dispatch belongs to the review loop)
 *
 * @param {{
 *   domainId: string,
 *   mode?: 'mark-terminal' | 'archive',
 *   markTerminal: (ref: SubjectRef, decision: FinalizationDecision) => unknown | Promise<unknown>,
 * }} options
 * @returns {FinalizationPort}
 */
export function createTrivialFinalizer({ domainId, mode = 'mark-terminal', markTerminal } = {}) {
  if (typeof domainId !== 'string' || domainId === '') {
    throw new TypeError('createTrivialFinalizer requires a domainId');
  }
  if (!TRIVIAL_FINALIZER_MODES.includes(mode)) {
    throw new TypeError(`unknown trivial finalizer mode: ${JSON.stringify(mode)}`);
  }
  if (typeof markTerminal !== 'function') {
    throw new TypeError('createTrivialFinalizer requires a markTerminal(ref) callback');
  }

  return {
    domainId,

    evaluate(subjectState) {
      const observedAt = subjectState?.observedAt;
      if (!observedAt) {
        throw new TypeError('trivial finalizer evaluate requires subjectState.observedAt');
      }
      const fields = { observedAt };

      if (isTerminalState(subjectState)) {
        return finalizeNow(subjectState, { ...fields, reason: 'already terminal' });
      }
      if (subjectState?.lifecycle === 'halted' || subjectState?.haltReason) {
        return halt(subjectState, { ...fields, reason: subjectState?.haltReason || 'operator halt' });
      }

      const verdict = resolveLatestVerdict(subjectState);
      if (!verdict) {
        return wait(subjectState, { ...fields, reason: 'no current-revision verdict yet' });
      }

      const disposition = classifyVerdictDisposition(verdict);
      if (disposition === 'clean') {
        return finalizeNow(subjectState, fields);
      }
      if (disposition === 'blocking') {
        const remaining = remediationBudgetRemaining(subjectState);
        if (remaining > 0) {
          return remediate(subjectState, {
            ...fields,
            stageId: verdict.stageId,
            round: Number(subjectState?.completedRemediationRounds ?? 0) + 1,
          });
        }
        return halt(subjectState, { ...fields, reason: 'remediation budget exhausted' });
      }
      // indeterminate (an `unknown` verdict): the reviewer has not settled.
      return wait(subjectState, { ...fields, reason: 'verdict indeterminate' });
    },

    async execute(decision) {
      const observedAt = decision?.observedAt;
      if (decision?.kind !== 'finalize-now') {
        return makeOutcome(decision, { status: 'skipped', action: 'none', observedAt });
      }
      if (decision?.reason === 'already terminal') {
        return makeOutcome(decision, {
          status: 'skipped',
          action: mode,
          observedAt,
          detail: 'subject already terminal',
        });
      }
      await markTerminal(decision.subjectRef, decision);
      return makeOutcome(decision, { status: 'executed', action: mode, observedAt });
    },
  };
}

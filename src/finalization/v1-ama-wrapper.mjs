// v1 AMA wrapped UNCHANGED behind the finalization port, for the `code-pr`
// domain (v2 app architecture Phase 3 / ARC-14). This is a WRAPPER ONLY: it adds
// no merge-authority logic of its own. The decision comes from v1's frozen
// findings gate (`isDaemonMergeReviewAllowed`, `src/ama/daemon-merge.mjs`); the
// action is delegated to injected v1 entrypoints, and their frozen disposition
// vocabulary (`DAEMON_MERGE_DISPOSITION`) is mapped onto the port's outcome
// statuses. The ARC-01 freeze holds — nothing under `src/ama/` is modified, and
// this port is not wired into the production watcher here; it exists so MA-v2
// (ARC-15/16) can be shadowed against v1 through one comparable seam.
//
// Faithfulness is the whole point (the parity fixtures prove it): for any
// subject, `evaluate` routes the review outcome through the SAME v1 predicate the
// daemon clean-merge path uses, so a bug fix to that frozen gate moves the
// wrapper with it. Contract shapes live in `../kernel/contracts.d.ts`.

import { DAEMON_MERGE_DISPOSITION, isDaemonMergeReviewAllowed } from '../ama/daemon-merge.mjs';
import { classifyVerdictDisposition, resolveLatestVerdict } from '../kernel/pipeline.mjs';
import { finalizeNow, halt, makeOutcome, remediate, wait } from './finalization-port.mjs';

/**
 * @typedef {import('../kernel/contracts.js').SubjectRef} SubjectRef
 * @typedef {import('../kernel/contracts.js').SubjectState} SubjectState
 * @typedef {import('../kernel/contracts.js').Verdict} Verdict
 * @typedef {import('../kernel/contracts.js').FinalizationDecision} FinalizationDecision
 * @typedef {import('../kernel/contracts.js').FinalizationOutcome} FinalizationOutcome
 * @typedef {import('../kernel/contracts.js').FinalizationActionStatus} FinalizationActionStatus
 * @typedef {import('../kernel/contracts.js').FinalizationPort} FinalizationPort
 */

/**
 * Map v1's frozen daemon-merge disposition (`DAEMON_MERGE_DISPOSITION`) onto the
 * port's action status. `merged` is the only executing outcome; `failed-closed`
 * is a fail-closed attempt; `deferred` re-evaluates next tick; `not-taken` means
 * v1 declined authority this tick (another principal holds it), so no action was
 * taken by this path.
 *
 * @param {string} disposition
 * @returns {FinalizationActionStatus}
 */
export function mapDaemonMergeDisposition(disposition) {
  switch (disposition) {
    case DAEMON_MERGE_DISPOSITION.MERGED:
      return 'executed';
    case DAEMON_MERGE_DISPOSITION.FAILED_CLOSED:
      return 'failed';
    case DAEMON_MERGE_DISPOSITION.DEFERRED:
      return 'deferred';
    case DAEMON_MERGE_DISPOSITION.NOT_TAKEN:
      return 'skipped';
    default:
      throw new TypeError(`unknown daemon-merge disposition: ${JSON.stringify(disposition)}`);
  }
}

/**
 * Project a subject's kernel verdict onto v1's daemon-clean findings review
 * state. A settled clean/comment-only verdict carries zero findings; a blocking
 * verdict (request-changes, or a structured blocking finding) carries at least
 * one; an indeterminate/absent verdict is `unknown` — which v1's gate fails
 * closed on, exactly as it should. The kernel `Verdict` has no separate
 * non-blocking list, so a non-blocking count of 0 is reported for a clean
 * verdict; strict-mode is therefore driven by the blocking classification.
 *
 * @param {Verdict | null | undefined} verdict
 * @returns {{ blockingFindingCount?: number, blockingFindingState: string,
 *   nonBlockingFindingCount?: number, nonBlockingFindingState: string }}
 */
export function projectReviewState(verdict) {
  if (!verdict) {
    return { blockingFindingState: 'unknown', nonBlockingFindingState: 'unknown' };
  }
  const disposition = classifyVerdictDisposition(verdict);
  if (disposition === 'indeterminate') {
    return { blockingFindingState: 'unknown', nonBlockingFindingState: 'unknown' };
  }
  const structuredBlocking = Array.isArray(verdict.blockingFindings) ? verdict.blockingFindings.length : 0;
  const blockingFindingCount = disposition === 'blocking' ? Math.max(1, structuredBlocking) : 0;
  return {
    blockingFindingCount,
    blockingFindingState: 'known',
    nonBlockingFindingCount: 0,
    nonBlockingFindingState: 'known',
  };
}

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
 * Create the `code-pr` finalization port that wraps unchanged v1 AMA.
 *
 * `evaluate(subjectState)` (pure, deterministic in `subjectState`):
 *   - already terminal            → `finalize-now` (idempotent; `execute` skips)
 *   - operator halt / haltReason  → `halt`
 *   - v1 findings gate allows merge (`isDaemonMergeReviewAllowed`) → `finalize-now`
 *   - blocking verdict, budget left  → `remediate` (next round)
 *   - blocking verdict, budget spent → `remediate` (exhaustion final round —
 *     v2 §3 "exhaustion closes by landing": v1's terminal hammer lands the PR)
 *   - verdict absent / indeterminate → `wait`
 *
 * `execute(decision)` delegates to injected v1 entrypoints; NOTHING under
 * `src/ama/` is called except through these callbacks, so a caller that omits an
 * action gets a no-op-safe error rather than an accidental live mutation:
 *   - `finalize-now` → `actions.merge(decision)` returning a
 *     `DAEMON_MERGE_DISPOSITION`, mapped via {@link mapDaemonMergeDisposition}
 *   - `remediate`    → `actions.remediate(decision)` (dispatch a v1 remediation)
 *   - `halt`         → `actions.halt(decision)` (page)
 *   - `escalate`     → `actions.escalate(decision)` (fail-closed page)
 *   - `wait`         → `skipped` / action `none` (no v1 call)
 *
 * @param {{
 *   domainId?: string,
 *   strictMode?: boolean,
 *   actions?: {
 *     merge?: (d: FinalizationDecision) => string | { disposition: string, detail?: string } | Promise<string | { disposition: string, detail?: string }>,
 *     remediate?: (d: FinalizationDecision) => unknown | Promise<unknown>,
 *     halt?: (d: FinalizationDecision) => unknown | Promise<unknown>,
 *     escalate?: (d: FinalizationDecision) => unknown | Promise<unknown>,
 *   },
 * }} [options]
 * @returns {FinalizationPort}
 */
export function createV1AmaFinalizationPort({ domainId = 'code-pr', strictMode = true, actions = {} } = {}) {
  function requireAction(name) {
    const fn = actions?.[name];
    if (typeof fn !== 'function') {
      throw new TypeError(`v1 AMA finalization port: missing injected action "${name}"`);
    }
    return fn;
  }

  return {
    domainId,

    evaluate(subjectState) {
      const observedAt = subjectState?.observedAt;
      if (!observedAt) {
        throw new TypeError('v1 AMA finalizer evaluate requires subjectState.observedAt');
      }
      const fields = { observedAt };

      if (isTerminalState(subjectState)) {
        return finalizeNow(subjectState, { ...fields, reason: 'already terminal' });
      }
      if (subjectState?.lifecycle === 'halted' || subjectState?.haltReason) {
        return halt(subjectState, { ...fields, reason: subjectState?.haltReason || 'operator halt' });
      }

      const verdict = resolveLatestVerdict(subjectState);
      const reviewState = projectReviewState(verdict);

      // The frozen v1 findings gate decides "is the review clean enough to
      // merge?" — the wrapper adds nothing on top of it.
      if (isDaemonMergeReviewAllowed(reviewState, { strictMode })) {
        return finalizeNow(subjectState, fields);
      }

      // Not clean. Distinguish "not yet known" (wait) from "findings present"
      // (remediate) using the same disposition the gate saw.
      const disposition = classifyVerdictDisposition(verdict);
      if (!verdict || disposition === 'indeterminate') {
        return wait(subjectState, { ...fields, reason: 'no settled current-revision verdict' });
      }

      const round = Number(subjectState?.completedRemediationRounds ?? 0) + 1;
      const remaining = remediationBudgetRemaining(subjectState);
      return remediate(subjectState, {
        ...fields,
        stageId: verdict.stageId,
        round,
        ...(remaining > 0 ? {} : { reason: 'exhaustion final round' }),
      });
    },

    async execute(decision) {
      const observedAt = decision?.observedAt;
      switch (decision?.kind) {
        case 'finalize-now': {
          if (decision.reason === 'already terminal') {
            return makeOutcome(decision, {
              status: 'skipped',
              action: 'merge',
              observedAt,
              detail: 'subject already terminal',
            });
          }
          const raw = await requireAction('merge')(decision);
          const disposition = typeof raw === 'string' ? raw : raw?.disposition;
          const detail = typeof raw === 'object' && raw ? raw.detail : undefined;
          return makeOutcome(decision, {
            status: mapDaemonMergeDisposition(disposition),
            action: 'merge',
            observedAt,
            detail,
          });
        }
        case 'remediate': {
          await requireAction('remediate')(decision);
          return makeOutcome(decision, { status: 'executed', action: 'dispatch-remediation', observedAt });
        }
        case 'halt': {
          await requireAction('halt')(decision);
          return makeOutcome(decision, { status: 'executed', action: 'halt', observedAt });
        }
        case 'escalate': {
          await requireAction('escalate')(decision);
          return makeOutcome(decision, { status: 'executed', action: 'escalate', observedAt });
        }
        case 'wait':
          return makeOutcome(decision, { status: 'skipped', action: 'none', observedAt });
        default:
          throw new TypeError(`v1 AMA finalization port cannot execute kind ${JSON.stringify(decision?.kind)}`);
      }
    },
  };
}

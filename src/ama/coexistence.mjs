import { isScopedMergeAgentRequest } from '../follow-up-merge-agent.mjs';

/**
 * AMA-06N — watcher-side coexistence decision for the merge-agent
 * dispatch.
 *
 * The agent-os half (AMA-06A) installs an admit-gate that refuses
 * `worker_class=merge-agent` dispatches when
 * `cfg.roles.adversarial.merge_authority.enabled === true` AND the
 * dispatch env does NOT carry the operator-fallback flag. This module
 * is the adversarial-review half: the watcher chooses one of four
 * actions per settled-success event, and on the operator-fallback
 * lane it sets the env flag the AMA-06A gate looks for.
 *
 * Env-var contract (canonical from AMA-06A; AMA-06N MUST set
 * BYTE-FOR-BYTE the same name + value):
 *
 *   AMA_OPERATOR_MERGE_AGENT_OVERRIDE=true
 *
 * Only the exact lowercase string `"true"` is the bypass on the
 * agent-os admit gate. AMA-06A intentionally rejects `"True"`, `"1"`,
 * etc. — this module's `MERGE_AGENT_OPERATOR_FALLBACK_ENV_VALUE`
 * matches that contract.
 *
 * Decision table per SPEC §4.8:
 *
 *   cfg.enabled   merge-agent-requested label (current-head, fresh)
 *   ────────────  ────────────────────────────────────────────────────
 *   false         (any)                          → merge-agent (default)
 *   true          absent                         → AMA closer (default)
 *                                                  OR await operator
 *                                                  when AMA not eligible
 *   true          present                        → merge-agent WITH
 *                                                  override env
 *
 * The `await operator` path is critical: SPEC §4.8 explicitly states
 * the watcher must NOT silently fall back to merge-agent when AMA is
 * enabled but not eligible. The operator either fixes eligibility
 * (apply `operator-approved` / `adversarial-merge-requested`) OR
 * explicitly applies `merge-agent-requested` for the fallback lane.
 *
 * @module ama/coexistence
 */

export const MERGE_AGENT_OPERATOR_FALLBACK_ENV =
  'AMA_OPERATOR_MERGE_AGENT_OVERRIDE';
export const MERGE_AGENT_OPERATOR_FALLBACK_ENV_VALUE = 'true';

/**
 * Decision codes the helper returns. The watcher branches on these.
 *
 *   merge-agent-default               cfg.enabled=false; dispatch merge-agent
 *                                     with no override env (current behavior).
 *   ama-closer                        AMA fired (handled before this helper).
 *                                     Re-emitted here only for symmetry; the
 *                                     watcher returns immediately on it.
 *   ama-closer-pending                AMA dispatch is in-flight (lease held
 *                                     or pending status probe); watcher
 *                                     should NOT also dispatch merge-agent.
 *   merge-agent-operator-fallback     cfg.enabled=true AND a current-head
 *                                     non-author merge-agent-requested
 *                                     label is present. Dispatch merge-
 *                                     agent WITH the override env.
 *   merge-agent-recovery-fallback     AMA dispatch/status failure on an
 *                                     otherwise eligible handoff. Dispatch
 *                                     merge-agent WITH the override env so
 *                                     the watcher recovers instead of
 *                                     parking indefinitely.
 *   await-operator-action             cfg.enabled=true AND AMA NOT eligible
 *                                     AND NO merge-agent-requested. Watcher
 *                                     logs an info line and does NOT
 *                                     dispatch anything.
 */
export const COEXISTENCE_ACTION = Object.freeze({
  MERGE_AGENT_DEFAULT: 'merge-agent-default',
  AMA_CLOSER: 'ama-closer',
  AMA_CLOSER_PENDING: 'ama-closer-pending',
  MERGE_AGENT_OPERATOR_FALLBACK: 'merge-agent-operator-fallback',
  MERGE_AGENT_RECOVERY_FALLBACK: 'merge-agent-recovery-fallback',
  AWAIT_OPERATOR_ACTION: 'await-operator-action',
});

/**
 * Detect a current-head, attributable, fresh
 * `merge-agent-requested` operator label event. Returns false when
 * the event is missing, stale (different head), non-attributable,
 * missing audit fields, or older than the latest PR update on that
 * same head.
 *
 * @param {Object|null} event           Legacy label-event shape (operator-controls adapter).
 * @param {Object} prMetadata
 * @param {string} prMetadata.headSha   The PR's current head SHA.
 * @param {string=} prMetadata.prUpdatedAt Latest known PR update timestamp for the current head.
 * @returns {boolean}
 */
export function isMergeAgentRequestedScoped(event, prMetadata) {
  return isScopedMergeAgentRequest({
    headSha: prMetadata?.headSha || null,
    prUpdatedAt: prMetadata?.prUpdatedAt || null,
    mergeAgentRequest: {
      actor: event?.actor || null,
      createdAt: event?.createdAt || null,
      headSha: event?.headSha || event?.head_sha || event?.observedRevisionRef || null,
      prUpdatedAt: event?.prUpdatedAt || prMetadata?.prUpdatedAt || null,
      labelEventId: event?.id || event?.labelEventId || null,
      labelEventNodeId: event?.nodeId || event?.labelEventNodeId || null,
    },
  });
}

/**
 * Pure-function decision for what the watcher should do after the
 * AMA-03 closer attempt. The caller already knows whether
 * `maybeDispatchAmaCloser` fired (`amaClosureDispatched=true`),
 * pending (`amaClosurePending=true`), or returned not-eligible.
 *
 * Decision precedence:
 *
 *   1. AMA fired → AMA-CLOSER (no merge-agent on this tick).
 *   2. AMA pending (lease/dispatch in-flight) → AMA-CLOSER-PENDING.
 *   3. cfg.enabled=false → MERGE-AGENT-DEFAULT (current behavior).
 *   4. cfg.enabled=true + current-head non-author `merge-agent-requested`
 *      → MERGE-AGENT-OPERATOR-FALLBACK (with override env).
 *   5. cfg.enabled=true + AMA launch/status failure + no operator fallback
 *      → MERGE-AGENT-RECOVERY-FALLBACK.
 *   6. cfg.enabled=true + AMA NOT eligible + no operator fallback
 *      → AWAIT-OPERATOR-ACTION.
 *
 * @param {Object} args
 * @param {boolean} args.amaEnabled
 * @param {boolean} args.amaClosureDispatched
 * @param {boolean=} args.amaClosurePending
 * @param {boolean=} args.amaClosureEligibilityMiss
 * @param {boolean=} args.amaClosureRecoverableFailure
 * @param {boolean} args.mergeAgentRequestedScoped
 * @returns {{ action: string }}
 */
export function decideMergeAgentCoexistence({
  amaEnabled,
  amaClosureDispatched,
  amaClosurePending = false,
  amaClosureEligibilityMiss = false,
  amaClosureRecoverableFailure = false,
  mergeAgentRequestedScoped,
}) {
  if (amaClosureDispatched) {
    return { action: COEXISTENCE_ACTION.AMA_CLOSER };
  }
  if (amaClosurePending) {
    return { action: COEXISTENCE_ACTION.AMA_CLOSER_PENDING };
  }
  if (!amaEnabled) {
    return { action: COEXISTENCE_ACTION.MERGE_AGENT_DEFAULT };
  }
  if (mergeAgentRequestedScoped) {
    return { action: COEXISTENCE_ACTION.MERGE_AGENT_OPERATOR_FALLBACK };
  }
  if (amaClosureRecoverableFailure && !amaClosureEligibilityMiss) {
    return { action: COEXISTENCE_ACTION.MERGE_AGENT_RECOVERY_FALLBACK };
  }
  return { action: COEXISTENCE_ACTION.AWAIT_OPERATOR_ACTION };
}

/**
 * Build the env override the watcher should pass to
 * `dispatchMergeAgentForPR` when the action is
 * `MERGE_AGENT_OPERATOR_FALLBACK`. Returns `null` for the other
 * actions — the caller spreads `null` as the empty case.
 *
 * @param {string} action
 * @returns {Object<string,string>|null}
 */
export function mergeAgentDispatchEnvForAction(action) {
  if (
    action !== COEXISTENCE_ACTION.MERGE_AGENT_OPERATOR_FALLBACK
    && action !== COEXISTENCE_ACTION.MERGE_AGENT_RECOVERY_FALLBACK
  ) {
    return null;
  }
  return {
    [MERGE_AGENT_OPERATOR_FALLBACK_ENV]: MERGE_AGENT_OPERATOR_FALLBACK_ENV_VALUE,
  };
}

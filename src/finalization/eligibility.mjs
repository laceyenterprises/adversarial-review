// Merge Authority v2 eligibility fold (ARC-15; docs/SPEC-merge-authority-v2.md
// §3). `eligible(state, policy) → Decision` is the PURE function that replaces
// "an actor decides to merge": no actor decides — the fold does, over the
// projected `LedgerState` from `ledger-fold.mjs`. No I/O, no clock, no
// randomness; the evaluation time enters as `observedAt` (defaulting to the
// state's last event time), so decisions are deterministic and replay-stable.
//
// The decision vocabulary is the FULL merge-authority-v2 §3 set, which is a
// superset of the autonomous finalization port's five kinds: it adds `close`,
// emitted ONLY when an `operator_override` directs rejection (the autonomous
// fold never emits it — see the contract note in `contracts.d.ts`).
//
// Every policy input is explicit and versioned. `consume_attestations` with no
// configured producer is a config-validation error AT LOAD (`normalizePolicy`
// throws), never a silent premature cutover (LHA class).

import { workflowDecision, workflowEpisode } from './workflow-decision.mjs';
import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';

/**
 * @typedef {import('../kernel/contracts.js').LedgerState} LedgerState
 * @typedef {import('../kernel/contracts.js').EligibilityPolicy} EligibilityPolicy
 * @typedef {import('../kernel/contracts.js').EligibilityDecision} EligibilityDecision
 * @typedef {import('../kernel/contracts.js').EligibilityDecisionKind} EligibilityDecisionKind
 * @typedef {import('../kernel/contracts.js').SubjectKey} SubjectKey
 */

/**
 * The full §3 decision vocabulary. `close` is present (unlike the autonomous
 * finalization port) but only ever reached via an `operator_override`.
 */
export const ELIGIBILITY_DECISION_KINDS = Object.freeze([
  'finalize-now',
  'remediate',
  'close',
  'wait',
  'halt',
  'escalate',
]);

// The three MUTATING decisions the kill switch intercepts (merge-authority-v2
// §3): finalize-now, remediate, close → escalate. `wait`/`halt`/`escalate` are
// non-mutating and pass through.
const MUTATING_DECISION_KINDS = new Set(['finalize-now', 'remediate', 'close']);

// GitHub check conclusions that do not block a merge. Anything else that has
// SETTLED (failure, timed_out, cancelled, action_required, stale) is treated as
// a blocking signal routed to remediation.
const NON_BLOCKING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
// A `null`/absent/running conclusion is not settled — patience, not a merge.
const SETTLED_CONCLUSIONS = new Set([
  'success', 'neutral', 'skipped', 'failure', 'timed_out', 'cancelled', 'action_required', 'stale',
]);

const DEFAULT_PATIENCE_MS = 30 * 60 * 1000; // 30 min bounded patience per §3.

/** The versioned policy defaults (merge-authority-v2 §3). */
export const DEFAULT_ELIGIBILITY_POLICY = Object.freeze({
  policyVersion: 1,
  strictMode: true,
  exhaustionAlwaysCloses: true,
  allCommentsBeforeMerge: true,
  consumeAttestations: false,
  attestationProducers: Object.freeze([]),
  checksPatienceMs: DEFAULT_PATIENCE_MS,
  verdictPatienceMs: DEFAULT_PATIENCE_MS,
  attestationPatienceMs: DEFAULT_PATIENCE_MS,
  autonomousExecutionDisabled: false,
  subjectRoundCap: 4,
  deadlineCeilingMs: 6 * DEFAULT_PATIENCE_MS,
  codeVersion: 'mlr06-v1',
});

/**
 * Validate and normalize an eligibility policy, applying defaults. Throws a
 * config-validation error when `consumeAttestations` is set but no producer is
 * configured (merge-authority-v2 §3 — the LHA-class guard, enforced at load).
 *
 * @param {Partial<EligibilityPolicy> | undefined} policy
 * @returns {EligibilityPolicy}
 */
export function normalizePolicy(policy = {}) {
  if (policy && typeof policy !== 'object') {
    throw new TypeError('eligibility policy must be an object');
  }
  const merged = { ...DEFAULT_ELIGIBILITY_POLICY, ...policy };
  const producers = Array.isArray(merged.attestationProducers)
    ? merged.attestationProducers.map(normalizeProducer)
    : [];

  if (merged.consumeAttestations === true && producers.length === 0) {
    throw new Error(
      'invalid eligibility policy: consume_attestations is enabled but no attestation producer is configured',
    );
  }

  return Object.freeze({
    policyVersion: Number(merged.policyVersion) || 1,
    strictMode: merged.strictMode !== false,
    exhaustionAlwaysCloses: merged.exhaustionAlwaysCloses !== false,
    allCommentsBeforeMerge: merged.allCommentsBeforeMerge !== false,
    consumeAttestations: merged.consumeAttestations === true,
    attestationProducers: Object.freeze(producers),
    checksPatienceMs: positiveMs(merged.checksPatienceMs),
    verdictPatienceMs: positiveMs(merged.verdictPatienceMs),
    attestationPatienceMs: positiveMs(merged.attestationPatienceMs),
    autonomousExecutionDisabled: merged.autonomousExecutionDisabled === true,
    codeVersion: String(merged.codeVersion),
    subjectRoundCap: Number.isSafeInteger(merged.subjectRoundCap) && merged.subjectRoundCap > 0 ? merged.subjectRoundCap : 4,
    deadlineCeilingMs: positiveMs(merged.deadlineCeilingMs),
  });
}

/** Explicit load-time validator (alias of `normalizePolicy` that discards the result). */
export function validateEligibilityPolicy(policy) {
  normalizePolicy(policy);
  return true;
}

function normalizeProducer(entry) {
  if (typeof entry === 'string') return { principal: entry, kind: 'produced' };
  if (entry && typeof entry === 'object' && typeof entry.principal === 'string') {
    return { principal: entry.principal, kind: entry.kind || 'produced' };
  }
  throw new TypeError('attestation producer must be a principal string or { principal, kind }');
}

function positiveMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PATIENCE_MS;
}

/**
 * Build a decision carrying the subject/revision provenance every executor and
 * shadow-diff needs. `close` is permitted here (unlike the finalization port).
 *
 * @param {EligibilityDecisionKind} kind
 * @param {{ subjectKey: SubjectKey | null, revisionRef: string, observedAt: string | null,
 *   reason?: string, stageId?: string, round?: number, deadline?: string, final?: boolean }} fields
 * @returns {EligibilityDecision}
 */
export function makeEligibilityDecision(kind, fields = {}) {
  if (!ELIGIBILITY_DECISION_KINDS.includes(kind)) {
    throw new TypeError(`unknown eligibility decision kind: ${JSON.stringify(kind)}`);
  }
  const { subjectKey, revisionRef, observedAt, reason, stageId, round, deadline, final } = fields;
  /** @type {EligibilityDecision} */
  const decision = {
    kind,
    subjectKey: subjectKey ?? null,
    revisionRef: revisionRef ?? '',
    observedAt: observedAt ?? null,
  };
  if (reason != null) decision.reason = reason;
  if (stageId != null) decision.stageId = stageId;
  if (round != null) decision.round = round;
  if (deadline != null) decision.deadline = deadline;
  if (final != null) decision.final = final;
  return decision;
}

function deadlineFrom(anchorAt, patienceMs) {
  const anchorMs = Date.parse(anchorAt ?? '');
  if (!Number.isFinite(anchorMs)) return null;
  return new Date(anchorMs + patienceMs).toISOString();
}

function deadlineExpired(observedAt, deadline) {
  if (!deadline) return false;
  const now = Date.parse(observedAt ?? '');
  const due = Date.parse(deadline);
  if (!Number.isFinite(now) || !Number.isFinite(due)) return false;
  return now >= due;
}

// Latest verdict per (stageId, role) at a revision — a role re-reviewing the
// same revision supersedes its earlier verdict. Array order is append order.
function latestVerdicts(revState) {
  const byRole = new Map();
  for (const v of revState.verdicts ?? []) {
    byRole.set(`${v.stageId}\u0000${v.role}`, v);
  }
  return [...byRole.values()];
}

// 'clean' (approved) | 'non-blocking' (comment-only) | 'blocking'
// (request-changes) | 'indeterminate' (unknown / not settled).
function verdictDisposition(verdictKind) {
  switch (verdictKind) {
    case 'approved': return 'clean';
    case 'comment-only': return 'non-blocking';
    case 'request-changes': return 'blocking';
    default: return 'indeterminate';
  }
}

function aggregateDisposition(verdicts) {
  if (verdicts.length === 0) return 'none';
  let sawIndeterminate = false;
  let sawNonBlocking = false;
  for (const v of verdicts) {
    const d = verdictDisposition(v.verdictKind);
    if (d === 'blocking') return 'blocking';
    if (d === 'indeterminate') sawIndeterminate = true;
    if (d === 'non-blocking') sawNonBlocking = true;
  }
  if (sawIndeterminate) return 'indeterminate';
  if (sawNonBlocking) return 'non-blocking';
  return 'clean';
}

function activeStageId(verdicts) {
  const blocking = verdicts.find((v) => verdictDisposition(v.verdictKind) === 'blocking');
  return (blocking ?? verdicts[0])?.stageId;
}

// The most recent operator override still in force. Once acted on (a `closed`/
// `halted` terminal mark), the terminal short-circuit above handles it; here we
// only surface a directive the executor has not yet turned into a terminal mark.
function latestActiveOverride(state) {
  const overrides = state.operatorOverrides ?? [];
  return overrides.length ? overrides[overrides.length - 1] : null;
}

function missingProducers(producers, attestations) {
  const seen = new Set((attestations ?? []).map((a) => `${a.principal}\u0000${a.kind}`));
  return producers.filter((p) => !seen.has(`${p.principal}\u0000${p.kind}`));
}

function anyStageExhausted(state, stageId) {
  if (stageId && state.stages?.[stageId]?.budgetExhausted) return true;
  // budget_exhausted may name a stage other than the one that produced the
  // active verdict; exhaustion is a subject-level gate on the final round.
  return Object.values(state.stages ?? {}).some((s) => s.budgetExhausted === true);
}

function dispatchedRoundsForRev(state, rev) {
  return (state.remediation?.dispatched ?? []).filter((d) => d.revisionRef === rev).length;
}

function finalDispatchForRev(state, rev) {
  return (state.remediation?.dispatched ?? []).find((d) => d.revisionRef === rev && d.final === true) ?? null;
}

function conclusionForDispatch(state, rev, round) {
  return (state.remediation?.concluded ?? []).find((c) => c.revisionRef === rev && c.round === round) ?? null;
}

/**
 * The pure eligibility fold. Given a projected `LedgerState` and a policy,
 * return the single `Decision` the executor must act on. Deterministic in
 * `(state, policy, observedAt)`.
 *
 * @param {LedgerState} state result of `fold(events)`
 * @param {Partial<EligibilityPolicy>} [policy]
 * @param {{ observedAt?: string }} [options] evaluation time (defaults to the
 *   ledger's last event time); pure — the caller supplies it, the fold never
 *   reads a clock.
 * @returns {EligibilityDecision}
 */
export function eligible(state, policy, observation = {}) {
  const pol = normalizePolicy(policy);
  const episode = workflowEpisode(state, pol);
  const duration = nominal => state.workflow?.anchors[episode]?.effectiveMs ?? loadAwareTimeoutMs(nominal, {
    enabled: true, maxMultiplier: 6, loadAvg1m: 0, cpuCount: 1, cpuBusyPercent: 100,
    ...observation.load, maxMs: pol.deadlineCeilingMs,
  });
  const effectivePolicy = { ...pol, checksPatienceMs: duration(pol.checksPatienceMs),
    verdictPatienceMs: duration(pol.verdictPatienceMs), attestationPatienceMs: duration(pol.attestationPatienceMs) };
  const budgetExhausted = Object.keys(state.workflow?.work ?? {}).length >= pol.subjectRoundCap;
  const coreState = { ...state, terminal: ['halted', 'escalated'].includes(state.terminal?.kind) ? null : state.terminal,
    stages: budgetExhausted ? { ...state.stages, subject: { budgetExhausted: true } } : state.stages };
  return workflowDecision(state, pol, observation, eligibleCore(coreState, effectivePolicy, observation));
}

function eligibleCore(state, policy, { observedAt } = {}) {
  const pol = normalizePolicy(policy);
  const at = observedAt ?? state?.lastEventAt ?? null;
  const rev = state?.currentRevision ?? null;
  const subjectKey = state?.subjectKey ?? null;
  const base = { subjectKey, revisionRef: rev ?? '', observedAt: at };
  const D = (kind, extra = {}) => makeEligibilityDecision(kind, { ...base, ...extra });

  // Mutating decisions pass through the kill switch (merge-authority-v2 §3):
  // autonomous execution disabled ⇒ every merge/remediate/close becomes a
  // fail-closed escalate, never a mutation.
  const gate = (decision) => {
    if (pol.autonomousExecutionDisabled && MUTATING_DECISION_KINDS.has(decision.kind)) {
      return D('escalate', { reason: `kill switch: ${decision.kind} intercepted (autonomous execution disabled)` });
    }
    return decision;
  };

  // 1. Terminal short-circuits. An unresolved escalated/halted is terminal and
  //    does not re-page; finalized/closed are done.
  if (state?.terminal) {
    switch (state.terminal.kind) {
      case 'finalized':
        return D('finalize-now', { revisionRef: state.terminal.revisionRef ?? rev ?? '', reason: 'already finalized' });
      case 'closed':
        return D('close', { reason: state.terminal.reason ?? 'closed' });
      case 'escalated':
        return D('escalate', { reason: state.terminal.reason ?? 'escalated', final: true });
      case 'halted':
        return D('halt', { reason: state.terminal.reason ?? 'halted', final: true });
      default:
        break;
    }
  }

  // 2. An operator override directing close/halt that has not yet become a
  //    terminal mark drives the decision directly (close is override-only).
  const override = latestActiveOverride(state);
  if (override?.overrideKind === 'close') {
    return gate(D('close', { reason: override.reason ?? 'operator close' }));
  }
  if (override?.overrideKind === 'halt') {
    return D('halt', { reason: override.reason ?? 'operator halt' });
  }

  // 3. Eligibility is computed PER REVISION. No head yet ⇒ nothing to fold.
  if (!rev) return D('wait', { reason: 'no revision advanced yet' });
  const revState = state.revisions?.[rev] ?? { verdicts: [], checks: null, attestations: [], revisionAdvancedAt: null };
  const anchor = revState.revisionAdvancedAt ?? at;

  // 4. Checks: required checks must be PRESENT and SETTLED (a running check is
  //    not a conclusion — the CI-impatience class). Absent/pending ⇒ bounded
  //    patience, expiry ⇒ escalate, never a merge.
  const checks = revState.checks;
  const checksConclusive = checks
    && checks.requiredChecksPresent === true
    && SETTLED_CONCLUSIONS.has(checks.conclusion);
  if (!checksConclusive) {
    const deadline = deadlineFrom(anchor, pol.checksPatienceMs);
    if (deadlineExpired(at, deadline)) {
      return D('escalate', { reason: 'checks patience expired', deadline });
    }
    const reason = !checks
      ? 'checks not yet settled at current revision'
      : checks.requiredChecksPresent !== true
        ? 'required checks not yet present at current revision'
        : 'required checks still running at current revision';
    return D('wait', { reason, deadline });
  }
  const checksGreen = NON_BLOCKING_CONCLUSIONS.has(checks.conclusion);

  // 5. Verdict AT THE CURRENT REVISION. A verdict at a prior revision lives
  //    under that revision's key and never matches here (the verdict-at-wrong-
  //    head and identity-head-pin classes disappear by construction).
  const verdicts = latestVerdicts(revState);
  const disposition = aggregateDisposition(verdicts);
  if (disposition === 'none') {
    const deadline = deadlineFrom(anchor, pol.verdictPatienceMs);
    if (deadlineExpired(at, deadline)) {
      return D('escalate', { reason: 'verdict patience expired at current revision', deadline });
    }
    return D('wait', { reason: 'no verdict at current revision', deadline });
  }
  if (disposition === 'indeterminate') {
    const deadline = deadlineFrom(anchor, pol.verdictPatienceMs);
    if (deadlineExpired(at, deadline)) {
      return D('escalate', { reason: 'verdict indeterminate past patience', deadline });
    }
    return D('wait', { reason: 'verdict indeterminate at current revision', deadline });
  }

  // 6. Attestations (only when consuming). A configured producer that has not
  //    emitted its attestation at this revision ⇒ bounded patience; expiry ⇒
  //    escalate, never an infinite stall or a merge (LHA runtime guard).
  if (pol.consumeAttestations) {
    const missing = missingProducers(pol.attestationProducers, revState.attestations);
    if (missing.length > 0) {
      const deadline = deadlineFrom(anchor, pol.attestationPatienceMs);
      if (deadlineExpired(at, deadline)) {
        return D('escalate', { reason: 'attestation patience expired', deadline });
      }
      return D('wait', {
        reason: `awaiting attestations from: ${missing.map((p) => p.principal).join(', ')}`,
        deadline,
      });
    }
  }

  // 7. Does the subject need remediation before it can finalize?
  //    - a blocking verdict, OR
  //    - a non-blocking verdict under strict_mode (unless operator-approved) —
  //      the final remediation addresses ALL comments before merge (§3), OR
  //    - checks settled but not green.
  const operatorApproved = override?.overrideKind === 'approve';
  const needsRemediation = disposition === 'blocking'
    || (disposition === 'non-blocking' && pol.strictMode && !operatorApproved)
    || !checksGreen;

  if (!needsRemediation) {
    return gate(D('finalize-now', { reason: 'clean verdict, green checks at current revision' }));
  }

  // 8. Remediation path. Budget is counted PER STAGE (kernel-side) and is a
  //    separate question from per-revision eligibility, so a head move never
  //    deadlocks a clean PR (the ceiling+head-move class).
  const stageId = activeStageId(verdicts);
  const remediationReason = !checksGreen && disposition === 'clean'
    ? `checks not green at current revision (${checks.conclusion})`
    : disposition === 'blocking'
      ? 'blocking review finding at current revision'
      : 'non-blocking comments must be addressed before merge (strict_mode)';

  if (!anyStageExhausted(state, stageId)) {
    const round = dispatchedRoundsForRev(state, rev) + 1;
    return gate(D('remediate', { stageId, round, reason: remediationReason }));
  }

  // 9. Budget exhausted. Standing operator policy: exhaustion always closes by
  //    LANDING, never by abandoning — remediate(final), coverage-gated, then
  //    finalize-now. Never an indefinite wait, never a reject-without-merge.
  if (!pol.exhaustionAlwaysCloses) {
    // Policy explicitly disables force-landing: page rather than merge past
    // findings or wait forever.
    return D('halt', { reason: 'remediation budget exhausted; exhaustion-always-closes disabled', stageId });
  }

  const finalDispatch = finalDispatchForRev(state, rev);
  if (!finalDispatch) {
    const round = dispatchedRoundsForRev(state, rev) + 1;
    return gate(D('remediate', {
      stageId,
      round,
      final: true,
      reason: 'final coverage-gated remediation (budget exhausted; addresses all comments before merge)',
    }));
  }

  const conclusion = conclusionForDispatch(state, rev, finalDispatch.round);
  if (!conclusion) {
    const deadline = deadlineFrom(finalDispatch.at, pol.checksPatienceMs);
    if (deadlineExpired(at, deadline)) {
      return D('escalate', { reason: 'final remediation did not conclude within patience', deadline });
    }
    return D('wait', { reason: 'final remediation in progress', deadline });
  }
  // The final remediation reply is coverage-validated by the producer; the fold
  // trusts its outcome. `completed` ⇒ full coverage ⇒ finalize-now. Anything
  // else ⇒ coverage operationally impossible ⇒ halt (pages); NEVER close.
  if (conclusion.outcome === 'completed' && conclusion.coverageValidated && conclusion.sourceRef) {
    return gate(D('finalize-now', { reason: 'exhaustion final remediation reached validated full coverage' }));
  }
  return D('halt', {
    reason: `final remediation could not achieve full coverage (outcome: ${conclusion.outcome})`,
    stageId,
  });
}

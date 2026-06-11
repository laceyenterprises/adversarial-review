/**
 * AMA-02 — Adversarial Merge Authority eligibility predicate.
 *
 * The canonical predicate from
 * `projects/adversarial-merge-authority/SPEC.md` §4.2. Both the watcher
 * dispatch gate (AMA-03) and the closer worker's final pre-merge recheck
 * (SPEC §6 AC#6) call this same pure function against a fresh read-only
 * snapshot. Centralizing the predicate avoids the two call sites drifting
 * apart and lets the watcher and closer share a single audit shape.
 *
 * This module is intentionally side-effect-free:
 *
 * - No `gh` shell-outs (the caller fetches the snapshot)
 * - No filesystem reads (CFG and label state come in as arguments)
 * - No `Date.now()` or clock reads (timing decisions belong to the caller)
 * - No randomness
 *
 * @module ama/eligibility
 */

import { summarizeChecksConclusion } from '../checks-summary.mjs';
import { resolveGateStatusContext } from '../adversarial-gate-context.mjs';

const OPERATOR_APPROVED_LABEL = 'operator-approved';
const MERGE_AGENT_REQUESTED_LABEL = 'merge-agent-requested';

/**
 * Hard-stop labels imported from the existing adversarial-review / merge-agent
 * contract (SPEC §4.2 #6). `adversarial-merge-blocked` is the new AMA-owned
 * label that AMA-05 introduces; including it here so the predicate is
 * already correct on the day AMA-05 lands.
 *
 * `merge-agent-stuck` is a hard stop for ordinary settled-review closure.
 * The spec carves out a scoped recovery path that the caller must encode
 * explicitly via `recoveryEvidence`; this module evaluates the label as a
 * stop unless that evidence is supplied.
 */
const HARD_STOP_LABELS = Object.freeze([
  'merge-agent-skip',
  'do-not-merge',
  'no-merge-hold',
  'merge-agent-stuck',
  'adversarial-merge-blocked',
]);

/**
 * Verdict shapes that count as a settled-success review for AMA closure
 * authority. SPEC §4.2 #1 — `Approved` and the existing adversarial-review
 * classifier's clean `Comment only` outcome, zero known structured
 * blocking findings, no remediation follow-up pending.
 *
 * Values are normalized to lowercase by the watcher record builder; the
 * predicate compares accordingly.
 */
const SETTLED_SUCCESS_VERDICTS = new Set(['approved', 'comment-only']);

/**
 * @typedef {Object} OperatorApprovalEvidence
 *
 * Shape that mirrors the existing `revision-scoped operator-approved`
 * label-event evidence (see
 * `src/adapters/operator/github-pr-label-controls/index.mjs`).
 *
 * @property {boolean} applied               Label is current-head AND attributable.
 * @property {string}  observedRevisionRef   Head SHA the label was applied at.
 * @property {string}  actor                 Login of the operator who applied the label.
 * @property {string}  eventId               GitHub event id (audit linkage).
 * @property {string}  observedAt            ISO timestamp from the event.
 * @property {string=} reason                Optional descriptive reason.
 */

/**
 * @typedef {Object} MergeAgentRecoveryEvidence
 *
 * Tagged recovery-evidence union for the `merge-agent-stuck` carve-out.
 *
 * @property {'merge-agent-requested'} kind
 * @property {boolean} applied
 * @property {string} observedRevisionRef
 * @property {string} actor
 * @property {string} eventId
 * @property {string} observedAt
 * @property {string=} reason
 */

/**
 * @typedef {Object} ReviewState
 *
 * Current-head adversarial-review record (the watcher's job-state row).
 *
 * @property {string}                    verdict                  Normalized verdict: 'approved' | 'comment-only' | 'request-changes' | ...
 * @property {string}                    headSha                  Head SHA the review was scoped to.
 * @property {string}                    riskClass                Resolved risk class: 'low' | 'medium' | 'high' | 'critical' | 'unknown'.
 * @property {boolean}                   remediationPending       True iff remediation follow-up is still owed.
 * @property {OperatorApprovalEvidence?} operatorApprovedEvidence Latest current-head, attributable operator-approved label evidence.
 * @property {number=}                   blockingFindingCount     Structured blocking-finding count from the latest current-head review.
 * @property {string=}                   blockingFindingState     `'known'` when the count is trustworthy; `'unknown'` or missing fail closed.
 * @property {string=}                   prAuthor                 PR author login — audit-only in the current single-operator contract.
 * @property {string=}                   reviewerFamily           'codex' | 'claude' — audit-only field.
 */

/**
 * @typedef {Object} PrMetadata
 *
 * Live PR shape — the subset of `gh pr view`-equivalent fields the
 * predicate consumes.
 *
 * @property {number}   prNumber                       PR number for audit linkage / message strings.
 * @property {string}   headSha                        Current head SHA on the PR branch.
 * @property {boolean}  isOpen                         False for closed / merged PRs.
 * @property {boolean}  isDraft                        Draft PRs are not eligible.
 * @property {string}   mergeableState                 GitHub's mergeable-state — 'MERGEABLE' is required.
 * @property {Array<string|{name:string}>} labels      All current labels on the PR.
 * @property {Array}    statusCheckRollup              Raw rollup that feeds `summarizeChecksConclusion()`.
 * @property {Object}   branchProtection
 * @property {string[]} branchProtection.requiredContexts Required-context list from the GitHub branch-protection API.
 * @property {string=}  author                         PR author login (used as a fallback for self-approval rejection).
 */

/**
 * @typedef {Object} AmaEligibilityConfig
 *
 * Resolved `roles.adversarial.merge_authority` subtree.
 * `AgentOSConfig.getMergeAuthorityConfig()` returns this shape directly.
 *
 * @property {boolean} enabled
 * @property {string}  workerClass
 * @property {string}  mergeMethod
 * @property {Object}  eligibility
 * @property {string[]} eligibility.riskClasses
 * @property {string[]} eligibility.fastMergeLabels
 * @property {string}  eligibility.reviewerFamilyPolicy
 * @property {string}  eligibility.ciGreenClassifier
 * @property {Object}  branchProtection
 * @property {string}  branchProtection.requiredGateContextSource
 */

/**
 * @typedef {Object} EvaluateOptions
 * @property {Object=}        env                   Override `process.env` for the gate-context resolver.
 * @property {OperatorApprovalEvidence=} mergeAgentRequested Optional current-head merge-requested evidence. Same shape as operator-approved.
 * @property {MergeAgentRecoveryEvidence=} recoveryEvidence  Optional current-head recovery evidence for the `merge-agent-stuck` carve-out.
 * @property {Object=} fastMergeState                        Optional FML authorization/veto snapshot. AMA fails closed when the PR is in a fast-merge override state it does not import.
 * @property {AdversarialMergeBlockedEvidence=} adversarialMergeBlocked Optional current-head evidence for the AMA-05
 * `adversarial-merge-blocked` label. When supplied:
 *   - `applied=true && observedRevisionRef === current head` → block (label respected).
 *   - `applied=false || stale revisionRef` → ignored (the label may be on the PR but its timeline
 *     event scope is not current-head).
 * When NOT supplied, the predicate falls back to label-presence
 * (`prMetadata.labels.includes('adversarial-merge-blocked')`) → blocks. Fail-closed default for
 * watchers that have not yet wired the timeline-event fetch.
 * Unlike `operator-approved` / `adversarial-merge-requested`, AMA-05 §C explicitly permits PR-author
 * self-application of `adversarial-merge-blocked` (blocking your own PR is fine) so no author check
 * is applied to this evidence.
 */

/**
 * @typedef {Object} EligibilityResult
 *
 * @property {boolean}  eligible
 * @property {string[]} reasons  Empty when eligible=true; populated when false.
 *                               Each string is a stable kebab-case identifier so
 *                               operator audit JSON groups consistently.
 * @property {Object}   trace    Structured per-gate decision trace for audit:
 *                               `{ verdict, riskClass, ciGreen, branchProtection, blockLabels, mergeability, headMatch, remediation }`.
 */

/**
 * Detect a current-head, attributable operator-approved override. SPEC
 * §4.2 #1: when this is present, the verdict gate passes regardless of
 * the review outcome itself.
 *
 * @param {ReviewState} reviewState
 * @param {PrMetadata}  prMetadata
 * @returns {boolean}
 */
function hasOperatorApprovedOverride(reviewState, prMetadata) {
  const evidence = reviewState?.operatorApprovedEvidence;
  if (!hasValidScopedOverrideEvidence(evidence, prMetadata)) return false;
  if (!hasCurrentLabel(prMetadata, OPERATOR_APPROVED_LABEL)) return false;
  if (
    String(evidence.observedRevisionRef || '') !==
    String(prMetadata?.headSha || '')
  ) return false;
  return true;
}

/**
 * Detect a current-head `merge-agent-requested` operator label
 * (per SPEC §4.2 #3). Same evidence shape as
 * operator-approved — current-head + attributable.
 *
 * @param {PrMetadata} prMetadata
 * @param {OperatorApprovalEvidence?} evidence
 * @returns {boolean}
 */
function hasMergeRequestedOverride(prMetadata, evidence) {
  if (!hasValidScopedOverrideEvidence(evidence, prMetadata)) return false;
  if (!hasCurrentLabel(prMetadata, MERGE_AGENT_REQUESTED_LABEL)) return false;
  if (
    String(evidence.observedRevisionRef || '') !==
    String(prMetadata?.headSha || '')
  ) return false;
  return true;
}

function normalizeLogin(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeLabelName(label) {
  if (typeof label === 'string') return label.trim().toLowerCase();
  if (typeof label?.name === 'string') return label.name.trim().toLowerCase();
  return '';
}

function currentLabelSet(prMetadata) {
  return new Set(
    (Array.isArray(prMetadata?.labels) ? prMetadata.labels : [])
      .map((label) => normalizeLabelName(label))
      .filter(Boolean),
  );
}

function hasCurrentLabel(prMetadata, labelName) {
  return currentLabelSet(prMetadata).has(String(labelName || '').toLowerCase());
}

function hasValidOverrideActor(actor) {
  const normalizedActor = normalizeLogin(actor);
  return normalizedActor !== '' && normalizedActor !== 'unknown';
}

function hasOverrideProvenance(evidence) {
  if (!evidence) return false;
  const eventId = evidence.eventId || evidence.eventNodeId || evidence.labelEventId || evidence.labelEventNodeId;
  const observedAt = evidence.observedAt || evidence.createdAt;
  return Boolean(eventId && observedAt);
}

function hasValidScopedOverrideEvidence(evidence, prMetadata) {
  if (!evidence || evidence.applied !== true) return false;
  if (!hasValidOverrideActor(evidence.actor)) return false;
  if (!hasOverrideProvenance(evidence)) return false;
  if (
    String(evidence.observedRevisionRef || evidence.headSha || '') !==
    String(prMetadata?.headSha || '')
  ) return false;
  return true;
}

/**
 * Detect the `merge-agent-stuck` carve-out per SPEC §4.2 #6 — the only
 * way the predicate can clear that label is when the caller supplies a
 * current-head `merge-agent-requested` recovery event and the label is still
 * present on the PR. `operator-approved` is not a stuck recovery signal, and
 * `merge-agent-recovery-in-flight` is a transient handoff marker validated by
 * its caller, not merge authorization.
 *
 * The other four hard-stop labels are absolute and have no recovery path.
 *
 * @param {OperatorApprovalEvidence?} evidence
 * @param {PrMetadata}                prMetadata
 * @returns {boolean}
 */
function hasStuckRecoveryEvidence(evidence, reviewState, prMetadata) {
  if (!hasValidScopedOverrideEvidence(evidence, prMetadata)) return false;
  if (evidence.kind !== MERGE_AGENT_REQUESTED_LABEL) return false;
  return hasCurrentLabel(prMetadata, MERGE_AGENT_REQUESTED_LABEL);
}

/**
 * Apply the SPEC §4.2 hard-stop label gate.
 *
 * Returns the list of present hard-stop labels (after carve-outs). Empty
 * list means the gate passes.
 *
 * @param {PrMetadata}                prMetadata
 * @param {OperatorApprovalEvidence?} recoveryEvidence
 * @returns {string[]}
 */
function presentHardStopLabels(reviewState, prMetadata, recoveryEvidence, adversarialMergeBlockedEvidence) {
  const labels = currentLabelSet(prMetadata);
  const hits = [];
  for (const stop of HARD_STOP_LABELS) {
    if (!labels.has(stop)) continue;
    if (stop === 'merge-agent-stuck' && hasStuckRecoveryEvidence(recoveryEvidence, reviewState, prMetadata)) {
      // Documented scoped recovery path per SPEC §4.2 #6.
      continue;
    }
    if (stop === 'adversarial-merge-blocked' && adversarialMergeBlockedEvidence !== undefined) {
      // AMA-05 §B.1 — head-scoped evidence wins over bare label presence.
      // Caller supplied evidence: only block when the latest timeline event
      // for the label was scoped to the current head. Stale events (head
      // advanced past the labeled commit) are ignored regardless of whether
      // the label is still attached to the PR.
      //
      // Author self-application is intentionally NOT checked here: SPEC
      // §4.5 + AMA-05 prompt §C carve out that the author may block their
      // own PR (blocking is fine; requesting closure is not).
      const evidence = adversarialMergeBlockedEvidence;
      const headScoped = evidence
        && evidence.applied === true
        && String(evidence.observedRevisionRef || '') === String(prMetadata?.headSha || '');
      if (!headScoped) {
        continue;
      }
    }
    hits.push(stop);
  }
  return hits;
}

/**
 * Classify CI checks per SPEC §4.2 #5. AMA reuses the existing
 * `summarizeChecksConclusion()` classifier (see
 * `follow-up-merge-agent.mjs`) verbatim — including its `SUCCESS`,
 * `NEUTRAL`, `SKIPPED` accept set and its self-gate exclusion of the
 * adversarial-review pipeline's own status context. Per SPEC §4.7 the
 * config knob `ci_green_classifier` is documentation-only; AMA must not
 * fork into a narrower allowlist.
 *
 * @param {PrMetadata} prMetadata
 * @param {Object}     env
 * @returns {{ green: boolean, conclusion: string|null }}
 */
function classifyCiGreen(prMetadata, env) {
  const conclusion = summarizeChecksConclusion(
    prMetadata?.statusCheckRollup,
    { env },
  );
  return {
    // `null` is unknown/fail-closed here: the merge-agent classifier uses
    // it for missing or malformed rollups, while an explicit empty array
    // already normalizes to `SUCCESS`.
    green: conclusion === 'SUCCESS',
    conclusion,
  };
}

/**
 * Normalize structured blocker state from the current-head review. The
 * merge gate fails closed unless the caller provides an explicit known
 * count; that mirrors the existing merge-agent contract for clean
 * `comment-only` / `approved` verdicts.
 *
 * @param {ReviewState} reviewState
 * @returns {{ count: number, known: boolean, state: string }}
 */
function classifyBlockingFindings(reviewState) {
  const state = String(reviewState?.blockingFindingState || '').trim().toLowerCase();
  if (state !== 'known') {
    return { count: 0, known: false, state: 'unknown' };
  }
  const rawCount = Number(reviewState?.blockingFindingCount);
  if (!Number.isFinite(rawCount) || rawCount < 0) {
    return { count: 0, known: false, state: 'unknown' };
  }
  return { count: rawCount, known: true, state };
}

/**
 * Resolve the configured adversarial-gate status context for the host
 * per SPEC §4.7. `required_gate_context_source` is the documented mirror
 * for `resolveGateStatusContext()` (from `adversarial-gate-context.mjs`);
 * a future surface that wants a different resolver must register it here
 * AND update SPEC §4.7 enum together.
 *
 * @param {AmaEligibilityConfig} cfg
 * @param {Object}               env
 * @returns {string|null}
 */
function resolveRequiredGateContext(cfg, env) {
  const source = cfg?.branchProtection?.requiredGateContextSource;
  if (source !== 'resolveGateStatusContext') {
    // Schema enforces this enum, so falling here means a malformed cfg.
    // Returning null causes the branch-protection gate to fail closed.
    return null;
  }
  try {
    return resolveGateStatusContext(env);
  } catch {
    return null;
  }
}

/**
 * Per SPEC §4.2 #9 — branch protection for the target branch must already
 * require the resolved adversarial-gate context. AMA refuses to enable
 * automated closure unless branch protection is already enforcing the
 * configured gate.
 *
 * @param {PrMetadata} prMetadata
 * @param {string|null} requiredContext
 * @returns {boolean}
 */
function branchProtectionRequiresGate(prMetadata, requiredContext) {
  if (!requiredContext) return false;
  const required = Array.isArray(prMetadata?.branchProtection?.requiredContexts)
    ? prMetadata.branchProtection.requiredContexts
    : [];
  const normalized = new Set(required.map((c) => String(c || '').toLowerCase()));
  return normalized.has(String(requiredContext).toLowerCase());
}

function classifyFastMergeState(prMetadata, cfg, fastMergeState) {
  const labels = currentLabelSet(prMetadata);
  const configuredLabels = new Set(
    (cfg?.eligibility?.fastMergeLabels || []).map((label) => normalizeLogin(label)),
  );
  const configuredLabelPresent = [...configuredLabels].some((label) => labels.has(label));
  const vetoPresent = labels.has('fast-merge-veto') || fastMergeState?.vetoPresent === true;
  const authorizedHeadSha = String(fastMergeState?.authorizedHeadSha || '');
  const currentHeadAuthorized =
    fastMergeState?.currentHeadAuthorized === true ||
    (authorizedHeadSha !== '' && authorizedHeadSha === String(prMetadata?.headSha || ''));
  const active =
    fastMergeState?.active === true ||
    configuredLabelPresent ||
    vetoPresent ||
    currentHeadAuthorized;
  return {
    active,
    configuredLabelPresent,
    vetoPresent,
    authorizedHeadSha,
    currentHeadAuthorized,
  };
}

/**
 * Evaluate AMA eligibility per SPEC §4.2.
 *
 * Pure function. No I/O. No clocks. No randomness. Same call shape used by
 * the watcher dispatch path (AMA-03) and the closer worker's pre-merge
 * recheck (SPEC §6 AC#6). Both must call this against a fresh snapshot
 * built immediately before invocation.
 *
 * @param {ReviewState}          reviewState
 * @param {PrMetadata}           prMetadata
 * @param {AmaEligibilityConfig} cfg
 * @param {EvaluateOptions=}     options
 * @returns {EligibilityResult}
 */
export function isEligibleForAmaClosure(reviewState, prMetadata, cfg, options = {}) {
  const reasons = [];
  const env = options?.env || process.env;
  const mergeRequestedEvidence = options?.mergeAgentRequested || null;
  const recoveryEvidence = options?.recoveryEvidence || null;
  const fastMergeState = options?.fastMergeState || null;
  // AMA-05 head-scoped evidence for `adversarial-merge-blocked`.
  // `undefined` (not supplied) → fall back to label-presence (fail-closed).
  // `null` or an object → treated as supplied evidence; the hard-stop
  // gate consults the head-scope rules in `presentHardStopLabels`.
  const adversarialMergeBlockedEvidence =
    options && Object.prototype.hasOwnProperty.call(options, 'adversarialMergeBlocked')
      ? (options.adversarialMergeBlocked || null)
      : undefined;

  const amaEnabled = cfg?.enabled === true;
  if (!amaEnabled) {
    reasons.push('ama-disabled');
  }

  // SPEC §4.2 #7 — open + not draft + mergeable.
  // Check first so the more interesting gates aren't masked by a closed
  // PR's stale labels.
  const mergeability = {
    isOpen: prMetadata?.isOpen === true,
    isDraft: prMetadata?.isDraft === true,
    mergeableState: String(prMetadata?.mergeableState || '').toUpperCase(),
  };
  if (!mergeability.isOpen) reasons.push('pr-not-open');
  if (mergeability.isDraft) reasons.push('pr-is-draft');
  if (mergeability.mergeableState !== 'MERGEABLE') reasons.push('pr-not-mergeable');

  // SPEC §4.2 #4 — head must match the review's reviewed head OR the
  // operator-approved evidence's observed head. The override branch is
  // checked inside `hasOperatorApprovedOverride()` against the current
  // head; this gate covers the review-based authority path.
  const operatorOverride = hasOperatorApprovedOverride(reviewState, prMetadata);
  const reviewedHead = String(reviewState?.headSha || '');
  const currentHead = String(prMetadata?.headSha || '');
  const headMatchOk = operatorOverride || (reviewedHead && reviewedHead === currentHead);
  if (!headMatchOk) reasons.push('stale-review-head');

  const blockingFindings = classifyBlockingFindings(reviewState);
  const remediationStateKnown = typeof reviewState?.remediationPending === 'boolean';
  const remediationPending = reviewState?.remediationPending === true;

  // SPEC §4.2 #1 — settled-success verdict OR operator-approved override.
  const verdictNormalized = String(reviewState?.verdict || '').toLowerCase();
  const settledSuccess =
    SETTLED_SUCCESS_VERDICTS.has(verdictNormalized) &&
    remediationPending === false &&
    blockingFindings.known &&
    blockingFindings.count === 0;
  if (!settledSuccess && !operatorOverride) {
    reasons.push('verdict-not-settled-success');
  }

  // SPEC §4.2 #1 — current-head `operator-approved` preserves the
  // review/remediation escape hatch for stale or malformed remediation state.
  if (!operatorOverride && !remediationStateKnown) {
    reasons.push('remediation-state-unknown');
  } else if (!operatorOverride && remediationPending) {
    reasons.push('remediation-pending');
  }
  if (!operatorOverride && !blockingFindings.known) {
    reasons.push('blocking-findings-unknown');
  } else if (!operatorOverride && blockingFindings.count > 0) {
    reasons.push('blocking-findings-present');
  }

  // SPEC §4.2 #3 — risk-class allowlist OR merge-agent-requested
  // override on the current head.
  const riskClass = String(reviewState?.riskClass || '').toLowerCase();
  const allowedRiskClasses = new Set(
    (cfg?.eligibility?.riskClasses || []).map((r) => String(r || '').toLowerCase()),
  );
  const riskAllowed = riskClass !== '' && allowedRiskClasses.has(riskClass);
  const mergeRequestedOverride = hasMergeRequestedOverride(prMetadata, mergeRequestedEvidence);
  const riskClassRequiresTwoKey = ['high', 'critical', 'unknown', ''].includes(riskClass);
  const riskPermitted = riskClassRequiresTwoKey
    ? mergeRequestedOverride && operatorOverride
    : riskAllowed;
  if (!riskPermitted) {
    reasons.push('risk-class-not-permitted');
  }

  // SPEC §4.2 #5 — CI green per the existing classifier.
  const ci = classifyCiGreen(prMetadata, env);
  if (!ci.green) {
    reasons.push('ci-not-green');
  }

  // SPEC §4.2 #9 — branch protection requires the configured gate.
  const requiredContext = resolveRequiredGateContext(cfg, env);
  const protectionOk = branchProtectionRequiresGate(prMetadata, requiredContext);
  if (!protectionOk) {
    reasons.push('branch-protection-missing-gate');
  }

  // SPEC §4.2 #6 — hard-stop labels (with the merge-agent-stuck recovery
  // carve-out and AMA-05 head-scoped `adversarial-merge-blocked` evidence).
  const blockingLabels = presentHardStopLabels(
    reviewState,
    prMetadata,
    recoveryEvidence,
    adversarialMergeBlockedEvidence,
  );
  for (const label of blockingLabels) {
    reasons.push(`label-${label}`);
  }

  // SPEC §4.2 #8 — AMA must fail closed when a PR is already in an FML
  // override state until the predicate imports FML's full contract.
  const fastMerge = classifyFastMergeState(prMetadata, cfg, fastMergeState);
  if (fastMerge.active) {
    reasons.push('fast-merge-state-unsupported');
  }

  const trace = {
    verdict: {
      normalized: verdictNormalized,
      settledSuccess,
      operatorOverride,
      remediationPending,
      remediationStateKnown,
      blockingFindings,
    },
    riskClass: {
      resolved: riskClass,
      allowed: riskAllowed,
      requiresTwoKey: riskClassRequiresTwoKey,
      permitted: riskPermitted,
      mergeRequestedOverride,
    },
    ciGreen: ci,
    branchProtection: {
      requiredContext,
      ok: protectionOk,
    },
    blockLabels: blockingLabels,
    fastMerge,
    mergeability,
    headMatch: {
      reviewed: reviewedHead,
      current: currentHead,
      ok: headMatchOk,
    },
    remediation: { pending: remediationPending, known: remediationStateKnown },
    config: { enabled: amaEnabled },
  };

  return {
    eligible: reasons.length === 0,
    reasons,
    trace,
  };
}

// Exports below are intentionally minimal — the public surface is
// `isEligibleForAmaClosure`. Internal helpers are exposed for tests so
// each gate can be probed in isolation without rebuilding the full
// snapshot.
export const __testables__ = {
  HARD_STOP_LABELS,
  SETTLED_SUCCESS_VERDICTS,
  hasOperatorApprovedOverride,
  hasMergeRequestedOverride,
  hasValidScopedOverrideEvidence,
  hasCurrentLabel,
  presentHardStopLabels,
  classifyCiGreen,
  classifyBlockingFindings,
  classifyFastMergeState,
  branchProtectionRequiresGate,
  resolveRequiredGateContext,
};

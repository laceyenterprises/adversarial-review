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
import {
  ADVERSARIAL_MERGE_BLOCKED_LABEL,
  ADVERSARIAL_MERGE_REQUESTED_LABEL,
} from './labels.mjs';
import {
  hamAuditCommentAuthorMatches,
  parseRemediatedFindingsTrailer,
} from './ham-provenance.mjs';
import { normalizeCoverageTitle } from '../kernel/remediation-reply.mjs';

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
  ADVERSARIAL_MERGE_BLOCKED_LABEL,
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
export const SETTLED_SUCCESS_VERDICTS = new Set(['approved', 'comment-only']);

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
 * @property {number=}                   nonBlockingFindingCount  Structured non-blocking-finding count from the latest current-head review.
 * @property {string=}                   nonBlockingFindingState  `'known'` when the count is trustworthy; `'unknown'` or missing fail closed in strict mode.
 * @property {string[]=}                 nonBlockingFindingIdentities  Normalized non-blocking finding titles parsed from the same current-head review body the counts came from. `null`/absent fails the HAM non-blocking waiver coverage gate closed.
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
 * @property {boolean=} strictNonBlockingRemediation
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
 * @property {OperatorApprovalEvidence=} adversarialMergeRequested Optional current-head adversarial-merge-requested evidence. Same shape as operator-approved.
 * @property {MergeAgentRecoveryEvidence=} recoveryEvidence  Optional current-head recovery evidence for the `merge-agent-stuck` carve-out.
 * @property {Object=} fastMergeState                        Optional FML authorization/veto snapshot. AMA fails closed when the PR is in a fast-merge override state it does not import.
 * @property {AdversarialMergeBlockedEvidence=} adversarialMergeBlocked Optional current-head evidence for the AMA-05
 * `adversarial-merge-blocked` label. When a non-null evidence object is supplied:
 *   - `applied=true && observedRevisionRef === current head` → block (label respected).
 *   - `applied=false || stale revisionRef` → ignored (the label may be on the PR but its timeline
 *     event scope is not current-head).
 * When omitted or null, the predicate falls back to label-presence
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
 * Detect a current-head `adversarial-merge-requested` operator label
 * (per SPEC §4.2 #3). Same evidence shape as
 * operator-approved — current-head + attributable.
 *
 * @param {PrMetadata} prMetadata
 * @param {OperatorApprovalEvidence?} evidence
 * @returns {boolean}
 */
function hasAdversarialMergeRequestedOverride(prMetadata, evidence) {
  if (!hasValidScopedOverrideEvidence(evidence, prMetadata)) return false;
  if (!hasCurrentLabel(prMetadata, ADVERSARIAL_MERGE_REQUESTED_LABEL)) return false;
  const actor = normalizeLogin(evidence.actor);
  const author = normalizeLogin(prMetadata?.author || prMetadata?.prAuthor);
  if (author && actor === author) return false;
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

function classifyNonBlockingFindings(reviewState) {
  const state = String(reviewState?.nonBlockingFindingState || '').trim().toLowerCase();
  if (state !== 'known') {
    return { count: 0, known: false, state: 'unknown' };
  }
  const rawCount = Number(reviewState?.nonBlockingFindingCount);
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

function normalizeTrailerMap(value) {
  if (!value || typeof value !== 'object') return {};
  const out = {};
  for (const [key, trailerValue] of Object.entries(value)) {
    out[String(key || '').trim().toLowerCase()] = String(trailerValue || '').trim();
  }
  return out;
}

function shaClaimMatches(claimed, verified) {
  const lhs = String(claimed || '').trim();
  const rhs = String(verified || '').trim();
  if (!lhs || !rhs) return false;
  if (lhs === rhs) return true;
  const minPrefixLength = 7;
  return lhs.length >= minPrefixLength && rhs.startsWith(lhs);
}

function verifiedCommitHasNonEmptyDiff(verifiedCommit) {
  if (!verifiedCommit || !Object.prototype.hasOwnProperty.call(verifiedCommit, 'changedFiles')) {
    return false;
  }
  return Array.isArray(verifiedCommit.changedFiles) && verifiedCommit.changedFiles.length > 0;
}

function validateRebaseReviewCoverageEvidence(
  evidence,
  {
    reviewedHead,
    currentHead,
  } = {},
) {
  const active = evidence?.active === true;
  const coveredReviewedHead = String(evidence?.reviewedHead || '').trim();
  const coveredCurrentHead = String(evidence?.currentHead || '').trim();
  const marker = String(evidence?.evidence || '').trim();
  const contentEquivalence = evidence?.contentEquivalence || null;
  const reviewedPatchIdCount = Number(contentEquivalence?.reviewedCount);
  const rebasedPatchIdCount = Number(contentEquivalence?.rebasedCount);
  const checks = {
    active,
    reviewedHead:
      coveredReviewedHead !== ''
      && coveredReviewedHead === String(reviewedHead || '').trim(),
    currentHead:
      coveredCurrentHead !== ''
      && coveredCurrentHead === String(currentHead || '').trim(),
    marker: marker === 'content_equivalent_rebased_head',
    contentEquivalent: contentEquivalence?.equivalent === true,
    contentEquivalenceNonEmpty:
      Number.isSafeInteger(reviewedPatchIdCount)
      && Number.isSafeInteger(rebasedPatchIdCount)
      && reviewedPatchIdCount > 0
      && rebasedPatchIdCount > 0
      && reviewedPatchIdCount === rebasedPatchIdCount
      && Array.isArray(contentEquivalence?.dropped)
      && contentEquivalence.dropped.length === 0
      && Array.isArray(contentEquivalence?.added)
      && contentEquivalence.added.length === 0,
  };
  const ok = Object.values(checks).every(Boolean);
  return {
    active,
    ok,
    checks,
    reviewedHead: coveredReviewedHead || null,
    currentHead: coveredCurrentHead || null,
    marker: ok ? 'content_equivalent_rebased_head' : null,
    contentEquivalence,
  };
}

function validateHamFindingMap(findings) {
  if (!Array.isArray(findings)) {
    return { ok: false, count: 0, blocking: 0, nonBlocking: 0, nonBlockingTitles: [] };
  }
  if (findings.length === 0) {
    return { ok: true, count: 0, blocking: 0, nonBlocking: 0, nonBlockingTitles: [] };
  }
  let blocking = 0;
  let nonBlocking = 0;
  // Normalized titles of the HAM's addressed NON-blocking findings. Used by the
  // non-blocking waiver coverage gate to prove the hammer addressed EVERY
  // current standing non-blocking finding by identity (not just by count).
  // Reuses the same `normalizeCoverageTitle` normalizer the review-body parser
  // uses so the two title sets compare on identical normalization.
  const nonBlockingTitles = [];
  for (const finding of findings) {
    const title = String(finding?.title || finding?.finding || '').trim();
    const file = String(finding?.file || finding?.path || '').trim();
    const addressed = finding?.addressed === true;
    if (!title || !file || !addressed) {
      return { ok: false, count: findings.length, blocking, nonBlocking, nonBlockingTitles };
    }
    if (finding?.blocking === true) {
      blocking += 1;
    } else {
      nonBlocking += 1;
      const normalized = normalizeCoverageTitle(title);
      if (normalized) nonBlockingTitles.push(normalized);
    }
  }
  return { ok: true, count: findings.length, blocking, nonBlocking, nonBlockingTitles };
}

function hamAuditBodyCoversFindings(body, findings) {
  const text = String(body || '').toLowerCase();
  if (!text) return false;
  for (const finding of findings || []) {
    const title = String(finding?.title || finding?.finding || '').trim().toLowerCase();
    const file = String(finding?.file || finding?.path || '').trim().toLowerCase();
    if (!title || !file || !text.includes(title) || !text.includes(file)) return false;
  }
  return true;
}

function normalizePathList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function samePathSet(left, right) {
  const leftSet = new Set(normalizePathList(left));
  const rightSet = new Set(normalizePathList(right));
  if (leftSet.size !== rightSet.size) return false;
  for (const item of leftSet) {
    if (!rightSet.has(item)) return false;
  }
  return true;
}

function pathSetIncludesAll(haystack, needles) {
  const haystackSet = new Set(normalizePathList(haystack));
  const normalizedNeedles = normalizePathList(needles);
  if (normalizedNeedles.length === 0) return false;
  return normalizedNeedles.every((path) => haystackSet.has(path));
}

function bodyMentionsEveryPath(body, paths) {
  const text = String(body || '').toLowerCase();
  const normalized = normalizePathList(paths);
  if (!text || normalized.length === 0) return false;
  return normalized.every((path) => text.includes(path.toLowerCase()));
}

function validateHamDocCurrencyEvidence(evidence, verifiedCommit, verifiedAuditBody) {
  const claim = evidence?.auditComment?.docCurrency || evidence?.docCurrency || null;
  const changedFiles = normalizePathList(verifiedCommit?.changedFiles);
  if (!claim || typeof claim !== 'object' || changedFiles.length === 0) {
    return { ok: false, status: null, changedFiles };
  }
  const claimedChangedFiles = normalizePathList(claim.changedFiles);
  const status = String(claim.status || '').trim().toLowerCase();
  const docsUpdated = normalizePathList(claim.docsUpdated);
  const skippedSuperprojectDocs = normalizePathList(claim.skippedSuperprojectDocs);
  const body = String(verifiedAuditBody || '');
  const lowerBody = body.toLowerCase();
  const baseOk =
    samePathSet(claimedChangedFiles, changedFiles)
    && lowerBody.includes('doc-currency')
    && bodyMentionsEveryPath(body, changedFiles);
  let statusOk = false;
  const docsUpdatedInCommit = pathSetIncludesAll(changedFiles, docsUpdated);
  if (status === 'updated') {
    statusOk = docsUpdatedInCommit && bodyMentionsEveryPath(body, docsUpdated);
  } else if (status === 'skipped_superproject') {
    statusOk =
      skippedSuperprojectDocs.length > 0
      && lowerBody.includes('skipped superproject-doc obligation')
      && bodyMentionsEveryPath(body, skippedSuperprojectDocs);
  } else if (status === 'not_applicable') {
    statusOk = lowerBody.includes('not applicable');
  }
  return {
    ok: baseOk && statusOk,
    status: status || null,
    changedFiles,
    claimedChangedFiles,
    docsUpdated,
    docsUpdatedInCommit,
    skippedSuperprojectDocs,
  };
}

function validateHamTerminalRemediationEvidence(
  evidence,
  {
    reviewedHead,
    currentHead,
    verifiedCommit = null,
    verifiedAuditComment = null,
    blockingFindings = { known: false, count: 0 },
  } = {},
) {
  const verifiedTrailers = normalizeTrailerMap(verifiedCommit?.trailers);
  const findingMap = validateHamFindingMap(
    evidence?.auditComment?.findings || evidence?.addressedFindings,
  );
  const commitSha = String(evidence?.commit?.sha || evidence?.headSha || '').trim();
  const parentSha = String(evidence?.commit?.parentSha || evidence?.parentSha || '').trim();
  const verifiedCommitSha = String(verifiedCommit?.sha || '').trim();
  const verifiedParentSha = String(verifiedCommit?.parentSha || '').trim();
  const verifiedReviewedHeadSha = String(verifiedTrailers['reviewed-head'] || '').trim();
  const claimedAuditBody = String(evidence?.auditComment?.body || '').trim();
  const verifiedAuditBody = String(verifiedAuditComment?.body || '').trim();
  const docCurrency = validateHamDocCurrencyEvidence(
    evidence,
    verifiedCommit,
    verifiedAuditBody,
  );
  const ticket = String(verifiedTrailers.ticket || verifiedTrailers['worker-ticket'] || '').trim();
  const closedBy = String(verifiedTrailers['closed-by'] || '').trim();
  const remediatedFindings = String(verifiedTrailers['remediated-findings'] || '').trim();
  const remediatedFindingCounts = parseRemediatedFindingsTrailer(remediatedFindings);
  const expectedBlockingCount = Number(blockingFindings?.count);
  const blockingCountMatches =
    blockingFindings?.known === true
      ? Number.isInteger(expectedBlockingCount) && findingMap.blocking === expectedBlockingCount
      : false;
  const remediatedFindingCountsMatch =
    remediatedFindingCounts !== null
    && remediatedFindingCounts.total === findingMap.count
    && remediatedFindingCounts.total === findingMap.blocking + findingMap.nonBlocking
    && remediatedFindingCounts.blocking === findingMap.blocking
    && remediatedFindingCounts.nonBlocking === findingMap.nonBlocking
    && (!blockingFindings?.known || remediatedFindingCounts.blocking === expectedBlockingCount);
  const directReviewedParent =
    verifiedParentSha !== ''
    && verifiedParentSha === String(reviewedHead || '')
    && shaClaimMatches(parentSha, verifiedParentSha);
  const reviewedHeadTrailerCoversRebase =
    String(reviewedHead || '') !== ''
    && verifiedReviewedHeadSha !== ''
    && shaClaimMatches(verifiedReviewedHeadSha, String(reviewedHead || ''))
    && shaClaimMatches(parentSha, String(reviewedHead || ''));
  const checks = {
    workerClass: verifiedTrailers['worker-class'] === 'hammer',
    ticket: /^(HAM|AMA-PR-\d+)$/i.test(ticket),
    head:
      verifiedCommitSha !== ''
      && verifiedCommitSha === String(currentHead || '')
      && shaClaimMatches(commitSha, verifiedCommitSha),
    parent: directReviewedParent || reviewedHeadTrailerCoversRebase,
    nonEmptyCommit: verifiedCommitHasNonEmptyDiff(verifiedCommit),
    auditComment:
      claimedAuditBody !== ''
      && verifiedAuditBody !== ''
      && claimedAuditBody === verifiedAuditBody
      && findingMap.ok
      && hamAuditBodyCoversFindings(
        verifiedAuditBody,
        evidence?.auditComment?.findings || evidence?.addressedFindings,
      ),
    auditCommentAuthor: hamAuditCommentAuthorMatches(verifiedAuditComment),
    docCurrency: docCurrency.ok,
    closedBy: closedBy === 'hammer (adversarial-pipe-mode)',
    remediatedFindings: remediatedFindingCountsMatch && blockingCountMatches,
  };
  const activeClaimed = evidence?.enabled === true || evidence?.active === true;
  const activeAuthorized = activeClaimed === true
    && checks.workerClass
    && checks.ticket
    && checks.head
    && checks.parent
    && checks.nonEmptyCommit
    && checks.auditComment
    && checks.auditCommentAuthor
    && checks.docCurrency
    && checks.closedBy;
  const ok = Object.values(checks).every(Boolean);
  return {
    active: activeClaimed,
    activeAuthorized,
    ok,
    checks,
    reviewedParent: directReviewedParent ? verifiedParentSha : (verifiedReviewedHeadSha || parentSha || null),
    actualParent: verifiedParentSha || null,
    reviewedHeadTrailer: verifiedReviewedHeadSha || null,
    remediationHead: verifiedCommitSha || commitSha || null,
    addressedFindings: findingMap,
    remediatedFindingCounts,
    docCurrency,
    verifiedCommit: verifiedCommit
      ? {
          author: verifiedCommit.author || null,
          committer: verifiedCommit.committer || null,
          changedFiles: Array.isArray(verifiedCommit.changedFiles)
            ? verifiedCommit.changedFiles
            : [],
        }
      : null,
    auditComment: verifiedAuditComment
      ? {
          author: verifiedAuditComment.author || null,
          createdAt: verifiedAuditComment.createdAt || null,
          id: verifiedAuditComment.id || null,
        }
      : null,
    marker: ok ? 'ham_terminal_remediation_validated' : null,
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
  const adversarialMergeRequestedEvidence = options?.adversarialMergeRequested || null;
  const recoveryEvidence = options?.recoveryEvidence || null;
  const fastMergeState = options?.fastMergeState || null;
  // AMA-05 head-scoped evidence for `adversarial-merge-blocked`.
  // Missing or null evidence falls back to label-presence (fail-closed).
  // Only a non-null evidence object can prove the label is stale/unapplied
  // and let the hard-stop gate ignore it.
  const adversarialMergeBlockedEvidence =
    options &&
    Object.prototype.hasOwnProperty.call(options, 'adversarialMergeBlocked') &&
    options.adversarialMergeBlocked !== null
      ? options.adversarialMergeBlocked
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
  const rebaseReviewCoverage = validateRebaseReviewCoverageEvidence(
    options?.rebaseReviewCoverage || null,
    { reviewedHead, currentHead },
  );
  const headMatchOk =
    operatorOverride
    || (reviewedHead && reviewedHead === currentHead)
    || rebaseReviewCoverage.ok;
  if (!headMatchOk) reasons.push('stale-review-head');

  const blockingFindings = classifyBlockingFindings(reviewState);
  const nonBlockingFindings = classifyNonBlockingFindings(reviewState);
  const remediationStateKnown = typeof reviewState?.remediationPending === 'boolean';
  const remediationPending = reviewState?.remediationPending === true;
  const strictNonBlockingRemediation = cfg?.strictNonBlockingRemediation !== false;

  // SPEC §4.2 #1 — settled-success verdict OR operator-approved override.
  const verdictNormalized = String(reviewState?.verdict || '').toLowerCase();
  const settledSuccess =
    SETTLED_SUCCESS_VERDICTS.has(verdictNormalized) &&
    remediationPending === false &&
    blockingFindings.known &&
    blockingFindings.count === 0 &&
    (
      !strictNonBlockingRemediation ||
      (nonBlockingFindings.known && nonBlockingFindings.count === 0)
    );
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
  if (
    strictNonBlockingRemediation &&
    !operatorOverride &&
    SETTLED_SUCCESS_VERDICTS.has(verdictNormalized) &&
    remediationPending === false &&
    blockingFindings.known &&
    blockingFindings.count === 0 &&
    !nonBlockingFindings.known
  ) {
    reasons.push('non-blocking-findings-unknown');
  }
  if (
    strictNonBlockingRemediation &&
    !operatorOverride &&
    SETTLED_SUCCESS_VERDICTS.has(verdictNormalized) &&
    remediationPending === false &&
    blockingFindings.known &&
    blockingFindings.count === 0 &&
    nonBlockingFindings.known &&
    nonBlockingFindings.count > 0
  ) {
    reasons.push('non-blocking-findings-present');
  }

  // SPEC §4.2 #3 — risk-class allowlist OR adversarial-merge-requested
  // override on the current head.
  const riskClass = String(reviewState?.riskClass || '').toLowerCase();
  const allowedRiskClasses = new Set(
    (cfg?.eligibility?.riskClasses || []).map((r) => String(r || '').toLowerCase()),
  );
  const riskAllowed = riskClass !== '' && allowedRiskClasses.has(riskClass);
  const adversarialMergeRequestedOverride =
    hasAdversarialMergeRequestedOverride(prMetadata, adversarialMergeRequestedEvidence);
  // By default `high`/`critical` (and always `unknown`/unclassified) require the
  // two-key override. Operators who make AMA the single authority for EVERY risk
  // class set `eligibility.high_risk_requires_two_key: false`; then `high`/
  // `critical` close on risk_classes membership alone, exactly like low/medium.
  // `unknown`/'' is NEVER waived (the risk could not be established → fail-closed).
  const highRiskRequiresTwoKey = cfg?.eligibility?.highRiskRequiresTwoKey !== false;
  const alwaysTwoKeyClass = ['unknown', ''].includes(riskClass);
  const highOrCriticalClass = ['high', 'critical'].includes(riskClass);
  const highRiskTwoKeyClass = highRiskRequiresTwoKey && highOrCriticalClass;
  const riskClassRequiresTwoKey = alwaysTwoKeyClass || highRiskTwoKeyClass;
  const riskPermitted = riskClassRequiresTwoKey
    ? adversarialMergeRequestedOverride && operatorOverride
    : riskAllowed;
  if (!riskPermitted) {
    reasons.push('risk-class-not-permitted');
  }

  // SPEC §4.2 #5 — CI green per the existing classifier.
  const ci = classifyCiGreen(prMetadata, env);
  if (!ci.green) {
    reasons.push('ci-not-green');
  }

  // SPEC §4.2 #9 — branch protection requires the configured gate, UNLESS the
  // operator has explicitly opted out on a repo whose GitHub plan offers no
  // branch protection at all (cfg.branchProtection.required === false). The
  // opt-out drops ONLY this gate; every other §4.2 hard gate above/below still
  // applies, and AMA still pins --match-head-commit <reviewedSha> at merge time
  // so a moved head cannot be closed. Default (required !== false) preserves the
  // existing fail-closed contract.
  const branchProtectionRequired = cfg?.branchProtection?.required !== false;
  const requiredContext = branchProtectionRequired
    ? resolveRequiredGateContext(cfg, env)
    : null;
  const branchProtectionWaived = branchProtectionRequired === false;
  const protectionOk =
    !branchProtectionRequired ||
    branchProtectionRequiresGate(prMetadata, requiredContext);
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

  const hamTerminalRemediation = validateHamTerminalRemediationEvidence(
    options?.hamTerminalRemediation || null,
    {
      reviewedHead,
      currentHead,
      verifiedCommit: options?.hamTerminalRemediationGroundTruth?.commit || null,
      verifiedAuditComment: options?.hamTerminalRemediationGroundTruth?.auditComment || null,
      blockingFindings,
    },
  );
  const reviewCycleExhausted = reviewState?.reviewCycleExhausted === true;
  const riskClassFinalHammerWaivable =
    (hamTerminalRemediation.ok === true && reviewCycleExhausted) ||
    (
      adversarialMergeRequestedOverride &&
      !riskClassRequiresTwoKey &&
      !(highOrCriticalClass && !riskAllowed)
    );

  // AMA "final hammer" (operator directive 2026-07-02): once the review cycle is
  // EXHAUSTED — the remediation round budget is fully spent and the verdict still
  // has not converged — a validated strict-mode HAM terminal-remediation pass is
  // the merge authority for the adversarial verdict gate. A fresh settled-success
  // verdict and current-head `operator-approved` are not required on the
  // exhausted round. We NEVER waive the structural safety gates: the PR must
  // still be open/non-draft/mergeable, the head must still match reviewed or
  // validated HAM/rebase authority, CI must still be green, hard-stop labels
  // (incl. head-scoped adversarial-merge-blocked) still block, fast-merge state
  // still blocks, and AMA must be enabled. Risk-class policy is not a passive
  // post-exhaustion hold: validated HAM terminal remediation waives
  // `risk-class-not-permitted` for every risk class.
  const FINAL_HAMMER_WAIVABLE_REASONS = new Set([
    'verdict-not-settled-success',
    'remediation-pending',
    'remediation-state-unknown',
    'blocking-findings-present',
    'blocking-findings-unknown',
  ]);
  // Exhausted-round HAM authority waives every adversarial verdict/finding
  // reason after strict terminal remediation evidence has been validated.
  // Structural gates remain outside this set.
  const FINAL_HAMMER_VERDICT_GATE_REASONS = new Set([
    'verdict-not-settled-success',
    'blocking-findings-present',
    'blocking-findings-unknown',
    'non-blocking-findings-unknown',
    'non-blocking-findings-present',
  ]);
  const finalHammerVerdictWaiverAllowed =
    hamTerminalRemediation.ok === true;
  const waivedByFinalHammer = [];
  let effectiveReasons = reasons;
  const waivedByHamTerminalRemediation = [];
  // Tier 1 — non-blocking churn is TRUSTED to the entitled hammer agent on
  // authorized active HAM evidence (without strict `.ok` finding-count
  // provenance). A fresh adversarial review can surface new non-blocking nits on
  // each remediated head, so requiring `.ok` (whose provenance must match the
  // CURRENT review's finding counts) against an ever-changing non-blocking set
  // can deadlock terminal close. The active lane still requires trusted
  // current-head HAM commit/audit provenance; it is not a caller-controlled JSON
  // claim.
  const HAM_TERMINAL_NONBLOCKING_WAIVABLE_REASONS = new Set([
    'non-blocking-findings-present',
    'non-blocking-findings-unknown',
  ]);
  // Tier 2 — anything that could mask a REAL defect still requires the strict
  // `.ok` provenance proving the hammer actually remediated it (commit +
  // HAM-NN/closed-by trailers + audit comment covering the findings).
  const HAM_TERMINAL_STRICT_WAIVABLE_REASONS = new Set([
    'stale-review-head',
    'remediation-pending',
    'remediation-state-unknown',
    'blocking-findings-present',
    'blocking-findings-unknown',
  ]);
  // Round-3 fix (2026-06-21): the non-blocking waiver previously dropped
  // `non-blocking-findings-present`/`-unknown` on ANY `activeAuthorized` HAM
  // evidence, with NOTHING tying the HAM's addressed-findings list to the
  // CURRENT review's standing non-blocking findings. A hammer that addressed 1
  // of 2 standing non-blocking findings would still close. We now require, IN
  // ADDITION to `activeAuthorized`, that the HAM's addressed non-blocking
  // findings COVER EVERY current standing non-blocking finding BY IDENTITY
  // (normalized title). The brittle exact-COUNT match stays relaxed, but the
  // parsed identity set must be at least as complete as the known count; a
  // shorter identity list means the parser/count paths disagree and we fail
  // closed instead of checking only the subset we managed to parse. Fail closed:
  // if the current non-blocking identities are unavailable/unknown we do NOT
  // waive.
  const currentNonBlockingIdentities = Array.isArray(reviewState?.nonBlockingFindingIdentities)
    ? reviewState.nonBlockingFindingIdentities
        .map((title) => normalizeCoverageTitle(title))
        .filter(Boolean)
    : null;
  const hamAddressedNonBlockingTitles = new Set(
    Array.isArray(hamTerminalRemediation?.addressedFindings?.nonBlockingTitles)
      ? hamTerminalRemediation.addressedFindings.nonBlockingTitles
      : [],
  );
  // `nonBlockingFindings` (classified above) is the current standing
  // non-blocking finding count from the same review body.
  const currentNonBlockingCount = nonBlockingFindings.known ? nonBlockingFindings.count : null;
  const currentNonBlockingIdentityCount = currentNonBlockingIdentities === null
    ? null
    : currentNonBlockingIdentities.length;
  const currentNonBlockingIdentityCountCoversKnownCount =
    currentNonBlockingCount === null
    || currentNonBlockingCount === 0
    || (
      currentNonBlockingIdentityCount !== null
      && currentNonBlockingIdentityCount >= currentNonBlockingCount
    );
  let identityCoverageOk;
  if (currentNonBlockingCount === 0) {
    // Zero current non-blocking findings → coverage trivially satisfied.
    identityCoverageOk = true;
  } else if (
    currentNonBlockingIdentities === null
    || (currentNonBlockingCount !== null && currentNonBlockingIdentities.length === 0)
  ) {
    // Identities unavailable, or count says there ARE non-blocking findings but
    // we parsed zero identities → fail closed (no waiver).
    identityCoverageOk = false;
  } else if (!currentNonBlockingIdentityCountCoversKnownCount) {
    // Count says there are more standing non-blocking findings than the
    // identities parser could name. Do not let a subset pass `.every(...)`.
    identityCoverageOk = false;
  } else if (currentNonBlockingIdentities.length === 0) {
    // Count unknown but identities present-and-empty → nothing standing to
    // cover. (Count-unknown with non-empty identities falls through to the
    // explicit per-identity coverage check below.)
    identityCoverageOk = true;
  } else {
    identityCoverageOk = currentNonBlockingIdentities.every(
      (identity) => hamAddressedNonBlockingTitles.has(identity),
    );
  }
  // Hoisted for the audit trace; only meaningful when the HAM evidence is
  // `activeAuthorized` (set inside the block below).
  let nonBlockingCoverageOk = false;
  if (hamTerminalRemediation.activeAuthorized) {
    const strictOk = hamTerminalRemediation.ok === true;
    const exhaustedStrictOk = strictOk && reviewCycleExhausted;
    // The non-blocking waiver holds ONLY when the HAM's addressed non-blocking
    // findings cover every CURRENT standing non-blocking finding by identity.
    // `strictOk` must NOT short-circuit this (round-4 finding): `.ok` only
    // proves the addressed set matches the current review's finding COUNTS
    // (remediatedFindings) plus the HAM's own audit-coverage — it does NOT
    // prove the HAM addressed the current review's specific non-blocking
    // findings BY IDENTITY. A HAM could match the count while addressing two
    // different findings than the two currently standing. So identity coverage
    // governs the non-blocking lane outright. `strictOk` still suffices for the
    // blocking / stale-review-head / remediation-state reasons below.
    // (identityCoverageOk already fails closed when identities are unavailable
    // and is trivially true when the current non-blocking count is zero.)
    nonBlockingCoverageOk = identityCoverageOk;
    // `verdict-not-settled-success` is non-blocking-driven (Tier 1) only when
    // the settled-success verdict gate failed alongside an explicit
    // non-blocking reason. A bare verdict failure (for example Request changes
    // with known-zero structured blockers) still gates strictly.
    const hasBlockingReason =
      effectiveReasons.includes('blocking-findings-present')
      || effectiveReasons.includes('blocking-findings-unknown');
    const hasNonBlockingReason =
      effectiveReasons.includes('non-blocking-findings-present')
      || effectiveReasons.includes('non-blocking-findings-unknown');
    const inputReasons = effectiveReasons;
    effectiveReasons = [];
    for (const reason of inputReasons) {
      let waivable = false;
      if (HAM_TERMINAL_NONBLOCKING_WAIVABLE_REASONS.has(reason)) {
        // Tier 1 non-blocking waiver now ALSO requires identity coverage.
        waivable = nonBlockingCoverageOk;
      } else if (reason === 'verdict-not-settled-success') {
        // Non-blocking-driven verdict failure additionally needs coverage; a
        // blocking-driven or bare verdict failure needs strict `.ok` on the
        // exhausted round so request-changes cannot skip the remediation budget.
        waivable = hasBlockingReason
          ? exhaustedStrictOk
          : hasNonBlockingReason ? nonBlockingCoverageOk : exhaustedStrictOk;
      } else if (HAM_TERMINAL_STRICT_WAIVABLE_REASONS.has(reason)) {
        waivable = reason === 'stale-review-head' ? strictOk : exhaustedStrictOk;
      }
      if (waivable) {
        waivedByHamTerminalRemediation.push(reason);
      } else {
        effectiveReasons.push(reason);
      }
    }
  }
  if (reviewCycleExhausted) {
    const inputReasons = effectiveReasons;
    effectiveReasons = [];
    for (const reason of inputReasons) {
      let waivable = false;
      if (reason === 'risk-class-not-permitted' && riskClassFinalHammerWaivable) {
        waivable = true;
      } else if (FINAL_HAMMER_VERDICT_GATE_REASONS.has(reason)) {
        waivable = finalHammerVerdictWaiverAllowed;
      } else if (FINAL_HAMMER_WAIVABLE_REASONS.has(reason)) {
        waivable = true;
      }
      if (waivable) waivedByFinalHammer.push(reason);
      else effectiveReasons.push(reason);
    }
  }

  const trace = {
    verdict: {
      normalized: verdictNormalized,
      settledSuccess,
      operatorOverride,
      remediationPending,
      remediationStateKnown,
      blockingFindings,
      nonBlockingFindings,
      strictNonBlockingRemediation,
    },
    finalHammer: {
      active: reviewCycleExhausted,
      waived: waivedByFinalHammer,
    },
    hamTerminalRemediation: {
      ...hamTerminalRemediation,
      waived: waivedByHamTerminalRemediation,
      nonBlockingCoverage: {
        ok: nonBlockingCoverageOk,
        identityCoverageOk,
        identityCountCoversKnownCount: currentNonBlockingIdentityCountCoversKnownCount,
        currentIdentities: currentNonBlockingIdentities,
        currentIdentityCount: currentNonBlockingIdentityCount,
        addressedNonBlockingTitles: [...hamAddressedNonBlockingTitles],
        currentNonBlockingCount,
      },
    },
    riskClass: {
      resolved: riskClass,
      allowed: riskAllowed,
      requiresTwoKey: riskClassRequiresTwoKey,
      highRiskRequiresTwoKey,
      finalHammerWaivable: riskClassFinalHammerWaivable,
      permitted: riskPermitted,
      adversarialMergeRequestedOverride,
      mergeRequestedOverride: adversarialMergeRequestedOverride,
    },
    ciGreen: ci,
    branchProtection: {
      required: branchProtectionRequired,
      requiredContext,
      ok: protectionOk,
      waived: branchProtectionWaived,
      auditReason: branchProtectionWaived ? 'branch_protection_requirement_waived' : null,
    },
    blockLabels: blockingLabels,
    fastMerge,
    mergeability,
    headMatch: {
      reviewed: reviewedHead,
      current: currentHead,
      ok: headMatchOk,
      rebaseReviewCoverage,
    },
    remediation: { pending: remediationPending, known: remediationStateKnown },
    config: { enabled: amaEnabled },
  };

  return {
    eligible: effectiveReasons.length === 0,
    reasons: effectiveReasons,
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
  hasAdversarialMergeRequestedOverride,
  hasMergeRequestedOverride: hasAdversarialMergeRequestedOverride,
  hasValidScopedOverrideEvidence,
  hasCurrentLabel,
  presentHardStopLabels,
  classifyCiGreen,
  classifyBlockingFindings,
  classifyNonBlockingFindings,
  classifyFastMergeState,
  branchProtectionRequiresGate,
  resolveRequiredGateContext,
};

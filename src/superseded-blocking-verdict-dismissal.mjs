// ── SVD-02: dismiss a blocking verdict that a HAM terminal remediation superseded ──
//
// SEV `docs/postmortems/SEV-stale-blocking-verdict-is-structurally-undismissable-2026-08-26.md`.
//
// Two stale-`Request changes` dismissal paths existed before this one, and both
// were gated on a state that the stale verdict itself prevents:
//
//   1. `dismissStaleRequestChangesAfterCleanReview`
//      (`src/reviewer-stale-request-dismissal.mjs`) requires a NEW clean
//      `comment-only` review to be posted. Standing operator policy is that the
//      final HAM remediation is FINAL — no re-review follows it — so this never
//      fires for the case that needs it.
//   2. The daemon-owned `dismissStaleRequestChangesImpl` inside
//      `runDaemonCleanMergeAttempt` only runs once that attempt has been reached
//      and has cleared its live eligibility gate; the MSM-03 call site reaches it
//      for a review with zero blocking AND zero non-blocking findings. A PR
//      carrying a standing blocking verdict has a blocking finding by definition.
//
// So a PR whose FINAL remediation resolved the blocking finding parked at
// `CHANGES_REQUESTED` against a head no reviewer ever judged, until an operator
// dismissed it by hand (agent-os #5918: 4.5h; #5811 earlier).
//
// This module is the THIRD trigger, keyed on the one signal present in exactly
// that case and absent otherwise: a VALIDATED HAM TERMINAL REMEDIATION AT THE
// CURRENT HEAD. It is named for the condition it detects, not for the pass that
// calls it (SEV follow-up).
//
// IT ADDS NO MERGE AUTHORITY. It removes an obsolete verdict so the EXISTING
// daemon clean path — with every one of its own gates unchanged (live green
// required checks, mergeable, head-match, lease, worker identity) — can act.
//
// THE HARD INVARIANT: a blocking verdict whose `commit_id` EQUALS the current
// head is a LIVE finding against the code about to merge. It is never dismissed
// here. The whole value of the predicate is that it cannot confuse a live
// finding with a stale one, so the supersession check is STRICT (`!==`) and a
// verdict with no resolvable `commit_id` is retained too (fail closed).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readAmaAuditEntry } from './ama/audit.mjs';
import { headHasValidatedHamTerminalRemediation } from './daemon-clean-merge.mjs';
import { dismissStandingChangesRequestedReviewsForHead } from './github-api.mjs';
import { isDismissStaleRequestChangesOnResolvedEnabled } from './merge-agent-dispatch-decision.mjs';

const execFileAsync = promisify(execFile);

/** The machine-readable reason token this dismissal is recorded under. */
export const SUPERSEDED_BLOCKING_VERDICT_DISMISSAL_REASON =
  'ham-terminal-remediation-superseded-blocking-verdict';

/**
 * The dismissal body posted to GitHub. It NAMES BOTH HEADS — the head the
 * verdict judged and the head that remediated it — so the audit trail on the PR
 * itself, not just in watcher stdout, states exactly which snapshot went stale
 * and what superseded it.
 */
export function buildSupersededBlockingVerdictDismissalMessage({
  judgedHead,
  remediatingHead,
} = {}) {
  const judged = String(judgedHead || '').trim() || 'unknown';
  const remediating = String(remediatingHead || '').trim() || 'unknown';
  return (
    `Dismissed by AMA merge authority — reason=${SUPERSEDED_BLOCKING_VERDICT_DISMISSAL_REASON} ` +
    `judged-head=${judged} remediating-head=${remediating}. ` +
    `This Request changes was judged at ${judged}. A validated HAM terminal remediation ` +
    `superseded that head at ${remediating}, so the verdict no longer describes the code ` +
    `on this PR. Dismissing it removes an obsolete block only; every merge gate ` +
    `(required checks, mergeability, head-match, merge lease) is still enforced ` +
    `independently before this PR can land.`
  );
}

/**
 * Third dismissal trigger. Fires ONLY when ALL THREE hold:
 *
 *   1. the current head carries a VALIDATED HAM terminal remediation — either the
 *      caller already rebuilt that evidence from ground truth via
 *      `resolveHamTerminalRemediationEvidence` (terminal closer commit identity +
 *      latest HAM terminal audit comment) and passes
 *      `hamTerminalRemediationValidated:true`, or the durable per-head AMA audit
 *      carries the `ham_terminal_remediation_validated` marker for this exact head
 *      (`headHasValidatedHamTerminalRemediation`). Both are pre-existing, already
 *      trusted primitives; no new evidence is invented here;
 *   2. the blocking review's `commit_id` is STRICTLY SUPERSEDED by the current
 *      head (enforced downstream by `requireSupersededCommitId`);
 *   3. `dismissStaleRequestChangesOnResolved` is enabled
 *      (`AGENT_OS_FEATURE_FLAGS_DISMISS_STALE_REQUEST_CHANGES_ON_RESOLVED`).
 *
 * NEVER THROWS. A dismissal failure must not break the watcher tick: the PR
 * simply stays blocked and the next tick re-attempts.
 *
 * @returns {Promise<{skipped?: string, ok?: boolean, dismissal?: object, error?: Error}>}
 */
export async function dismissSupersededBlockingVerdictAtRemediatedHead({
  repo,
  prNumber,
  currentHeadSha,
  hqRoot,
  hamTerminalRemediationValidated = false,
  authoritativeReviewerLogins = [],
  env = process.env,
  logger = console,
  execFileImpl = execFileAsync,
  readAmaAuditEntryImpl = readAmaAuditEntry,
  headHasValidatedHamTerminalRemediationImpl = headHasValidatedHamTerminalRemediation,
  dismissStandingChangesRequestedReviewsForHeadImpl = dismissStandingChangesRequestedReviewsForHead,
  isDismissStaleRequestChangesOnResolvedEnabledImpl = isDismissStaleRequestChangesOnResolvedEnabled,
} = {}) {
  const head = String(currentHeadSha || '').trim();
  if (!head) return { skipped: 'no-current-head' };

  // Condition 3 — the existing feature flag governs this trigger too. Checked
  // first: it is the cheapest gate and short-circuits the audit read.
  if (!isDismissStaleRequestChangesOnResolvedEnabledImpl({ env, logger })) {
    return { skipped: 'disabled' };
  }

  // Condition 1 — a validated HAM terminal remediation AT THIS HEAD.
  const resolvedHqRoot =
    hqRoot || env?.HQ_ROOT || env?.AGENT_OS_HQ_ROOT || join(homedir(), 'agent-os-hq');
  const hamValidated = hamTerminalRemediationValidated === true ||
    await headHasValidatedHamTerminalRemediationImpl({
      hqRoot: resolvedHqRoot,
      repo,
      prNumber,
      headSha: head,
      readAmaAuditEntryImpl,
    }) === true;
  if (!hamValidated) return { skipped: 'no-validated-ham-terminal-remediation' };

  // Without a resolved authoritative reviewer login set we cannot tell an
  // authoritative reviewer's verdict from a third party's, so we never dismiss.
  const reviewerLogins = Array.isArray(authoritativeReviewerLogins)
    ? authoritativeReviewerLogins.filter(Boolean)
    : [];
  if (reviewerLogins.length === 0) {
    logger?.warn?.(
      `[watcher] superseded blocking-verdict dismissal skipped for ${repo}#${prNumber}` +
        `@${head.slice(0, 12)}: authoritative reviewer login set unresolved`,
    );
    return { skipped: 'authoritative-reviewer-logins-unresolved' };
  }

  try {
    // Condition 2 lives here: `requireSupersededCommitId` retains every standing
    // verdict whose `commit_id` equals `head` (a LIVE finding) or is unresolvable.
    const dismissal = await dismissStandingChangesRequestedReviewsForHeadImpl(
      execFileImpl,
      repo,
      prNumber,
      head,
      {
        authoritativeReviewerLogins: reviewerLogins,
        requireSupersededCommitId: head,
        message: (review) =>
          buildSupersededBlockingVerdictDismissalMessage({
            judgedHead: review?.commitId || review?.commit_id,
            remediatingHead: head,
          }),
        env,
      },
    );
    const dismissedIds = Array.isArray(dismissal?.dismissed)
      ? dismissal.dismissed.map((review) => review.id).filter(Boolean)
      : [];
    logger?.log?.(JSON.stringify({
      schemaVersion: 1,
      event: 'ama.superseded_blocking_verdict.dismissal',
      reason: SUPERSEDED_BLOCKING_VERDICT_DISMISSAL_REASON,
      repo,
      pr: prNumber,
      remediatingHead: head,
      judgedHeads: Array.isArray(dismissal?.dismissed)
        ? dismissal.dismissed.map((review) => review.commitId || review.commit_id || null)
        : [],
      attempted: Number(dismissal?.attempted || 0),
      dismissed: dismissedIds,
      retainedAtHead: Array.isArray(dismissal?.retainedAtHead)
        ? dismissal.retainedAtHead.map((review) => review.id).filter(Boolean)
        : [],
      ok: true,
    }));
    return { ok: true, dismissal };
  } catch (err) {
    logger?.warn?.(
      `[watcher] superseded blocking-verdict dismissal failed for ` +
        `${repo}#${prNumber}@${head.slice(0, 12)}; leaving the verdict standing: ` +
        `${err?.message || err}`,
    );
    logger?.log?.(JSON.stringify({
      schemaVersion: 1,
      event: 'ama.superseded_blocking_verdict.dismissal',
      reason: SUPERSEDED_BLOCKING_VERDICT_DISMISSAL_REASON,
      repo,
      pr: prNumber,
      remediatingHead: head,
      ok: false,
      error: String(err?.message || err),
      reviewId: err?.review?.id || null,
      dismissedBeforeFailure: Array.isArray(err?.dismissed)
        ? err.dismissed.map((review) => review.id).filter(Boolean)
        : [],
      failOpenForTick: true,
    }));
    return { ok: false, error: err };
  }
}

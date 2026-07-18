import {
  PAUSED_FOR_REDESIGN_LABEL,
  REVIEWER_CYCLE_CAP_REACHED_LABEL,
  REVIEW_CYCLE_OVERRIDE_LABELS,
  recordReviewCycleVerdict,
  resetReviewCycleCounter,
} from './review-cycle-cap.mjs';
import { classifyBlockingFindings } from './follow-up-merge-agent.mjs';
import { extractReviewVerdict } from './review-verdict.mjs';

export function subjectRefWithLinearTicket(subjectRef, linearTicketId, labels = []) {
  return {
    ...subjectRef,
    linearTicketId,
    labels: Array.isArray(labels) ? labels : [],
  };
}

export function normalizeLabelNames(labels = []) {
  return (Array.isArray(labels) ? labels : [])
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .map((label) => String(label || '').trim())
    .filter(Boolean);
}

async function addLabelToPR(octokit, { repoPath, prNumber, label }) {
  const [owner, repo] = String(repoPath || '').split('/');
  if (!owner || !repo || !label) return;
  await octokit.rest.issues.addLabels({
    owner,
    repo,
    issue_number: Number(prNumber),
    labels: [label],
  });
}

// Best-effort label add: swallows transient GitHub errors so a failed
// label add never unwinds a dedupe marker that has already been persisted.
// Mirrors removeLabelFromPR's non-fatal posture.
export async function addLabelToPRBestEffort(octokit, { repoPath, prNumber, label, logger = console }) {
  try {
    await addLabelToPR(octokit, { repoPath, prNumber, label });
    return { added: true };
  } catch (err) {
    logger?.warn?.(
      `[watcher] failed to add label ${label} to ${repoPath}#${prNumber}: ${err?.message || err}`
    );
    return { added: false, error: err };
  }
}

async function removeLabelFromPR(octokit, { repoPath, prNumber, label, logger = console }) {
  const [owner, repo] = String(repoPath || '').split('/');
  if (!owner || !repo || !label) return;
  try {
    await octokit.rest.issues.removeLabel({
      owner,
      repo,
      issue_number: Number(prNumber),
      name: label,
    });
  } catch (err) {
    const status = err?.status || err?.response?.status;
    if (status !== 404) {
      logger?.warn?.(
        `[watcher] failed to remove label ${label} from ${repoPath}#${prNumber}: ${err?.message || err}`
      );
    }
  }
}

export function isReviewCycleCapFailedRow(reviewRow) {
  return reviewRow?.review_status === 'failed'
    && String(reviewRow?.failure_message || '').startsWith('[review-cycle-cap]');
}

function isOperatorSelectedRedesignPause(reviewRow) {
  return isReviewCycleCapFailedRow(reviewRow)
    && String(reviewRow?.failure_message || '').includes(`operator selected ${PAUSED_FOR_REDESIGN_LABEL}`);
}

export function isAutomaticReviewCycleCapPause(reviewRow) {
  return isReviewCycleCapFailedRow(reviewRow) && !isOperatorSelectedRedesignPause(reviewRow);
}

export function shouldClearReviewCycleCapForOverride({ reviewRow, labelNames = [] } = {}) {
  const labels = new Set(normalizeLabelNames(labelNames));
  const overrideLabel = REVIEW_CYCLE_OVERRIDE_LABELS.find((label) => labels.has(label));
  if (!overrideLabel) return false;
  if (labels.has(REVIEWER_CYCLE_CAP_REACHED_LABEL)) return true;
  if (isAutomaticReviewCycleCapPause(reviewRow)) return true;
  return isOperatorSelectedRedesignPause(reviewRow)
    && (labels.has('operator-approved') || labels.has('merge-agent-requested'));
}

// Posts the escalation comment only. The caller must persist the
// escalation dedupe marker (markReviewCycleEscalated) immediately after
// this resolves and before the best-effort label add, so a transient
// label-add failure cannot cause the comment to be re-posted next tick.
export async function postReviewCycleCapEscalation(octokit, {
  repoPath,
  prNumber,
  body,
}) {
  const [owner, repo] = String(repoPath || '').split('/');
  if (!owner || !repo) throw new Error(`Invalid repo slug: ${repoPath}`);
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: Number(prNumber),
    body,
  });
}

export async function clearReviewCycleCapForOverride({
  db,
  octokit,
  repoPath,
  prNumber,
  headSha,
  labelNames = [],
  logger = console,
} = {}) {
  const labels = new Set(normalizeLabelNames(labelNames));
  const overrideLabel = REVIEW_CYCLE_OVERRIDE_LABELS.find((label) => labels.has(label));
  if (!overrideLabel) return { cleared: false, reason: 'no-override-label' };

  resetReviewCycleCounter(db, { repo: repoPath, prNumber });
  const overrideAt = new Date().toISOString();
  if (overrideLabel === PAUSED_FOR_REDESIGN_LABEL) {
    db.prepare(
      `UPDATE reviewed_prs
          SET review_status = 'failed',
              failed_at = ?,
              failure_message = ?,
              reviewer_lease_expires_at = NULL
        WHERE repo = ?
          AND pr_number = ?`
    ).run(
      overrideAt,
      `[review-cycle-cap] operator selected ${PAUSED_FOR_REDESIGN_LABEL}; automatic review remains paused for redesign`,
      repoPath,
      prNumber,
    );
  } else {
    db.prepare(
      `UPDATE reviewed_prs
          SET review_status = 'posted',
              failed_at = NULL,
              failure_message = NULL,
              reviewer_lease_expires_at = NULL
        WHERE repo = ?
          AND pr_number = ?`
    ).run(repoPath, prNumber);
  }
  if (labels.has(REVIEWER_CYCLE_CAP_REACHED_LABEL)) {
    await removeLabelFromPR(octokit, {
      repoPath,
      prNumber,
      label: REVIEWER_CYCLE_CAP_REACHED_LABEL,
      logger,
    });
  }
  logger?.log?.(
    `[watcher] review-cycle-cap override for ${repoPath}#${prNumber}: ` +
      `${overrideLabel}; cleared ${REVIEWER_CYCLE_CAP_REACHED_LABEL}, reset counter, and set review status`
  );
  return { cleared: true, overrideLabel };
}

export function reviewBodyHasStandingBlockingFindings(reviewBody) {
  // Reuse the canonical three-state classifier (follow-up-merge-agent.mjs)
  // instead of maintaining a second drifting regex. The verdict is derived
  // from the body itself so a legacy unstructured `Request changes` review
  // with no `## Blocking issues` section classifies as `unknown` rather than
  // silently counting as "no standing blockers" (which would let a runaway
  // loop on legacy-format reviews evade the cap).
  const lastVerdict = extractReviewVerdict(reviewBody);
  const { count, state } = classifyBlockingFindings(reviewBody, { lastVerdict });
  if (count > 0) return true;
  // Fail safe toward counting: an unknowable blocking state on an unresolved
  // (request-changes) review still accrues cap budget so the loop can't evade
  // the cap by emitting malformed/legacy review bodies.
  return state === 'unknown';
}

function latestCapturedReviewerPassForPR(db, { repo, prNumber } = {}) {
  return db.prepare(
    `SELECT *
       FROM reviewer_passes
      WHERE repo = ?
        AND pr_number = ?
        AND pass_kind IN ('first-pass', 'rereview')
        AND status = 'completed'
      ORDER BY ended_at DESC, pass_id DESC
      LIMIT 1`
  ).get(repo, prNumber) || null;
}

export function recordSuccessfulReviewCycleVerdict({
  db,
  repoPath,
  prNumber,
  headSha,
  postedAt,
  result,
  windowHours,
  logger = console,
} = {}) {
  try {
    const latestPass = latestCapturedReviewerPassForPR(db, { repo: repoPath, prNumber });
    const body = result?.reviewBody || latestPass?.body_md || '';
    if (!reviewBodyHasStandingBlockingFindings(body)) {
      logger?.log?.(
        `[watcher] review-cycle-count skipped for ${repoPath}#${prNumber}@${String(headSha || '').slice(0, 12)} ` +
          'because the posted verdict has no standing blocking findings'
      );
      return { recorded: false, reason: 'no-standing-blocking-findings' };
    }
    // Window measurement (shouldEscalateReviewCycle) compares against the
    // real-time `now`, so anchor `verdict_at` on the actual post time of this
    // verdict rather than the older reviewer-pass capture timestamps; those
    // predate the post and would shorten the effective window, resetting the
    // sequence marginally earlier than the configured window.
    const verdictAt = postedAt || latestPass?.body_captured_at || latestPass?.ended_at || new Date().toISOString();
    const recorded = recordReviewCycleVerdict(db, {
      repo: repoPath,
      prNumber,
      headSha,
      verdictAt,
      verdictSummary: body,
      windowHours,
    });
    if (recorded.recorded) {
      logger?.log?.(
        `[watcher] review-cycle-count ${repoPath}#${prNumber}@${String(headSha || '').slice(0, 12)} ` +
          `count=${recorded.count}`
      );
    } else if (recorded.reason === 'missing-head-sha') {
      // Loud so the silent no-op is observable: with no head SHA the cap
      // cannot count this cycle, so a runaway loop could evade it here.
      logger?.warn?.(
        `[watcher] review-cycle-count NOT recorded for ${repoPath}#${prNumber}: ` +
          'missing head SHA (cap cannot count this cycle)'
      );
    }
    return recorded;
  } catch (err) {
    logger?.warn?.(
      `[watcher] review-cycle-count record failed for ${repoPath}#${prNumber}: ${err?.message || err}`
    );
    return { recorded: false, error: err };
  }
}

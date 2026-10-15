import * as adversarialGateRecords from './adversarial-gate-status.mjs';
import { fetchHammerPr } from './hammer-pr-read.mjs';
import { resolveThrottleFloor, withGitHubBudgetScope, isGitHubRateLimitError, readGitHubBudgetState, currentGitHubBudgetScope, githubCredential, githubBudgetKey } from './rate-limit-throttle.mjs';

// Scheduling only. A durable success is a priority hint; serve must refresh the
// live head, state and all existing merge predicates before taking action.
async function runLowBudgetClosingTick({ budgets, rows, isReady, serve, logger = console, floor = resolveThrottleFloor() }) {
  const low = Object.values(budgets).filter(bucket => bucket.remaining < floor);
  if (!low.length) return false;
  logger.log(`[watcher] GitHub budget: ${low.map(bucket => `${bucket.credential || 'default'}/${bucket.resource} remaining=${bucket.remaining} reset=${bucket.resetAt}`).join('; ')}; deferring non-urgent reads`);
  for (const row of rows.filter(isReady)) {
    await withGitHubBudgetScope({ urgent: true }, async () => {
      try { await serve(row); }
      catch (err) {
        if (!isGitHubRateLimitError(err) && !err?.budgetDeferred) logger.error('[watcher] closing read failed:', err.message);
      }
    });
  }
  return true;
}

function isClosingRowReady(rootDir, row, {
  readGate = adversarialGateRecords.readGateRecord,
  resolveSettled = adversarialGateRecords.resolveSettledReviewVerdict,
} = {}) {
  const identity = { repo: row.repo, prNumber: row.pr_number, headSha: row.reviewer_head_sha };
  if (readGate?.(rootDir, identity)?.state === 'success') return true;
  // A review can settle after the last published gate. Local evidence is only
  // a priority hint; serve still runs the normal live exact-head merge gates.
  const settled = resolveSettled?.(rootDir, { ...identity, reviewRow: row, currentHeadSha: identity.headSha });
  return settled?.remediationPending === false && ['comment-only', 'approved'].includes(settled.verdict);
}

async function runLowBudgetWatcherPoll({ db, activeRepos, rootDir, domainId, execFileImpl,
  handlePostedReviewRow, createWatcherOperatorSurface, projectAdversarialGateStatus, markMerged, markClosed,
}) {
  const allBudgets = await readGitHubBudgetState();
  const credential = githubCredential({ token: process.env.GITHUB_TOKEN || null });
  const budgets = Object.fromEntries(['core', 'graphql'].map(resource => [resource,
    allBudgets[githubBudgetKey(resource, credential)]]));
  // This shortcut skips the entire discovery phase. A single depleted pool (or
  // another credential) cannot justify skipping reads that still have capacity.
  if (Object.values(budgets).some(bucket => !bucket || bucket.remaining >= resolveThrottleFloor())) return false;
  const rows = db.prepare("SELECT * FROM reviewed_prs WHERE pr_state = 'open' AND review_status = 'posted'").all()
    .filter(row => activeRepos.includes(row.repo));
  const handled = await runLowBudgetClosingTick({
    budgets, rows,
    isReady: row => isClosingRowReady(rootDir, row),
    serve: async row => {
      const pr = await fetchHammerPr(row.repo, row.pr_number, { withChecks: false });
      if (pr.state === 'MERGED') { markMerged(pr.mergedAt, row.repo, row.pr_number); return; }
      if (pr.state === 'CLOSED') { markClosed(pr.closedAt, row.repo, row.pr_number); return; }
      if (pr.headRefOid !== row.reviewer_head_sha) return;
      const subjectRef = { domainId: row.domain_id || domainId,
        subjectExternalId: `${row.repo}#${row.pr_number}`, revisionRef: pr.headRefOid };
      await handlePostedReviewRow({
        rootDir, repoPath: row.repo, prNumber: row.pr_number, existing: row,
        subjectRef, currentRevisionRef: pr.headRefOid, labelNames: (pr.labels || []).map(label => label.name),
        operatorSurface: createWatcherOperatorSurface(), domainId: subjectRef.domainId,
        projectGateStatusSafe: reviewRow => projectAdversarialGateStatus(rootDir, {
          repo: row.repo, prNumber: row.pr_number, headSha: pr.headRefOid,
          labels: pr.labels, prAuthor: pr.author, reviewRow, domainId: subjectRef.domainId,
          execFileImpl,
        }),
      });
    },
  });
  if (handled && currentGitHubBudgetScope()) currentGitHubBudgetScope().deferred = true;
  return handled;
}

export { isClosingRowReady, runLowBudgetClosingTick, runLowBudgetWatcherPoll };

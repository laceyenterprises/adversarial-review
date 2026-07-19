// ── PR lifecycle sync: merge-closeout capture + fast-merge close path ─────────
//
// ARC-18: extracted from watcher.mjs as leaf helpers — the merged-PR closeout
// capture retry machinery, the fast-merge close-path isolation wrapper, the
// orchestration-mode resolver, and `syncPRLifecycle` (the open-PR merge/close
// poll). `syncPRLifecycle` reads WATCHER_PRIMARY_DOMAIN_ID, which stays in
// watcher.mjs; it is threaded here via the `primaryDomainId` parameter (see the
// default note on the function). `runFastMergeClosePathIsolated` previously
// defaulted `repos` to watcher's mutable `activeRepos`; that value is now
// threaded from the watcher call site (pollOnce) and the default here is an
// inert `[]`.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  db,
  stmtGetOpenPRs,
  stmtGetReviewRow,
  stmtMarkClosed,
  stmtMarkMerged,
} from './review-state-db.mjs';
import { listPendingMergeCloseouts } from './review-state.mjs';
import { pollFastMergeQueue, resolveFastMergePerPollCap } from './follow-up-merge-agent.mjs';
import { scrapeMergeCloseout } from './closeout-scraper.mjs';
import { fetchConditionalRestPage } from './conditional-request.mjs';
import { loadConfigCached } from './config-loader.mjs';
import { fetchPullRequestHeadAndState } from './github-api.mjs';
import { normalizeLabelNames, subjectRefWithLinearTicket } from './review-cycle-cap-actions.mjs';
import { queueAndAttemptMergeAgentLifecycleCleanup } from './merge-agent-lifecycle-cleanup.mjs';
import { fireDagAutowalkOnMerge } from './dag-autowalk-on-merge.mjs';
import { deleteGateRecordsForPR } from './adversarial-gate-status.mjs';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function runFastMergeClosePathIsolated({
  pollImpl = pollFastMergeQueue,
  db: reviewDb = db,
  ghClient = execFileAsync,
  rootDir = ROOT,
  perPollCap = resolveFastMergePerPollCap(),
  repos = [],
  logger = console,
  env = process.env,
} = {}) {
  try {
    const fastMergeSummary = await pollImpl({
      db: reviewDb,
      ghClient,
      rootDir,
      perPollCap,
      repos,
      logger,
      env,
    });
    if (fastMergeSummary.processed > 0) {
      logger.log?.(
        `[watcher] fast-merge close path: processed=${fastMergeSummary.processed} ` +
        `merged=${fastMergeSummary.merged} blocked=${fastMergeSummary.blocked} ` +
        `requeued_head_change=${fastMergeSummary.requeued_head_change} ` +
        `requeued_veto=${fastMergeSummary.requeued_veto} ` +
        `pending=${fastMergeSummary.skipped_still_pending}`
      );
    }
    return { ok: true, summary: fastMergeSummary };
  } catch (err) {
    logger.error?.('[watcher] fast-merge close path failed; continuing normal merge-agent/review work:', err?.message || err);
    return { ok: false, error: err };
  }
}

async function attemptMergeCloseoutCapture({
  octokit,
  repo,
  prNumber,
  mergedAt,
  now = new Date(),
  logger = console,
} = {}) {
  const [owner, repoName] = String(repo || '').split('/');
  const result = await scrapeMergeCloseout({
    db,
    repo,
    prNumber,
    mergedAt,
    now,
    execFileImpl: execFileAsync,
    logger,
    fetchIssueCommentsImpl: async () => {
      if (typeof octokit?.rest?.issues?.listComments !== 'function') {
        throw new Error('octokit.rest.issues.listComments unavailable');
      }
      const comments = [];
      const params = {
        owner,
        repo: repoName,
        issue_number: prNumber,
        per_page: 100,
      };
      for (let page = 1; ; page += 1) {
        const response = await fetchConditionalRestPage({
          category: 'other',
          endpoint: 'issues.comments',
          repo,
          prNumber,
          rootDir: ROOT,
          logger,
          params: { page, per_page: params.per_page },
          request: (requestParams) => octokit.rest.issues.listComments({
            ...params,
            ...requestParams,
            page,
          }),
        });
        const pageComments = Array.isArray(response?.data) ? response.data : [];
        comments.push(...pageComments.map((comment) => ({
          id: comment?.node_id ?? null,
          login: comment?.user?.login ?? null,
          created_at: comment?.created_at ?? null,
          body: comment?.body ?? '',
        })));
        if (pageComments.length < params.per_page) break;
      }
      return comments;
    },
  });
  if (!result.ok) {
    logger.warn?.(
      `[watcher] merge closeout capture still owed for ${repo}#${prNumber}`
    );
    return result;
  }
  logger.log?.(
    `[watcher] merge closeout scrape ${repo}#${prNumber}: comments=${result.commentCount} settled_empty=${result.settledEmpty}`
  );
  return result;
}

// Cap per-tick batch so a backlog of dozens-to-hundreds of merged-but-
// uncaptured PRs (steady state after a watcher outage, SQLite restore,
// or upstream gh blip) does not stall the poll loop for hours behind a
// serial `gh api --paginate` × retry budget per row. Freshly-merged
// rows have the highest pending-query priority; chronic failures sort
// to the bottom via scrape_attempt_count.
const PENDING_MERGE_CLOSEOUTS_PER_TICK = 20;
// Hard wall-clock budget per tick. The serial `await` shape means a row
// stuck on the gh retry path costs ~45s; without a budget the per-tick
// cap of 20 can theoretically burn ~15 minutes of poll-loop time while
// fast-merge / open-PR sweep work is starved. The budget is checked
// between rows: we never abort a row mid-flight (so its DB writes stay
// consistent), but once the budget is spent the remaining rows are
// left for the next tick. Freshly-merged rows always come first via
// the listPendingMergeCloseouts ordering, so what gets deferred is the
// chronic-failure tail — exactly the rows it is safe to defer.
const PENDING_MERGE_CLOSEOUTS_BUDGET_MS = 60_000;

export function resolveOrchestrationMode({
  loadedConfig = null,
  loadConfigImpl = loadConfigCached,
  logger = console,
  context = 'merge-agent dispatch',
} = {}) {
  let orchestrationMode = 'native';
  try {
    const cfg = loadedConfig || loadConfigImpl();
    if (typeof cfg?.getOrchestrationMode === 'function') {
      orchestrationMode = cfg.getOrchestrationMode() || 'native';
    }
  } catch (cfgErr) {
    logger?.warn?.(
      `[watcher] orchestration_mode load failed for ${context}; defaulting to native: ${cfgErr?.message || cfgErr}`,
    );
  }
  return orchestrationMode;
}

export async function retryPendingMergeCloseouts({
  octokit,
  limit = PENDING_MERGE_CLOSEOUTS_PER_TICK,
  budgetMs = PENDING_MERGE_CLOSEOUTS_BUDGET_MS,
  logger = console,
} = {}) {
  // Pass `now` per-iteration: a serial loop across the batch can take
  // several minutes under backlog, and a stale `now` would flip
  // settle-empty decisions for the last few PRs by minutes.
  const rows = listPendingMergeCloseouts(db, { limit, now: new Date() });
  const startedAt = Date.now();
  let processed = 0;
  for (const row of rows) {
    if (!row?.merged_at) continue;
    if (Number.isFinite(budgetMs) && budgetMs > 0 && Date.now() - startedAt >= budgetMs) {
      const remaining = rows.length - processed;
      logger.warn?.(
        `[watcher] merge closeout capture budget (${budgetMs}ms) spent after ${processed} rows; deferring ${remaining} to next tick`
      );
      break;
    }
    await attemptMergeCloseoutCapture({
      octokit,
      repo: row.repo,
      prNumber: row.pr_number,
      mergedAt: row.merged_at,
      now: new Date(),
      logger,
    });
    processed += 1;
  }
}

// ── Lifecycle sync: check open PRs for merge/close ──────────────────────────

/**
 * For every PR we previously marked as "open", check if it has since been
 * merged or closed and update Linear accordingly.
 *
 * ARC-18: `primaryDomainId` threads WATCHER_PRIMARY_DOMAIN_ID (watcher-internal,
 * derived from the domain registry) as the domain fallback when a review row
 * carries no `domain_id`. The watcher poll path (runQueuedReviewAdoptionPhase →
 * pollOnce) always passes it; the `null` default is only reached by a caller
 * that omits it, and is not exercised in production.
 */
export async function syncPRLifecycle(octokit, operatorSurface, primaryDomainId = null) {
  const openRows = stmtGetOpenPRs.all();
  if (openRows.length === 0) return;

  for (const row of openRows) {
    const { repo, pr_number: prNumber, linear_ticket: linearTicketId } = row;

    let pr;
    let labelNames = [];
    try {
      const freshState = await fetchPullRequestHeadAndState(repo, prNumber, {
        execFileImpl: execFileAsync,
      });
      labelNames = normalizeLabelNames(freshState.labels);
      pr = {
        ...freshState,
        labels: freshState.labels,
      };
    } catch (err) {
      console.error(`[watcher] Failed to fetch PR ${repo}#${prNumber}:`, err.message);
      continue;
    }

    if (pr.mergedAt) {
      console.log(`[watcher] PR ${repo}#${prNumber} was merged — syncing Linear`);
      await queueAndAttemptMergeAgentLifecycleCleanup({
        pr, repo, prNumber, transition: 'merged',
      });
      // Advance the merged PR's dag-run (AMA D5 gate). Persist the owed work
      // before marking the lifecycle transition merged so a local state-write
      // failure leaves this row eligible for the next watcher tick.
      try {
        fireDagAutowalkOnMerge({ repo, prNumber });
      } catch (err) {
        console.error(
          `[watcher] dag autowalk-on-merge owed-record write failed for ${repo}#${prNumber}; ` +
          `leaving lifecycle row open for retry: ${err?.message || err}`
        );
        continue;
      }
      stmtMarkMerged.run(pr.mergedAt, repo, prNumber);
      // Closeout capture is intentionally NOT awaited inline here. The
      // gh retry budget for a single scrape (~30–45s worst case) would
      // otherwise stall the gates-deletion and Linear triage sync for
      // every later PR on the open-list when two or more merge between
      // polls. retryPendingMergeCloseouts runs later in the same
      // pollOnce tick and picks up this freshly-merged row from the
      // pending list.
      deleteGateRecordsForPR(ROOT, { repo, prNumber });
      // ARC-03 review finding: sync triage under the row's owning domain so a
      // secondary domain's tracking ticket is finalized too, not just code-pr's.
      const mergedRowDomainId =
        stmtGetReviewRow.get(repo, prNumber)?.domain_id || primaryDomainId;
      await operatorSurface.syncTriageStatus(
        subjectRefWithLinearTicket({
          domainId: mergedRowDomainId,
          subjectExternalId: `${repo}#${prNumber}`,
          revisionRef: pr.headRefOid || null,
        }, linearTicketId, labelNames),
        'finalized'
      );
    } else if (pr.state === 'closed') {
      console.log(`[watcher] PR ${repo}#${prNumber} was closed (unmerged) — syncing Linear`);
      await queueAndAttemptMergeAgentLifecycleCleanup({
        pr, repo, prNumber, transition: 'closed',
      });
      stmtMarkClosed.run(pr.closedAt ?? new Date().toISOString(), repo, prNumber);
      deleteGateRecordsForPR(ROOT, { repo, prNumber });
      const closedRowDomainId =
        stmtGetReviewRow.get(repo, prNumber)?.domain_id || primaryDomainId;
      await operatorSurface.syncTriageStatus(
        subjectRefWithLinearTicket({
          domainId: closedRowDomainId,
          subjectExternalId: `${repo}#${prNumber}`,
          revisionRef: pr.headRefOid || null,
        }, linearTicketId, labelNames),
        'halted'
      );
    }
    // Still open → nothing to do
  }
}

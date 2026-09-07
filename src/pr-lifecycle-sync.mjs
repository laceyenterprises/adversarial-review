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
import {
  reconcileTerminalPrState,
  writePrTerminalReconcileState,
} from './pr-terminal-reconcile.mjs';
import {
  attemptPendingTriageSync,
  queuePendingTriageSync,
} from './pending-triage-sync.mjs';

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

/**
 * Rebuild the triage subject ref from a queued record.
 *
 * Exported so `retryPendingTriageSyncs` on a later tick constructs exactly the
 * same subject ref as the inline first attempt did. The record carries every
 * field, so the drain never needs the reviewed_prs row -- which is terminal by
 * then and no longer on the open list.
 */
export function buildTriageSubjectRef(record) {
  return subjectRefWithLinearTicket({
    domainId: record.domainId,
    subjectExternalId: `${record.repo}#${record.prNumber}`,
    revisionRef: record.revisionRef || null,
  }, record.linearTicketId, record.labels || []);
}

// ── Lifecycle sync: check open PRs for merge/close ──────────────────────────

/**
 * For every PR we previously marked as "open", check if it has since been
 * merged or closed, record the terminal fact, and update Linear accordingly.
 *
 * ARC-18: `primaryDomainId` threads WATCHER_PRIMARY_DOMAIN_ID (watcher-internal,
 * derived from the domain registry) as the domain fallback when a review row
 * carries no `domain_id`. The watcher poll path (runQueuedReviewAdoptionPhase →
 * pollOnce) always passes it; the `null` default is only reached by a caller
 * that omits it, and is not exercised in production.
 *
 * TREC-01 restructured the per-PR body. It used to be one try block whose LAST
 * statement was the `stmtMarkMerged` / `stmtMarkClosed` write, sitting behind a
 * remote `operatorSurface.syncTriageStatus` await; and its per-PR fetch failure
 * `continue`d silently. Both lost the terminal fact, and because the two alert
 * surfaces that read `pr_state` threshold on elapsed age, a lost transition
 * became an alert that could never self-clear. The loop now lives in
 * `reconcileTerminalPrState`, which contains per-PR failures, orders the mark
 * between durable owed-work and best-effort reporting, and writes an
 * attestation the health surface reads to tell a phantom finding from a real
 * one. Behaviour for a PR that is genuinely still open is unchanged.
 */
export async function syncPRLifecycle(octokit, operatorSurface, primaryDomainId = null) {
  const openRows = stmtGetOpenPRs.all();
  if (openRows.length === 0) {
    // Still attest. "Nothing was open" is a verified-clean mirror, and the
    // health surface must be able to distinguish it from "nothing has ever run".
    const emptySummary = await reconcileTerminalPrState({
      rows: [],
      fetchLiveState: async () => null,
      markMerged: () => {},
      markClosed: () => {},
      source: 'lifecycle-sync',
    });
    persistReconcileAttestation(emptySummary);
    return emptySummary;
  }

  const linearTicketByPr = new Map(
    openRows.map((row) => [`${row.repo}#${row.pr_number}`, row.linear_ticket])
  );
  // Records queued in onBeforeMark, replayed in onAfterMark. Keeps the inline
  // first attempt from re-reading a file we just wrote.
  const queuedTriageByPr = new Map();

  const summary = await reconcileTerminalPrState({
    rows: openRows,
    source: 'lifecycle-sync',
    fetchLiveState: async (repo, prNumber) => {
      const freshState = await fetchPullRequestHeadAndState(repo, prNumber, {
        execFileImpl: execFileAsync,
      });
      return { ...freshState, labels: freshState.labels };
    },
    // Durable owed work. Everything here either writes a local queue record or
    // deletes local state, so it stays correct while GitHub or Linear is down.
    // A throw defers the mark, keeping the row eligible next tick — dropping
    // the mark is the only way these obligations get retried.
    onBeforeMark: async ({ repo, prNumber, transition, live }) => {
      try {
        await queueAndAttemptMergeAgentLifecycleCleanup({
          pr: live, repo, prNumber, transition,
        });
      } catch (err) {
        // upsertMergeAgentLifecycleCleanup already persisted the obligation
        // before the attempt; retryPendingMergeAgentLifecycleCleanups drains
        // it. Only the opportunistic attempt failed, so this must not defer.
        console.error(
          `[watcher] merge-agent lifecycle cleanup attempt failed for ${repo}#${prNumber} `
          + `(queued for retry):`,
          err?.message || err
        );
      }
      if (transition === 'merged') {
        // Advance the merged PR's dag-run (AMA D5 gate). Persist the owed work
        // before marking the lifecycle transition merged so a local state-write
        // failure leaves this row eligible for the next watcher tick.
        fireDagAutowalkOnMerge({ repo, prNumber });
      }
      deleteGateRecordsForPR(ROOT, { repo, prNumber });
      // Persist the Linear obligation BEFORE the mark. Once the row is marked
      // terminal it leaves the open list, so this record becomes the only thing
      // that remembers the ticket still needs finalizing. A throw here defers
      // the mark on purpose — that is the one case where the open row must
      // remain the retry vehicle.
      const queued = queuePendingTriageSync(ROOT, {
        repo,
        prNumber,
        transition,
        status: transition === 'merged' ? 'finalized' : 'halted',
        domainId: stmtGetReviewRow.get(repo, prNumber)?.domain_id || primaryDomainId,
        linearTicketId: linearTicketByPr.get(`${repo}#${prNumber}`) ?? null,
        labels: normalizeLabelNames(live.labels),
        revisionRef: live.headRefOid || null,
      });
      queuedTriageByPr.set(`${repo}#${prNumber}`, queued);
    },
    // Best-effort remote reporting, deliberately AFTER the mark. Closeout
    // capture is intentionally not awaited inline: the gh retry budget for one
    // scrape (~30-45s worst case) would stall every later PR on the open list
    // when two or more merge between polls. retryPendingMergeCloseouts runs
    // later in the same pollOnce tick and picks up this freshly-merged row.
    onAfterMark: async ({ repo, prNumber, transition }) => {
      // Opportunistic first attempt at the obligation queued above. On failure
      // the record stays pending and retryPendingTriageSyncs drains it on a
      // later tick, so Linear still converges — without the terminal fact
      // having been held hostage to this call.
      const result = await attemptPendingTriageSync({
        rootDir: ROOT,
        record: queuedTriageByPr.get(`${repo}#${prNumber}`),
        operatorSurface,
        buildSubjectRef: buildTriageSubjectRef,
      });
      console.log(
        `[watcher] PR ${repo}#${prNumber} was `
        + `${transition === 'merged' ? 'merged' : 'closed (unmerged)'} — recorded terminal; `
        + `Linear triage ${result.ok ? 'synced' : 'queued for retry'}`
      );
    },
    markMerged: (mergedAt, repo, prNumber) => stmtMarkMerged.run(mergedAt, repo, prNumber),
    markClosed: (closedAt, repo, prNumber) => stmtMarkClosed.run(closedAt, repo, prNumber),
  });

  for (const entry of summary.unresolved) {
    console.error(
      `[watcher] Failed to fetch PR ${entry.repo}#${entry.prNumber}: ${entry.reason}`
    );
  }
  if (summary.unresolvedCount > 0) {
    // The line the 2026-09-07 incident had no equivalent of. Without it, a
    // fleet-wide 401 read as "every PR is still open" and the health surface
    // blamed reviewer capacity.
    console.error(
      `[watcher] PR lifecycle sync could not resolve ${summary.unresolvedCount}/${summary.checked} `
      + `open PR(s) against GitHub; their mirror state is UNVERIFIED and any queue_starvation / `
      + `terminal_but_unmerged finding naming them may be stale.`
    );
  }
  if (summary.merged > 0 || summary.closed > 0) {
    console.log(
      `[watcher] PR lifecycle sync: checked=${summary.checked} merged=${summary.merged} `
      + `closed=${summary.closed} still_open=${summary.stillOpen} `
      + `unresolved=${summary.unresolvedCount} deferred=${summary.deferredCount}`
    );
  }

  persistReconcileAttestation(summary);
  return summary;
}

function persistReconcileAttestation(summary) {
  try {
    writePrTerminalReconcileState(ROOT, summary);
  } catch (err) {
    // The attestation is diagnostic. Failing to write it must not fail the
    // sync that already did the real work; the health surface will read the
    // missing/stale record as "unverified", which is the honest verdict.
    console.error('[watcher] failed to persist PR lifecycle reconcile state:', err?.message || err);
  }
}

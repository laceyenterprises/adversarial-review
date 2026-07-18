// ── PR lifecycle sync: merge-closeout capture + fast-merge close path ─────────
//
// ARC-18: extracted from watcher.mjs as leaf helpers — the merged-PR closeout
// capture retry machinery, the fast-merge close-path isolation wrapper, and the
// orchestration-mode resolver. `syncPRLifecycle` intentionally stays in
// watcher.mjs (a source-string test pins its location); it does not reference
// anything moved here. `runFastMergeClosePathIsolated` previously defaulted
// `repos` to watcher's mutable `activeRepos`; that value is now threaded from
// the watcher call site (pollOnce) and the default here is an inert `[]`.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './review-state-db.mjs';
import { listPendingMergeCloseouts } from './review-state.mjs';
import { pollFastMergeQueue, resolveFastMergePerPollCap } from './follow-up-merge-agent.mjs';
import { scrapeMergeCloseout } from './closeout-scraper.mjs';
import { fetchConditionalRestPage } from './conditional-request.mjs';
import { loadConfigCached } from './config-loader.mjs';

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

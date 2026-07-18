import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  db,
  stmtMarkFastMergeAuditPending,
  stmtMarkFastMergeAuditWritten,
  stmtMarkFastMergeAuditError,
  stmtGetPendingFastMergeAudits,
  stmtGetFastMergeSkippedPRs,
  stmtUpdateReviewLabels,
} from './review-state-db.mjs';
import {
  buildFastMergeAuditEntry,
  fastMergeDecisionFromLabels,
  fetchLivePRLabels,
  writeFastMergeAuditPayload,
} from './adapters/subject/github-pr/fast-merge.mjs';
import { requestReviewRereview } from './review-state.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FAST_MERGE_RECOVERY_PER_TICK = Math.max(
  1,
  Number.parseInt(process.env.FML_WATCHER_RECOVERY_PER_TICK || '50', 10) || 50,
);

function recordFastMergeAuditPending({ repo, prNumber, entry }) {
  stmtMarkFastMergeAuditPending.run(JSON.stringify(entry), repo, prNumber);
}

export function markFastMergeAuditWritten({ repo, prNumber }) {
  stmtMarkFastMergeAuditWritten.run(repo, prNumber);
}

export function markFastMergeAuditError({ repo, prNumber, err }) {
  stmtMarkFastMergeAuditError.run(String(err?.message || err || 'unknown audit write failure'), repo, prNumber);
}

export function retryPendingFastMergeAudits({ logger = console } = {}) {
  const rows = stmtGetPendingFastMergeAudits.all(FAST_MERGE_RECOVERY_PER_TICK);
  for (const row of rows) {
    let entry;
    try {
      entry = JSON.parse(row.fast_merge_audit_payload_json || '{}');
    } catch (err) {
      markFastMergeAuditError({ repo: row.repo, prNumber: row.pr_number, err });
      logger.error?.(
        `[watcher] fast-merge pending audit payload is invalid for ${row.repo}#${row.pr_number}: ${err?.message || err}`
      );
      continue;
    }
    try {
      writeFastMergeAuditPayload(ROOT, entry);
      markFastMergeAuditWritten({ repo: row.repo, prNumber: row.pr_number });
    } catch (err) {
      markFastMergeAuditError({ repo: row.repo, prNumber: row.pr_number, err });
      logger.error?.(
        `[watcher] fast-merge pending audit retry failed for ${row.repo}#${row.pr_number}: ${err?.message || err}`
      );
    }
  }
}

export async function recoverFastMergeVetoes(octokit, { logger = console } = {}) {
  const skippedRows = stmtGetFastMergeSkippedPRs.all(FAST_MERGE_RECOVERY_PER_TICK);
  for (const row of skippedRows) {
    const [owner, repo] = String(row.repo || '').split('/');
    if (!owner || !repo) continue;
    const liveLabels = await fetchLivePRLabels(octokit, {
      owner,
      repo,
      prNumber: row.pr_number,
      logger,
    });
    if (!liveLabels) continue;
    const decision = fastMergeDecisionFromLabels(liveLabels);
    stmtUpdateReviewLabels.run(JSON.stringify(liveLabels), row.repo, row.pr_number);
    const lostFastMergeAuthorization = !decision.hasFastMergeLabel || decision.hasVeto;
    if (!lostFastMergeAuthorization) continue;

    const requeuedAt = new Date().toISOString();
    const action = decision.hasVeto ? 'veto-requeued' : 'label-removed-requeued';
    const reason = decision.hasVeto
      ? `fast-merge veto label observed at ${requeuedAt}; requeueing normal first-pass review`
      : `fast-merge authorization labels absent at ${requeuedAt}; requeueing normal first-pass review`;
    let priorCategories = [];
    try {
      priorCategories = fastMergeDecisionFromLabels(JSON.parse(row.labels_json || '[]')).categories;
    } catch {
      priorCategories = [];
    }
    const auditEntry = buildFastMergeAuditEntry({
      action,
      repo: row.repo,
      prNumber: row.pr_number,
      categories: decision.categories.length ? decision.categories : priorCategories,
      labels: liveLabels,
      authorizedHeadSha: row.fast_merge_authorized_head_sha || null,
      authorizedAt: row.reviewed_at || requeuedAt,
      skippedAt: row.reviewed_at || null,
      vetoedAt: decision.hasVeto ? requeuedAt : null,
      requeueResult: {
        triggered: false,
        status: 'attempting',
        reason,
      },
    });
    recordFastMergeAuditPending({ repo: row.repo, prNumber: row.pr_number, entry: auditEntry });

    let requeueResult;
    try {
      requeueResult = requestReviewRereview({
        rootDir: ROOT,
        repo: row.repo,
        prNumber: row.pr_number,
        requestedAt: requeuedAt,
        reason,
        allowFastMergeSkipped: true,
        db,
      });
    } catch (err) {
      logger.error?.(
        `[watcher] fast-merge requeue failed for ${row.repo}#${row.pr_number}: ${err?.message || err}`
      );
      continue;
    }

    auditEntry.requeue_result = {
      triggered: Boolean(requeueResult?.triggered),
      status: requeueResult?.status || null,
      reason: requeueResult?.reason || null,
    };
    recordFastMergeAuditPending({ repo: row.repo, prNumber: row.pr_number, entry: auditEntry });
    try {
      writeFastMergeAuditPayload(ROOT, auditEntry);
      markFastMergeAuditWritten({ repo: row.repo, prNumber: row.pr_number });
    } catch (err) {
      markFastMergeAuditError({ repo: row.repo, prNumber: row.pr_number, err });
      logger.error?.(
        `[watcher] fast-merge ${action} audit write failed for ${row.repo}#${row.pr_number}: ${err?.message || err}`
      );
    }
    logger.log?.(
      `[watcher] fast-merge ${action} for ${row.repo}#${row.pr_number}: requeue ${requeueResult?.status || 'unknown'}`
    );
  }
}

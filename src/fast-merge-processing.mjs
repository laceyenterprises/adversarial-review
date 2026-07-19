// Fast-merge processing / orchestration layer.
//
// The HAM (hammer) audit-trust verification chain, the PR-view/checks fetchers
// and their summarizer, the close/merge audit-record writers, the terminal /
// retryable-refusal / requeue state transitions, and the per-PR + queue
// orchestrators (`processFastMergePR` / `pollFastMergeQueue`). These were
// extracted verbatim from `follow-up-merge-agent.mjs` (ARC-19 decomposition)
// so the merge-agent monolith no longer owns the fast-merge processing path.
//
// The low-level GitHub read/transport primitives live in the sibling
// `fast-merge-github-io.mjs` leaf and are imported back here. The
// merge-agent dispatch/coexistence orchestration stays in the monolith.
//
// `execFileAsync`/`isoNow`/`resolveHqRoot`/`resolveHqOwner`/`normalizeLabelNames`
// are behavior-preserving private copies of the pervasive monolith helpers,
// mirroring the copy pattern already used by `fast-merge-github-io.mjs`
// (execFileAsync/sleep) and `reviewer.mjs`/`ama/labels.mjs`. They are used
// broadly across the monolith and remain defined there for its own callers;
// the copies keep this leaf free of a circular import back into the monolith.

import { execFile, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { writeFileAtomic } from './atomic-write.mjs';
import { fastMergeAuditDir, fastMergeAuditPath } from './fast-merge-audit-storage.mjs';
import {
  FAST_MERGE_GH_TIMEOUT_MS,
  execFileFromGhClient,
  isRetryableGhTransportError,
  withGhRetry,
  parseGhJson,
  hasMatchingHamAuditComment,
  fetchFastMergeHamCommit,
  fetchFastMergeTimeline,
} from './fast-merge-github-io.mjs';
import { writeAdapterPullRequestMerge } from './github-adapter-client.mjs';
import { requestReviewRereview } from './review-state.mjs';
import { readJsonFileDetailed } from './merge-agent-original-worker.mjs';
import { amaAuditFilePath, readAmaAuditEntry } from './ama/audit.mjs';
import {
  AMA_CLOSER_LEASE_STATUS,
  readAmaCloserLease,
} from './ama/closer-lease.mjs';
import { parseRemediatedFindingsTrailer } from './ama/ham-provenance.mjs';

const execFileAsync = promisify(execFile);

function isoNow() {
  return new Date().toISOString();
}

function resolveHqRoot(env = {}) {
  const root = String(env.HQ_ROOT || '').trim();
  return root || null;
}

function resolveHqOwner(hqRoot) {
  if (!hqRoot) return null;
  const config = readJsonFileDetailed(join(hqRoot, '.hq', 'config.json'));
  if (!config.ok) {
    return {
      ownerUser: null,
      reason: 'hq-owner-unknown',
      detail: config.error?.message || String(config.error),
      code: config.error?.code || null,
    };
  }
  const ownerUser = String(config.value?.ownerUser || '').trim();
  if (!ownerUser) {
    return {
      ownerUser: null,
      reason: 'hq-owner-unknown',
      detail: 'ownerUser missing from .hq/config.json',
      code: null,
    };
  }
  return {
    ownerUser,
    reason: null,
    detail: null,
    code: null,
  };
}

function normalizeLabelNames(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => {
      if (typeof label === 'string') return label.trim().toLowerCase();
      if (typeof label?.name === 'string') return label.name.trim().toLowerCase();
      return '';
    })
    .filter(Boolean);
}

const FAST_MERGE_VETO_LABEL = 'fast-merge-veto';
const FAST_MERGE_LABEL_PREFIX = 'fast-merge:';
const FAST_MERGE_SKIPPED_STATE = 'fast_merge_skipped';
const FAST_MERGE_MERGED_STATE = 'fast_merge_merged';
const FAST_MERGE_CLOSED_STATE = 'fast_merge_closed';
const FAST_MERGE_BLOCKED_STATE = 'fast_merge_blocked';
const FML_MERGE_AGENT_PER_POLL_CAP_ENV = 'FML_MERGE_AGENT_PER_POLL_CAP';
const DEFAULT_FML_MERGE_AGENT_PER_POLL_CAP = 5;
const FAST_MERGE_FAILURE_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'fail', 'cancel']);
const FAST_MERGE_PENDING_STATES = new Set(['', 'pending', 'in_progress', 'queued', 'waiting', 'requested', 'expected']);
const FAST_MERGE_SUCCESS_CONCLUSIONS = new Set(['success', 'neutral', 'skipped', 'pass', 'skipping']);

function resolveFastMergePerPollCap(env = process.env) {
  const raw = env?.[FML_MERGE_AGENT_PER_POLL_CAP_ENV];
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_FML_MERGE_AGENT_PER_POLL_CAP;
  }
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_FML_MERGE_AGENT_PER_POLL_CAP;
}

function buildFastMergeCloseAuditEntry({
  action,
  repo,
  prNumber,
  authorizedHeadSha = null,
  currentHeadSha = null,
  mergedHeadSha = null,
  mergeSha = null,
  manualMergeDetected = false,
  closedWithoutMerge = false,
  failureReason = null,
  refusalReason = null,
  checkConclusions = null,
  headChanged = false,
  vetoDetected = false,
  labelRemoved = false,
  requeuePath = null,
  requeueResult = null,
  mergeStdout = null,
  mergeStderr = null,
  at = isoNow(),
} = {}) {
  const sessionUuid = `fast-merge-${action}-${randomUUID()}`;
  return {
    kind: 'fast-merge-audit',
    schemaVersion: 1,
    auditType: 'fast-merge-close',
    sessionUuid,
    fast_merge: true,
    action,
    repo,
    pr_number: prNumber,
    authorized_head_sha: authorizedHeadSha,
    fast_merge_authorized_head_sha: authorizedHeadSha,
    current_head_sha: currentHeadSha,
    merged_head_sha: mergedHeadSha,
    merge_sha: mergeSha,
    manual_merge_detected: Boolean(manualMergeDetected),
    closed_without_merge: Boolean(closedWithoutMerge),
    failure_reason: failureReason,
    refusal_reason: refusalReason,
    check_conclusions: checkConclusions,
    head_changed: Boolean(headChanged),
    veto_detected: Boolean(vetoDetected),
    label_removed: Boolean(labelRemoved),
    requeue_path: requeuePath,
    requeue_result: requeueResult,
    merge_stdout: mergeStdout,
    merge_stderr: mergeStderr,
    recorded_at: at,
  };
}

function writeFastMergeCloseAuditEntry(rootDir, entry) {
  mkdirSync(fastMergeAuditDir(rootDir), { recursive: true });
  const filePath = fastMergeAuditPath(rootDir, {
    repo: entry?.repo,
    prNumber: entry?.pr_number,
    action: entry?.action || 'unknown',
    at: entry?.recorded_at,
  });
  writeFileAtomic(filePath, `${JSON.stringify(entry, null, 2)}\n`);
  return filePath;
}

function recordFastMergeCloseAuditPending(db, { repo, prNumber, entry, err } = {}) {
  if (!db || typeof db.prepare !== 'function') return false;
  db.prepare(
    `UPDATE reviewed_prs
        SET fast_merge_audit_status = 'pending',
            fast_merge_audit_payload_json = ?,
            fast_merge_audit_error = ?
      WHERE repo = ?
        AND pr_number = ?`
  ).run(
    JSON.stringify(entry),
    String(err?.message || err || 'unknown audit write failure'),
    repo,
    prNumber
  );
  return true;
}

async function writeFastMergeAudit({
  db = null,
  rootDir,
  auditWriter,
  logger = console,
  entry,
} = {}) {
  try {
    if (typeof auditWriter === 'function') {
      await auditWriter(entry);
      return true;
    }
    writeFastMergeCloseAuditEntry(rootDir, entry);
    return true;
  } catch (err) {
    logger?.error?.(
      `[follow-up-merge-agent] fast-merge audit write failed for ${entry?.repo}#${entry?.pr_number}: ${err?.message || err}`
    );
    recordFastMergeCloseAuditPending(db, {
      repo: entry?.repo,
      prNumber: entry?.pr_number,
      entry,
      err,
    });
    return false;
  }
}

function attemptHasHamAuthorizationMarker(attempt) {
  if (!attempt || typeof attempt !== 'object') return false;
  if (attempt.headMatchEvidence === 'ham_terminal_remediation_validated') return true;
  if (attempt.eligibilityReason === 'ham_terminal_remediation_validated') return true;
  const markerFields = [
    attempt?.trace?.hamTerminalRemediation?.marker,
    attempt?.trace?.hamTerminalRemediation?.evidence,
    attempt?.hamTerminalRemediation?.marker,
    attempt?.hamTerminalRemediation?.evidence,
  ];
  return markerFields.includes('ham_terminal_remediation_validated');
}

function resolveUserUid(user) {
  const normalized = String(user || '').trim();
  if (!normalized) return { ok: false, reason: 'ham-audit-owner-unknown' };
  const result = spawnSync('id', ['-u', normalized], { encoding: 'utf8' });
  if (result.status !== 0) {
    return {
      ok: false,
      reason: 'ham-audit-owner-uid-unresolved',
      detail: String(result.stderr || result.error?.message || '').trim(),
    };
  }
  const uid = Number.parseInt(String(result.stdout || '').trim(), 10);
  if (!Number.isInteger(uid) || uid < 0) {
    return { ok: false, reason: 'ham-audit-owner-uid-unresolved' };
  }
  return { ok: true, uid };
}

function verifyFastMergeHamAuditFileTrust({
  hqRoot,
  repo,
  prNumber,
  liveHead,
}) {
  let filePath;
  try {
    filePath = amaAuditFilePath(hqRoot, repo, prNumber, liveHead);
  } catch (err) {
    return { ok: false, reason: 'ham-audit-path-invalid', detail: err?.message || String(err) };
  }
  let stat;
  try {
    stat = statSync(filePath);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { ok: false, reason: 'ham-audit-record-missing', filePath };
    }
    return { ok: false, reason: 'ham-audit-stat-failed', filePath, detail: err?.message || String(err) };
  }
  const ownerResolution = resolveHqOwner(hqRoot);
  if (!ownerResolution?.ownerUser) {
    return {
      ok: false,
      reason: ownerResolution?.reason || 'ham-audit-owner-unknown',
      filePath,
      detail: ownerResolution?.detail || null,
    };
  }
  const uidResolution = resolveUserUid(ownerResolution.ownerUser);
  if (!uidResolution.ok) {
    return {
      ok: false,
      reason: uidResolution.reason,
      filePath,
      ownerUser: ownerResolution.ownerUser,
      detail: uidResolution.detail || null,
    };
  }
  const mode = stat.mode & 0o777;
  const checks = {
    regularFile: stat.isFile(),
    owner: stat.uid === uidResolution.uid,
    notWorldWritable: (mode & 0o002) === 0,
  };
  const ok = Object.values(checks).every(Boolean);
  return {
    ok,
    reason: ok ? 'ham-audit-file-trusted' : 'ham-audit-file-untrusted',
    filePath,
    checks,
    ownerUser: ownerResolution.ownerUser,
    expectedUid: uidResolution.uid,
    actualUid: stat.uid,
    mode: mode.toString(8).padStart(3, '0'),
  };
}

function verifyFastMergeHamCloserLease({
  rootDir,
  repo,
  prNumber,
  liveHead,
  auditStatus,
}) {
  if (auditStatus === 'succeeded') {
    return { ok: true, reason: 'ham-audit-succeeded' };
  }
  if (auditStatus !== 'in_progress') {
    return { ok: false, reason: 'ham-audit-status-not-authorizing' };
  }
  try {
    const lease = readAmaCloserLease(rootDir, { repo, prNumber, headSha: liveHead });
    const checks = {
      exists: Boolean(lease),
      repo: lease?.repo === repo,
      prNumber: Number(lease?.prNumber) === Number(prNumber),
      headSha: String(lease?.headSha || '').trim() === liveHead,
      status: lease?.status === AMA_CLOSER_LEASE_STATUS.DISPATCHED,
      lrqId: String(lease?.lrqId || '').trim() !== '',
    };
    const ok = Object.values(checks).every(Boolean);
    return {
      ok,
      reason: ok ? 'ham-closer-lease-active' : 'ham-closer-lease-invalid',
      checks,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'ham-closer-lease-read-failed',
      detail: err?.message || String(err),
    };
  }
}

function verifyFastMergeHamAuditRecord({
  rootDir,
  hqRoot,
  repo,
  prNumber,
  reviewedHead,
  liveHead,
}) {
  if (!hqRoot) {
    return { ok: false, reason: 'ham-audit-root-missing' };
  }
  const fileTrust = verifyFastMergeHamAuditFileTrust({ hqRoot, repo, prNumber, liveHead });
  if (!fileTrust.ok) {
    return {
      ok: false,
      reason: fileTrust.reason,
      checks: { fileTrust },
      reviewedHead,
      liveHead,
    };
  }
  const audit = readAmaAuditEntry(hqRoot, repo, prNumber, liveHead);
  const attempts = Array.isArray(audit?.attempts) ? audit.attempts : [];
  const latestAttempt = attempts.at(-1) || null;
  const auditStatus = String(audit?.status || '').trim();
  const closerLease = verifyFastMergeHamCloserLease({
    rootDir,
    repo,
    prNumber,
    liveHead,
    auditStatus,
  });
  const checks = {
    exists: Boolean(audit),
    schemaVersion: audit?.schemaVersion === 1,
    repo: audit?.repo === repo,
    prNumber: Number(audit?.prNumber) === Number(prNumber),
    headSha: String(audit?.headSha || '').trim() === liveHead,
    status: ['in_progress', 'succeeded'].includes(auditStatus),
    closerLease: closerLease.ok,
    preMergeEligible: latestAttempt?.preMergeEligible === true,
    hamMarker: attemptHasHamAuthorizationMarker(latestAttempt),
  };
  const ok = Object.values(checks).every(Boolean);
  return {
    ok,
    reason: ok ? 'ham-audit-record-authorized' : (closerLease.ok ? 'ham-audit-record-invalid' : closerLease.reason),
    checks: { ...checks, fileTrust, closerLease },
    reviewedHead,
    liveHead,
  };
}

async function verifyFastMergeHamRemediationHead({
  ghClient,
  rootDir = process.cwd(),
  repo,
  prNumber,
  authorizedHeadSha,
  currentHeadSha,
  hqRoot = resolveHqRoot(process.env),
  logger = console,
} = {}) {
  const reviewedHead = String(authorizedHeadSha || '').trim();
  const liveHead = String(currentHeadSha || '').trim();
  if (!reviewedHead || !liveHead || reviewedHead === liveHead) {
    return { authorized: false, reason: 'not-head-change' };
  }

  try {
    const verifiedCommit = await fetchFastMergeHamCommit({ ghClient, repo, headSha: liveHead });
    const trailers = verifiedCommit.trailers || {};
    const remediatedFindingCounts = parseRemediatedFindingsTrailer(trailers['remediated-findings']);
    const commitChecks = {
      workerClass: trailers['worker-class'] === 'hammer',
      ticket: /^(HAM|AMA-PR-\d+)$/i.test(String(trailers['worker-ticket'] || '').trim()),
      reviewedHead: String(trailers['reviewed-head'] || '').trim() === reviewedHead,
      closedBy: trailers['closed-by'] === 'hammer (adversarial-pipe-mode)',
      head: verifiedCommit.sha === liveHead,
      parent: verifiedCommit.parentSha === reviewedHead,
      nonEmptyCommit: Array.isArray(verifiedCommit.changedFiles) && verifiedCommit.changedFiles.length > 0,
      remediatedFindings: remediatedFindingCounts !== null,
    };
    if (!Object.values(commitChecks).every(Boolean)) {
      return { authorized: false, reason: 'ham-commit-provenance-invalid', checks: commitChecks };
    }

    const timeline = await fetchFastMergeTimeline({ ghClient, repo, prNumber });
    if (!hasMatchingHamAuditComment(timeline, verifiedCommit)) {
      return { authorized: false, reason: 'ham-audit-comment-missing' };
    }

    const auditRecord = verifyFastMergeHamAuditRecord({
      rootDir,
      hqRoot,
      repo,
      prNumber,
      reviewedHead,
      liveHead,
    });
    if (!auditRecord.ok) {
      return {
        authorized: false,
        reason: auditRecord.reason,
        checks: {
          ...commitChecks,
          auditRecord: auditRecord.checks,
        },
      };
    }

    return {
      authorized: true,
      reason: 'ham-remediation-head-authorized',
      authorizedHeadSha: liveHead,
      reviewedHeadSha: reviewedHead,
      remediatedFindingCounts,
      auditRecord: auditRecord.checks,
    };
  } catch (err) {
    logger?.warn?.(
      `[follow-up-merge-agent] HAM remediation head verification failed for ${repo}#${prNumber}: ${err?.message || err}`
    );
    return { authorized: false, reason: 'ham-provenance-lookup-failed' };
  }
}

function normalizePrView(parsed = {}) {
  const labels = Array.isArray(parsed.labels) ? parsed.labels : [];
  const state = String(parsed.state || '').trim().toUpperCase();
  return {
    state,
    isDraft: Boolean(parsed.isDraft),
    mergedAt: parsed.mergedAt || null,
    closedAt: parsed.closedAt || null,
    headRefOid: parsed.headRefOid || null,
    labels,
  };
}

async function fetchFastMergePrView({ ghClient, repo, prNumber }) {
  const execFileImpl = execFileFromGhClient(ghClient);
  const { stdout } = await withGhRetry(() => execFileImpl('gh', [
    'pr',
    'view',
    String(prNumber),
    '--repo',
    repo,
    '--json',
    'state,isDraft,mergedAt,closedAt,headRefOid,labels',
  ], {
    maxBuffer: 5 * 1024 * 1024,
    timeout: FAST_MERGE_GH_TIMEOUT_MS,
  }));
  return normalizePrView(parseGhJson(stdout));
}

async function fetchFastMergeMergeCommit({ ghClient, repo, prNumber }) {
  const execFileImpl = execFileFromGhClient(ghClient);
  const { stdout } = await withGhRetry(() => execFileImpl('gh', [
    'pr',
    'view',
    String(prNumber),
    '--repo',
    repo,
    '--json',
    'mergeCommit',
  ], {
    maxBuffer: 5 * 1024 * 1024,
    timeout: FAST_MERGE_GH_TIMEOUT_MS,
  }));
  const parsed = parseGhJson(stdout, {});
  const oid = parsed?.mergeCommit?.oid;
  return oid ? String(oid) : null;
}

async function fetchFastMergeChecks({ ghClient, repo, prNumber }) {
  const execFileImpl = execFileFromGhClient(ghClient);
  let stdout = '';
  try {
    ({ stdout } = await withGhRetry(() => execFileImpl('gh', [
      'pr',
      'checks',
      String(prNumber),
      '--repo',
      repo,
      '--json',
      'name,state,bucket,workflow,link',
    ], {
      maxBuffer: 5 * 1024 * 1024,
      timeout: FAST_MERGE_GH_TIMEOUT_MS,
    })));
  } catch (err) {
    const code = Number(err?.code);
    if ((code === 1 || code === 8) && typeof err?.stdout === 'string' && err.stdout.trim()) {
      stdout = err.stdout;
    } else if (isNoChecksReportedGhError(err)) {
      stdout = '[]';
    } else {
      throw err;
    }
  }
  const parsed = parseGhJson(stdout, []);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.checks)) return parsed.checks;
  return [];
}

function isNoChecksReportedGhError(err) {
  const detail = [err?.message, err?.stderr, err?.stdout]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return detail.includes('no checks') && detail.includes('reported');
}

async function mergeFastMergePr({ ghClient, repo, prNumber, matchHeadCommit, rootDir = process.cwd(), logger = console }) {
  const execFileImpl = execFileFromGhClient(ghClient);
  return withGhRetry(async () => {
    try {
      const adapterResult = await writeAdapterPullRequestMerge(
        repo,
        prNumber,
        {
          matchHeadCommit,
          mergeMethod: 'squash',
          deleteBranch: true,
          admin: true,
        },
        { execFileImpl, env: process.env, rootDir }
      );
      if (adapterResult?.ran === true) return adapterResult.payload;
    } catch (err) {
      logger?.warn?.(
        `[follow-up-merge-agent] fast-merge adapter merge failed for ${repo}#${prNumber}; falling back to gh --admin: ${err?.message || err}`
      );
      // Preserve the historical fast-merge contract: an enabled adapter is a
      // preferred write path, but protected-branch/admin failures must still
      // reach the existing gh --admin fallback. withGhRetry may re-run this
      // callback after transient gh failure; GitHub treats an already-merged
      // PR/head as idempotently terminal, so the fallback remains retry-safe.
    }
    return execFileImpl('gh', [
      'pr',
      'merge',
      String(prNumber),
      '--repo',
      repo,
      '--squash',
      '--admin',
      '--match-head-commit',
      String(matchHeadCommit),
      '--delete-branch',
    ], {
      maxBuffer: 5 * 1024 * 1024,
      timeout: FAST_MERGE_GH_TIMEOUT_MS,
    });
  });
}

function normalizeFastMergeLabelNames(labels) {
  return normalizeLabelNames(labels);
}

function hasFastMergeVeto(labels) {
  return normalizeFastMergeLabelNames(labels).includes(FAST_MERGE_VETO_LABEL);
}

function hasFastMergeAuthorizationLabel(labels) {
  return normalizeFastMergeLabelNames(labels)
    .some((label) => label.startsWith(FAST_MERGE_LABEL_PREFIX) && label !== FAST_MERGE_VETO_LABEL);
}

function checkIdentity(check, index) {
  return check?.name || check?.workflow || check?.link || `check-${index + 1}`;
}

function summarizeFastMergeChecks(checks) {
  const normalized = (Array.isArray(checks) ? checks : []).map((check, index) => {
    const conclusion = check?.conclusion == null
      ? null
      : String(check.conclusion).trim().toLowerCase();
    const state = check?.state == null
      ? null
      : String(check.state).trim().toLowerCase();
    const bucket = check?.bucket == null
      ? null
      : String(check.bucket).trim().toLowerCase();
    return {
      name: checkIdentity(check, index),
      conclusion,
      state,
      bucket,
    };
  });

  const failed = normalized.filter((check) => (
    FAST_MERGE_FAILURE_CONCLUSIONS.has(check.conclusion)
    || FAST_MERGE_FAILURE_CONCLUSIONS.has(check.state)
    || FAST_MERGE_FAILURE_CONCLUSIONS.has(check.bucket)
  ));
  if (failed.length > 0) {
    return {
      status: 'failed',
      totalCount: normalized.length,
      checkConclusions: normalized,
      failureMessage: `fast-merge CI failed: ${failed.map((check) => `${check.name}:${check.conclusion || check.state || check.bucket}`).join(', ')}`,
    };
  }

  const pending = normalized.filter((check) => {
    if (check.conclusion === null) {
      if (check.state == null) return true;
      if (FAST_MERGE_PENDING_STATES.has(check.state)) return true;
      if (check.bucket != null && FAST_MERGE_PENDING_STATES.has(check.bucket)) return true;
      if (!FAST_MERGE_SUCCESS_CONCLUSIONS.has(check.state) && !FAST_MERGE_SUCCESS_CONCLUSIONS.has(check.bucket)) {
        return true;
      }
    }
    if (check.conclusion != null && FAST_MERGE_PENDING_STATES.has(check.conclusion)) return true;
    if (check.state != null && FAST_MERGE_PENDING_STATES.has(check.state)) return true;
    if (check.bucket != null && FAST_MERGE_PENDING_STATES.has(check.bucket)) return true;
    return false;
  });
  if (pending.length > 0 && normalized.length > 0) {
    return {
      status: 'pending',
      totalCount: normalized.length,
      checkConclusions: normalized,
      failureMessage: null,
    };
  }

  const unexpected = normalized.filter((check) => (
    check.conclusion && !FAST_MERGE_SUCCESS_CONCLUSIONS.has(check.conclusion)
  ));
  if (unexpected.length > 0) {
    return {
      status: 'failed',
      totalCount: normalized.length,
      checkConclusions: normalized,
      failureMessage: `fast-merge CI not successful: ${unexpected.map((check) => `${check.name}:${check.conclusion}`).join(', ')}`,
    };
  }

  return {
    status: 'success',
    totalCount: normalized.length,
    checkConclusions: normalized,
    failureMessage: null,
  };
}

function updateFastMergeTerminalState(db, {
  state,
  repo,
  prNumber,
  at = isoNow(),
  failureMessage = null,
}) {
  if (state === FAST_MERGE_MERGED_STATE) {
    db.prepare(
      `UPDATE reviewed_prs
          SET pr_state = ?,
              review_status = ?,
              merged_at = COALESCE(merged_at, ?),
              failure_message = NULL
        WHERE repo = ?
          AND pr_number = ?
          AND pr_state = ?`
    ).run(state, state, at, repo, prNumber, FAST_MERGE_SKIPPED_STATE);
    return;
  }
  if (state === FAST_MERGE_CLOSED_STATE) {
    db.prepare(
      `UPDATE reviewed_prs
          SET pr_state = ?,
              review_status = ?,
              closed_at = COALESCE(closed_at, ?),
              failure_message = NULL
        WHERE repo = ?
          AND pr_number = ?
          AND pr_state = ?`
    ).run(state, state, at, repo, prNumber, FAST_MERGE_SKIPPED_STATE);
    return;
  }
  if (state === FAST_MERGE_BLOCKED_STATE) {
    db.prepare(
      `UPDATE reviewed_prs
          SET pr_state = ?,
              review_status = ?,
              failed_at = ?,
              failure_message = ?
        WHERE repo = ?
          AND pr_number = ?
          AND pr_state = ?`
    ).run(state, state, at, failureMessage || 'fast-merge blocked', repo, prNumber, FAST_MERGE_SKIPPED_STATE);
  }
}

function updateFastMergeRetryableRefusalState(db, {
  repo,
  prNumber,
  at = isoNow(),
  refusalReason,
}) {
  db.prepare(
    `UPDATE reviewed_prs
        SET failed_at = ?,
            failure_message = ?,
            pr_state = ?,
            review_status = ?
      WHERE repo = ?
        AND pr_number = ?`
  ).run(
    at,
    refusalReason || 'GitHub refused fast-merge',
    FAST_MERGE_SKIPPED_STATE,
    FAST_MERGE_SKIPPED_STATE,
    repo,
    prNumber,
  );
}

function requeueFastMergeForNormalReview(db, {
  rootDir,
  repo,
  prNumber,
  reason,
  requestedAt = isoNow(),
}) {
  return requestReviewRereview({
    rootDir,
    repo,
    prNumber,
    requestedAt,
    reason,
    allowFastMergeSkipped: true,
    db,
  });
}

async function auditAndRequeueFastMerge({
  db,
  rootDir,
  ghClient,
  repo,
  prNumber,
  authorizedHeadSha,
  currentHeadSha,
  labels = [],
  reason,
  action,
  headChanged = false,
  vetoDetected = false,
  labelRemoved = false,
  auditWriter,
  logger = console,
}) {
  const requeuedAt = isoNow();
  const requeuePath = 'retrigger_helper';
  const initialEntry = buildFastMergeCloseAuditEntry({
    action,
    repo,
    prNumber,
    authorizedHeadSha,
    currentHeadSha,
    headChanged,
    vetoDetected,
    labelRemoved,
    requeuePath,
    requeueResult: {
      triggered: false,
      status: 'attempting',
      reason,
    },
    at: requeuedAt,
  });
  await writeFastMergeAudit({ db, rootDir, auditWriter, logger, entry: initialEntry });
  const requeueResult = requeueFastMergeForNormalReview(db, {
    rootDir,
    repo,
    prNumber,
    reason,
    requestedAt: requeuedAt,
  });
  const finalEntry = {
    ...initialEntry,
    labels,
    requeue_result: {
      triggered: Boolean(requeueResult?.triggered),
      status: requeueResult?.status || null,
      reason: requeueResult?.reason || null,
    },
    requeueResult: undefined,
  };
  await writeFastMergeAudit({ db, rootDir, auditWriter, logger, entry: finalEntry });
  return {
    status: headChanged ? 'requeued_head_change' : (labelRemoved ? 'requeued_label_removed' : 'requeued_veto'),
    requeueResult,
  };
}

async function fetchAndSummarizeFastMergeChecks({ ghClient, repo, prNumber, logger = console } = {}) {
  try {
    const checks = await fetchFastMergeChecks({ ghClient, repo, prNumber });
    return { ok: true, checks, summary: summarizeFastMergeChecks(checks) };
  } catch (err) {
    logger?.warn?.(
      `[follow-up-merge-agent] fast-merge checks unavailable for ${repo}#${prNumber}; leaving skipped: ${err?.message || err}`
    );
    return { ok: false, reason: 'checks-transport-failed', err };
  }
}

async function processFastMergePR({
  db,
  ghClient = execFileAsync,
  rootDir = process.cwd(),
  repo,
  prNumber,
  authorizedHeadSha,
  auditWriter = null,
  env = process.env,
  logger = console,
} = {}) {
  let exactHeadSha = authorizedHeadSha;
  const firstView = await fetchFastMergePrView({ ghClient, repo, prNumber });
  if (firstView.state === 'MERGED' || firstView.mergedAt) {
    const at = firstView.mergedAt || isoNow();
    updateFastMergeTerminalState(db, {
      state: FAST_MERGE_MERGED_STATE,
      repo,
      prNumber,
      at,
    });
    await writeFastMergeAudit({
      db,
      rootDir,
      auditWriter,
      logger,
      entry: buildFastMergeCloseAuditEntry({
        action: 'merged',
        repo,
        prNumber,
        authorizedHeadSha,
        currentHeadSha: firstView.headRefOid,
        mergedHeadSha: firstView.headRefOid,
        manualMergeDetected: true,
        at,
      }),
    });
    return { status: 'merged', manualMergeDetected: true };
  }
  if (firstView.state === 'CLOSED') {
    const at = firstView.closedAt || isoNow();
    updateFastMergeTerminalState(db, {
      state: FAST_MERGE_CLOSED_STATE,
      repo,
      prNumber,
      at,
    });
    await writeFastMergeAudit({
      db,
      rootDir,
      auditWriter,
      logger,
      entry: buildFastMergeCloseAuditEntry({
        action: 'closed',
        repo,
        prNumber,
        authorizedHeadSha,
        currentHeadSha: firstView.headRefOid,
        closedWithoutMerge: true,
        failureReason: 'PR closed without merge',
        at,
      }),
    });
    return { status: 'closed' };
  }

  if (!exactHeadSha || String(firstView.headRefOid || '') !== String(exactHeadSha)) {
    const hamAuthorization = await verifyFastMergeHamRemediationHead({
      ghClient,
      rootDir,
      repo,
      prNumber,
      authorizedHeadSha: exactHeadSha,
      currentHeadSha: firstView.headRefOid || null,
      hqRoot: resolveHqRoot(env),
      logger,
    });
    if (hamAuthorization.authorized) {
      exactHeadSha = hamAuthorization.authorizedHeadSha;
    } else {
      const hamReason = hamAuthorization.reason || 'unknown';
      logger?.warn?.(
        `[follow-up-merge-agent] fast-merge HAM head authorization rejected for ` +
        `${repo}#${prNumber}: ${hamReason}`
      );
      return auditAndRequeueFastMerge({
        db,
        rootDir,
        ghClient,
        repo,
        prNumber,
        authorizedHeadSha: exactHeadSha,
        currentHeadSha: firstView.headRefOid || null,
        labels: firstView.labels,
        reason: `fast-merge head changed: authorized ${exactHeadSha || 'missing'}; current ${firstView.headRefOid || 'missing'}; ham-eval: ${hamReason}`,
        action: 'head-changed-requeued',
        headChanged: true,
        auditWriter,
        logger,
      });
    }
  }

  if (hasFastMergeVeto(firstView.labels)) {
    return auditAndRequeueFastMerge({
      db,
      rootDir,
      ghClient,
      repo,
      prNumber,
      authorizedHeadSha: exactHeadSha,
      currentHeadSha: firstView.headRefOid || null,
      labels: firstView.labels,
      reason: 'fast-merge veto label detected; requeueing normal first-pass review',
      action: 'veto-requeued',
      vetoDetected: true,
      auditWriter,
      logger,
    });
  }

  if (!hasFastMergeAuthorizationLabel(firstView.labels)) {
    return auditAndRequeueFastMerge({
      db,
      rootDir,
      ghClient,
      repo,
      prNumber,
      authorizedHeadSha: exactHeadSha,
      currentHeadSha: firstView.headRefOid || null,
      labels: firstView.labels,
      reason: 'fast-merge authorization label absent; requeueing normal first-pass review',
      action: 'label-removed-requeued',
      labelRemoved: true,
      auditWriter,
      logger,
    });
  }

  const initialChecks = await fetchAndSummarizeFastMergeChecks({ ghClient, repo, prNumber, logger });
  if (!initialChecks.ok) return { status: 'skipped_still_pending', reason: initialChecks.reason };
  const checkSummary = initialChecks.summary;
  if (checkSummary.status === 'failed') {
    updateFastMergeTerminalState(db, {
      state: FAST_MERGE_BLOCKED_STATE,
      repo,
      prNumber,
      failureMessage: checkSummary.failureMessage,
    });
    await writeFastMergeAudit({
      db,
      rootDir,
      auditWriter,
      logger,
      entry: buildFastMergeCloseAuditEntry({
        action: 'blocked',
        repo,
        prNumber,
        authorizedHeadSha: exactHeadSha,
        currentHeadSha: firstView.headRefOid,
        failureReason: checkSummary.failureMessage,
        checkConclusions: checkSummary.checkConclusions,
      }),
    });
    return { status: 'blocked', reason: 'ci-failed' };
  }
  if (checkSummary.status === 'pending') {
    return { status: 'skipped_still_pending', reason: 'ci-pending' };
  }

  const preMergeView = await fetchFastMergePrView({ ghClient, repo, prNumber });
  if (!exactHeadSha || String(preMergeView.headRefOid || '') !== String(exactHeadSha)) {
    return auditAndRequeueFastMerge({
      db,
      rootDir,
      ghClient,
      repo,
      prNumber,
      authorizedHeadSha: exactHeadSha,
      currentHeadSha: preMergeView.headRefOid || null,
      labels: preMergeView.labels,
      reason: `fast-merge head changed before merge: authorized ${exactHeadSha || 'missing'}; current ${preMergeView.headRefOid || 'missing'}`,
      action: 'head-changed-requeued',
      headChanged: true,
      auditWriter,
      logger,
    });
  }
  if (hasFastMergeVeto(preMergeView.labels)) {
    return auditAndRequeueFastMerge({
      db,
      rootDir,
      ghClient,
      repo,
      prNumber,
      authorizedHeadSha: exactHeadSha,
      currentHeadSha: preMergeView.headRefOid || null,
      labels: preMergeView.labels,
      reason: 'fast-merge veto label detected before merge; requeueing normal first-pass review',
      action: 'veto-requeued',
      vetoDetected: true,
      auditWriter,
      logger,
    });
  }
  if (!hasFastMergeAuthorizationLabel(preMergeView.labels)) {
    return auditAndRequeueFastMerge({
      db,
      rootDir,
      ghClient,
      repo,
      prNumber,
      authorizedHeadSha: exactHeadSha,
      currentHeadSha: preMergeView.headRefOid || null,
      labels: preMergeView.labels,
      reason: 'fast-merge authorization label absent before merge; requeueing normal first-pass review',
      action: 'label-removed-requeued',
      labelRemoved: true,
      auditWriter,
      logger,
    });
  }

  const preMergeChecks = await fetchAndSummarizeFastMergeChecks({ ghClient, repo, prNumber, logger });
  if (!preMergeChecks.ok) return { status: 'skipped_still_pending', reason: preMergeChecks.reason };
  if (preMergeChecks.summary.status === 'failed') {
    updateFastMergeTerminalState(db, {
      state: FAST_MERGE_BLOCKED_STATE,
      repo,
      prNumber,
      failureMessage: preMergeChecks.summary.failureMessage,
    });
    await writeFastMergeAudit({
      db,
      rootDir,
      auditWriter,
      logger,
      entry: buildFastMergeCloseAuditEntry({
        action: 'blocked',
        repo,
        prNumber,
        authorizedHeadSha: exactHeadSha,
        currentHeadSha: preMergeView.headRefOid,
        failureReason: preMergeChecks.summary.failureMessage,
        checkConclusions: preMergeChecks.summary.checkConclusions,
      }),
    });
    return { status: 'blocked', reason: 'ci-failed-before-merge' };
  }
  if (preMergeChecks.summary.status === 'pending') {
    return { status: 'skipped_still_pending', reason: 'ci-pending-before-merge' };
  }

  let mergeResult;
  try {
    mergeResult = await mergeFastMergePr({
      ghClient,
      repo,
      prNumber,
      matchHeadCommit: exactHeadSha,
      rootDir,
      logger,
    });
  } catch (err) {
    if (isRetryableGhTransportError(err)) {
      logger?.warn?.(
        `[follow-up-merge-agent] fast-merge transport failure exhausted for ${repo}#${prNumber}; leaving skipped: ${err?.message || err}`
      );
      return { status: 'skipped_still_pending', reason: 'merge-transport-failed' };
    }
    let postMergeView;
    try {
      postMergeView = await fetchFastMergePrView({ ghClient, repo, prNumber });
    } catch (viewErr) {
      if (isRetryableGhTransportError(viewErr)) {
        logger?.warn?.(
          `[follow-up-merge-agent] fast-merge post-merge verification unavailable for ${repo}#${prNumber}; leaving skipped: ${viewErr?.message || viewErr}`
        );
        return { status: 'skipped_still_pending', reason: 'merge-postcheck-transport-failed' };
      }
      throw viewErr;
    }
    if (postMergeView.state === 'MERGED' || postMergeView.mergedAt) {
      const mergedAt = postMergeView.mergedAt || isoNow();
      let mergeSha = null;
      try {
        mergeSha = await fetchFastMergeMergeCommit({ ghClient, repo, prNumber });
      } catch {}
      updateFastMergeTerminalState(db, {
        state: FAST_MERGE_MERGED_STATE,
        repo,
        prNumber,
        at: mergedAt,
      });
      await writeFastMergeAudit({
        db,
        rootDir,
        auditWriter,
        logger,
        entry: buildFastMergeCloseAuditEntry({
          action: 'merged',
          repo,
          prNumber,
          authorizedHeadSha: exactHeadSha,
          currentHeadSha: postMergeView.headRefOid || preMergeView.headRefOid,
          mergedHeadSha: postMergeView.headRefOid || exactHeadSha,
          mergeSha,
          manualMergeDetected: true,
          checkConclusions: checkSummary.checkConclusions,
          mergeStderr: err?.stderr || null,
          mergeStdout: err?.stdout || null,
          at: mergedAt,
        }),
      });
      return { status: 'merged', manualMergeDetected: true };
    }
    const detail = String(err?.stderr || err?.stdout || err?.message || err).trim();
    const refusalReason = detail || 'GitHub refused fast-merge';
    updateFastMergeRetryableRefusalState(db, {
      repo,
      prNumber,
      refusalReason,
    });
    await writeFastMergeAudit({
      db,
      rootDir,
      auditWriter,
      logger,
      entry: buildFastMergeCloseAuditEntry({
        action: 'merge-refused-retryable',
        repo,
        prNumber,
        authorizedHeadSha: exactHeadSha,
        currentHeadSha: preMergeView.headRefOid,
        failureReason: 'github_refused_merge',
        refusalReason,
        checkConclusions: checkSummary.checkConclusions,
        mergeStderr: err?.stderr || null,
        mergeStdout: err?.stdout || null,
      }),
    });
    logger?.error?.(JSON.stringify({
      event: 'ama_daemon.merge_refused',
      repo,
      prNumber,
      authorizedHeadSha: exactHeadSha,
      currentHeadSha: preMergeView.headRefOid,
      refusalReason,
    }));
    return { status: 'skipped_still_pending', reason: 'merge-refused', refusalReason };
  }

  const mergedAt = isoNow();
  let mergeSha = null;
  try {
    mergeSha = await fetchFastMergeMergeCommit({ ghClient, repo, prNumber });
  } catch {}
  updateFastMergeTerminalState(db, {
    state: FAST_MERGE_MERGED_STATE,
    repo,
    prNumber,
    at: mergedAt,
  });
  await writeFastMergeAudit({
    db,
    rootDir,
    auditWriter,
    logger,
    entry: buildFastMergeCloseAuditEntry({
      action: 'merged',
      repo,
      prNumber,
      authorizedHeadSha: exactHeadSha,
      currentHeadSha: preMergeView.headRefOid,
      mergedHeadSha: exactHeadSha,
      mergeSha,
      checkConclusions: checkSummary.checkConclusions,
      mergeStdout: mergeResult?.stdout || null,
      mergeStderr: mergeResult?.stderr || null,
      at: mergedAt,
    }),
  });
  return { status: 'merged' };
}

async function pollFastMergeQueue({
  db,
  ghClient = execFileAsync,
  rootDir = process.cwd(),
  perPollCap = resolveFastMergePerPollCap(),
  repos = null,
  auditWriter = null,
  logger = console,
  env = process.env,
} = {}) {
  const cap = Number.isInteger(perPollCap) && perPollCap > 0
    ? perPollCap
    : DEFAULT_FML_MERGE_AGENT_PER_POLL_CAP;
  const repoSet = Array.isArray(repos) && repos.length > 0
    ? new Set(repos.map((repo) => String(repo)))
    : null;
  const repoFilter = repoSet ? [...repoSet] : [];
  const repoPredicate = repoFilter.length > 0
    ? ` AND repo IN (${repoFilter.map(() => '?').join(', ')})`
    : '';
  const rows = db.prepare(
    `SELECT id AS pass_id, repo, pr_number, fast_merge_authorized_head_sha
      FROM reviewed_prs
      WHERE pr_state = ?${repoPredicate}
      ORDER BY reviewed_at ASC, id ASC
      LIMIT ?`
  ).all(FAST_MERGE_SKIPPED_STATE, ...repoFilter, cap * 5);
  const summary = {
    processed: 0,
    merged: 0,
    blocked: 0,
    requeued_head_change: 0,
    requeued_veto: 0,
    requeued_label_removed: 0,
    skipped_still_pending: 0,
  };
  let terminalProgress = 0;
  for (const row of rows) {
    summary.processed += 1;
    try {
      const result = await processFastMergePR({
        db,
        ghClient,
        rootDir,
        repo: row.repo,
        prNumber: row.pr_number,
        authorizedHeadSha: row.fast_merge_authorized_head_sha,
        auditWriter,
        logger,
        env,
      });
      if (result?.status === 'merged') summary.merged += 1;
      else if (result?.status === 'blocked') summary.blocked += 1;
      else if (result?.status === 'requeued_head_change') summary.requeued_head_change += 1;
      else if (result?.status === 'requeued_veto') summary.requeued_veto += 1;
      else if (result?.status === 'requeued_label_removed') summary.requeued_label_removed += 1;
      else if (result?.status === 'skipped_still_pending') summary.skipped_still_pending += 1;
      if (result?.status && result.status !== 'skipped_still_pending') {
        terminalProgress += 1;
      }
    } catch (err) {
      logger?.error?.(
        `[follow-up-merge-agent] fast-merge processing failed for ${row.repo}#${row.pr_number}: ${err?.message || err}`
      );
      summary.skipped_still_pending += 1;
    }
    if (terminalProgress >= cap) break;
  }
  return summary;
}

export {
  FML_MERGE_AGENT_PER_POLL_CAP_ENV,
  resolveFastMergePerPollCap,
  buildFastMergeCloseAuditEntry,
  writeFastMergeCloseAuditEntry,
  summarizeFastMergeChecks,
  processFastMergePR,
  pollFastMergeQueue,
};

import { REMEDIATION_COMMENT_MARKER_PREFIX } from './adapters/comms/github-pr-comments/pr-comments.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from './review-state.mjs';
import {
  composeMergeCloseoutFromComments,
  fetchIssueComments,
  shouldConfirmEmptyCloseout,
} from './closeout-scraper.mjs';
import {
  GH_LOOKUP_TIMEOUT_MS,
  execGhWithRetry,
  parseDate,
  parseJsonLines,
} from './gh-cli.mjs';

const REVIEWER_LOGIN_BY_CLASS = new Map([
  ['claude', 'claude-reviewer-lacey'],
  ['claude-code', 'lacey-gemini-reviewer'],
  ['clio-agent', 'lacey-gemini-reviewer'],
  ['codex', 'lacey-gemini-reviewer'],
  ['gemini', 'lacey-gemini-reviewer'],
  ['pi', 'lacey-gemini-reviewer'],
  // opencode defaults to Anthropic Claude; keep the reviewer cross-model.
  ['opencode', 'lacey-gemini-reviewer'],
  ['hermes', 'lacey-gemini-reviewer'],
]);
const REVIEWER_LOGIN_BY_MODEL = new Map([
  ['claude', 'claude-reviewer-lacey'],
  ['codex', 'codex-reviewer-lacey'],
  ['gemini', 'lacey-gemini-reviewer'],
]);
const BODY_CAPTURE_GRACE_MS = 5 * 60 * 1000;
const REMEDIATION_MARKER_REQUIRED_FROM = '2026-05-04T00:00:00.000Z';
// The migration's verdict CHECK constraint and BEFORE UPDATE trigger
// (20260529_reviewer_passes_body_capture_and_closeouts.sql) accept exactly
// these values. Kept local because GitHub review-state mapping is a
// backfill concern; the kernel's normalizeReviewVerdict interprets review
// *bodies* and intentionally has no 'dismissed' kind.
const REVIEWER_PASS_VERDICT_ALLOWLIST = new Set([
  'approved',
  'comment-only',
  'request-changes',
  'dismissed',
]);

function closeOwnedReviewDb(db) {
  db?.close();
}

function reviewerLoginForClass(value, row = null) {
  const reviewerModel = String(row?.reviewer_model || '').trim().toLowerCase();
  if (REVIEWER_LOGIN_BY_MODEL.has(reviewerModel)) {
    return REVIEWER_LOGIN_BY_MODEL.get(reviewerModel);
  }
  const normalized = String(value || '').trim().toLowerCase();
  return REVIEWER_LOGIN_BY_CLASS.get(normalized) || null;
}

// Map a GitHub review-state literal directly to the migration's
// allowlisted verdict tokens. GitHub auto-applies `DISMISSED` to existing
// reviewer-bot reviews whenever a new commit lands on a branch with
// "Dismiss stale pull request approvals when new commits are pushed"
// enabled, so the DB must carry `'dismissed'` rather than falling through
// to a kernel-level `'unknown'` that the CHECK constraint then rejects.
const GH_REVIEW_STATE_TO_VERDICT = new Map([
  ['approved', 'approved'],
  ['commented', 'comment-only'],
  ['changes_requested', 'request-changes'],
  ['dismissed', 'dismissed'],
]);

function ghReviewStateToVerdict(state) {
  const normalized = String(state || '').trim().toLowerCase();
  return GH_REVIEW_STATE_TO_VERDICT.get(normalized) ?? null;
}

function normalizeReviewArtifact(raw = {}) {
  return {
    nodeId: raw.node_id ?? raw.nodeId ?? null,
    submittedAt: raw.submitted_at ?? raw.submittedAt ?? null,
    state: raw.state ?? null,
    body: String(raw.body ?? ''),
    authorLogin: raw?.user?.login ?? raw.authorLogin ?? null,
  };
}

async function fetchPullReviews({
  repo,
  prNumber,
  execFileImpl,
  env = process.env,
  timeoutMs = GH_LOOKUP_TIMEOUT_MS,
  retries,
} = {}) {
  const { stdout } = await execGhWithRetry({
    execFileImpl,
    env,
    timeoutMs,
    retries,
    args: [
      'api',
      '--paginate',
      `repos/${repo}/pulls/${encodeURIComponent(prNumber)}/reviews`,
      '-q',
      '.[] | {node_id: .node_id, submitted_at: .submitted_at, state: .state, body: .body, user: {login: .user.login}}',
    ],
  });
  return parseJsonLines(stdout).map(normalizeReviewArtifact);
}

function parsePassMode(value) {
  const normalized = String(value || 'all').trim().toLowerCase();
  if (normalized === 'all' || normalized === 'bodies' || normalized === 'closeouts') return normalized;
  throw new Error(`invalid --pass value: ${value}`);
}

function parseLimit(value) {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid --limit value: ${value} (must be a positive integer)`);
  }
  return parsed;
}

function parseSince(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`invalid --since value: ${value}`);
  }
  return parsed.toISOString();
}

function formatPercent(numerator, denominator) {
  if (!denominator) return '0.0%';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function formatSummary(summary, { apply = false } = {}) {
  const bodyReasonLines = Object.entries(summary.reviewerPasses.unmatchedByReason)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `    ${reason}: ${String(count).padStart(6)}`);
  const closeouts = summary.closeouts;
  const advanced = closeouts.bodyCaptured + closeouts.emptyConfirmed;
  return [
    `backfill-review-bodies — ${apply ? 'apply' : 'dry-run'} complete`,
    '=======================================',
    'reviewer_passes:',
    `  candidates considered: ${String(summary.reviewerPasses.considered).padStart(8)}`,
    `  bodies populated:      ${String(summary.reviewerPasses.populated).padStart(8)}  (${formatPercent(summary.reviewerPasses.populated, summary.reviewerPasses.considered)})`,
    `  unmatched:            ${String(summary.reviewerPasses.unmatched).padStart(8)}`,
    ...bodyReasonLines,
    '',
    'pr_merge_closeouts:',
    `  merged PRs scanned:   ${String(closeouts.scanned).padStart(8)}`,
    `  closeout rows advanced:${String(advanced).padStart(8)}  (${formatPercent(advanced, closeouts.scanned)})`,
    `    body captured:       ${String(closeouts.bodyCaptured).padStart(6)}`,
    `    empty confirmed:     ${String(closeouts.emptyConfirmed).padStart(6)}`,
    `    empty retryable:     ${String(closeouts.emptyRetryable).padStart(6)}`,
    `  unmatched (gh fetch error):${String(closeouts.fetchErrors).padStart(4)}`,
  ].join('\n');
}

function logLine(log, line) {
  if (typeof log === 'function') {
    log(line);
    return;
  }
  log?.info?.(line);
}

function buildReviewerPassQuery({ repo = null, since = null, limit = null } = {}) {
  const where = [
    'body_md IS NULL',
    `(
      (pass_kind IN ('first-pass', 'rereview') AND status = 'completed')
      OR (pass_kind = 'remediation' AND status IN ('completed', 'stopped', 'failed'))
    )`,
  ];
  const params = {};
  if (repo) {
    where.push('repo = @repo');
    params.repo = repo;
  }
  if (since) {
    where.push('started_at >= @since');
    params.since = since;
  }
  const limitClause = Number.isInteger(limit) ? ` LIMIT ${limit}` : '';
  return {
    sql: `SELECT pass_id, repo, pr_number, attempt_number, pass_kind, started_at, ended_at, status, reviewer_class, reviewer_model
            FROM reviewer_passes
           WHERE ${where.join(' AND ')}
           ORDER BY repo, pr_number, attempt_number, pass_kind${limitClause}`,
    params,
  };
}

function buildCloseoutQuery({ repo = null, since = null, limit = null } = {}) {
  const where = [
    `reviewed_prs.pr_state = 'merged'`,
    `(
      NOT EXISTS (
        SELECT 1
          FROM pr_merge_closeouts c
         WHERE c.repo = reviewed_prs.repo
           AND c.pr_number = reviewed_prs.pr_number
      )
      OR EXISTS (
        SELECT 1
          FROM pr_merge_closeouts c
         WHERE c.repo = reviewed_prs.repo
           AND c.pr_number = reviewed_prs.pr_number
           AND c.closeout_body_md IS NULL
           AND c.empty_confirmed_at IS NULL
      )
    )`,
  ];
  const params = {};
  if (repo) {
    where.push('reviewed_prs.repo = @repo');
    params.repo = repo;
  }
  if (since) {
    where.push('reviewed_prs.merged_at >= @since');
    params.since = since;
  }
  const limitClause = Number.isInteger(limit) ? ` LIMIT ${limit}` : '';
  return {
    sql: `SELECT reviewed_prs.repo, reviewed_prs.pr_number, reviewed_prs.merged_at
            FROM reviewed_prs
           WHERE ${where.join(' AND ')}
           ORDER BY reviewed_prs.repo, reviewed_prs.pr_number${limitClause}`,
    params,
  };
}

function groupPassRows(rows) {
  const groups = [];
  let current = null;
  for (const row of rows) {
    const key = `${row.repo}#${row.pr_number}`;
    if (!current || current.key !== key) {
      current = { key, repo: row.repo, prNumber: row.pr_number, rows: [] };
      groups.push(current);
    }
    current.rows.push(row);
  }
  return groups;
}

function matchArtifactWithinWindow({ artifacts, login, startedAt, endedAt, timeField }) {
  const start = parseDate(startedAt);
  const end = parseDate(endedAt) || start;
  if (!start || !end) return { matches: [], windowArtifacts: [] };
  const windowEnd = new Date(end.getTime() + BODY_CAPTURE_GRACE_MS);
  const windowArtifacts = artifacts.filter((artifact) => {
    const artifactTime = parseDate(artifact?.[timeField]);
    return artifactTime && artifactTime >= start && artifactTime <= windowEnd;
  });
  return {
    windowArtifacts,
    matches: windowArtifacts.filter((artifact) => artifact.authorLogin === login),
  };
}

function remediationRowAllowsLegacyFallback(row) {
  const startedAt = parseDate(row.started_at);
  const markerRequiredFrom = parseDate(REMEDIATION_MARKER_REQUIRED_FROM);
  if (!startedAt || !markerRequiredFrom) return false;
  return startedAt.getTime() < markerRequiredFrom.getTime();
}

function matchReviewerPassArtifact(row, { reviews, comments }) {
  const login = reviewerLoginForClass(row.reviewer_class, row);
  if (!login) return { matched: null, reason: 'login_mismatch' };

  if (row.pass_kind === 'first-pass' || row.pass_kind === 'rereview') {
    const { windowArtifacts, matches } = matchArtifactWithinWindow({
      artifacts: reviews,
      login,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      timeField: 'submittedAt',
    });
    if (matches.length === 1) return { matched: matches[0], reason: null };
    if (matches.length > 1) return { matched: null, reason: 'multiple_candidates' };
    if (windowArtifacts.length > 0) return { matched: null, reason: 'login_mismatch' };
    return { matched: null, reason: 'no_artifact_in_window' };
  }

  const { windowArtifacts, matches } = matchArtifactWithinWindow({
    artifacts: comments,
    login,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    timeField: 'createdAt',
  });
  if (matches.length === 0) {
    if (windowArtifacts.length > 0) return { matched: null, reason: 'login_mismatch' };
    return { matched: null, reason: 'no_artifact_in_window' };
  }

  const markerMatches = matches.filter((comment) => comment.body.includes(REMEDIATION_COMMENT_MARKER_PREFIX));
  if (markerMatches.length === 1) return { matched: markerMatches[0], reason: null };
  if (markerMatches.length > 1) return { matched: null, reason: 'multiple_candidates' };
  if (!remediationRowAllowsLegacyFallback(row)) return { matched: null, reason: 'marker_missing' };
  if (matches.length === 1) return { matched: matches[0], reason: 'legacy_login_window', legacyFallback: true };
  return { matched: null, reason: 'multiple_candidates' };
}

function buildCloseoutUpsertStatements(db) {
  return {
    upsertCloseout: db.prepare(
      `INSERT INTO pr_merge_closeouts (
         repo, pr_number, closeout_body_md, closeout_authors_json, closeout_posted_at, body_captured_at,
         scrape_last_checked_at, empty_confirmed_at, merged_at, gh_artifact_refs
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo, pr_number) DO UPDATE SET
         closeout_body_md = excluded.closeout_body_md,
         closeout_authors_json = excluded.closeout_authors_json,
         closeout_posted_at = excluded.closeout_posted_at,
         body_captured_at = excluded.body_captured_at,
         scrape_last_checked_at = excluded.scrape_last_checked_at,
         empty_confirmed_at = excluded.empty_confirmed_at,
         merged_at = excluded.merged_at,
         gh_artifact_refs = excluded.gh_artifact_refs`
    ),
    upsertEmptyCloseout: db.prepare(
      `INSERT INTO pr_merge_closeouts (
         repo, pr_number, scrape_last_checked_at, empty_confirmed_at, merged_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(repo, pr_number) DO UPDATE SET
         scrape_last_checked_at = excluded.scrape_last_checked_at,
         empty_confirmed_at = CASE
           WHEN pr_merge_closeouts.closeout_body_md IS NULL THEN COALESCE(excluded.empty_confirmed_at, pr_merge_closeouts.empty_confirmed_at)
           ELSE pr_merge_closeouts.empty_confirmed_at
         END,
         merged_at = COALESCE(excluded.merged_at, pr_merge_closeouts.merged_at)`
    ),
  };
}

function runUpsertCloseout(statement, row) {
  return statement.run(
    row.repo,
    row.prNumber,
    row.closeoutBodyMd,
    row.closeoutAuthorsJson,
    row.closeoutPostedAt,
    row.bodyCapturedAt,
    row.scrapeLastCheckedAt,
    row.emptyConfirmedAt,
    row.mergedAt,
    row.ghArtifactRefsJson
  );
}

function runUpsertEmptyCloseout(statement, row) {
  return statement.run(
    row.repo,
    row.prNumber,
    row.scrapeLastCheckedAt,
    row.emptyConfirmedAt,
    row.mergedAt
  );
}

function ghErrorMessage(err) {
  if (!err) return 'unknown';
  const code = err.code ? `${err.code}: ` : '';
  return `${code}${String(err.message || err).slice(0, 500)}`;
}

async function backfillReviewerPassBodies(rootDir, {
  repo = null,
  since = null,
  limit = null,
  apply = false,
  now = () => new Date().toISOString(),
  execFileImpl,
  env = process.env,
  log = console,
} = {}) {
  const db = openReviewStateDb(rootDir);
  const summary = {
    considered: 0,
    populated: 0,
    unmatched: 0,
    unmatchedByReason: {
      no_artifact_in_window: 0,
      multiple_candidates: 0,
      login_mismatch: 0,
      marker_missing: 0,
      gh_fetch_error: 0,
      duplicate_artifact_claim: 0,
      apply_constraint_violation: 0,
      would_violate_verdict_check: 0,
    },
  };
  try {
    ensureReviewStateSchema(db);
    const { sql, params } = buildReviewerPassQuery({ repo, since, limit });
    const rows = db.prepare(sql).all(params);
    const groups = groupPassRows(rows);
    const updateStatement = db.prepare(
      `UPDATE reviewer_passes
          SET verdict = ?, body_md = ?, gh_comment_id = ?, body_captured_at = ?
        WHERE pass_id = ?`
    );
    for (const group of groups) {
      let reviews;
      let comments;
      try {
        reviews = await fetchPullReviews({
          repo: group.repo,
          prNumber: group.prNumber,
          execFileImpl,
          env,
        });
        comments = await fetchIssueComments({
          repo: group.repo,
          prNumber: group.prNumber,
          execFileImpl,
          env,
        });
      } catch (err) {
        // Mirror the closeout pass: a transient gh failure on one group
        // must not abort the entire run. Charge every row in the group as
        // unmatched/gh_fetch_error so the operator sees the regression and
        // we can rerun the script to pick up just those rows on retry.
        for (const row of group.rows) {
          summary.considered += 1;
          summary.unmatched += 1;
          summary.unmatchedByReason.gh_fetch_error += 1;
          logLine(
            log,
            `unmatched pass_id=${row.pass_id} repo=${row.repo} pr=${row.pr_number} attempt=${row.attempt_number} pass_kind=${row.pass_kind} reason=gh_fetch_error error=${JSON.stringify(ghErrorMessage(err))}`
          );
        }
        continue;
      }
      // Per-group dedupe: the (login, time-window+grace) match can pick the
      // same review/comment for two overlapping passes by the same reviewer.
      // The UNIQUE index on gh_comment_id would crash an --apply mid-flight
      // and leave a partial write. Fail the loser deterministically with
      // duplicate_artifact_claim instead.
      const claimedNodeIds = new Set();
      for (const row of group.rows) {
        summary.considered += 1;
        const match = matchReviewerPassArtifact(row, { reviews, comments });
        if (!match.matched) {
          summary.unmatched += 1;
          if (match.reason in summary.unmatchedByReason) summary.unmatchedByReason[match.reason] += 1;
          logLine(
            log,
            `unmatched pass_id=${row.pass_id} repo=${row.repo} pr=${row.pr_number} attempt=${row.attempt_number} pass_kind=${row.pass_kind} reason=${match.reason}`
          );
          continue;
        }

        const nodeId = match.matched.nodeId || null;
        if (nodeId && claimedNodeIds.has(nodeId)) {
          summary.unmatched += 1;
          summary.unmatchedByReason.duplicate_artifact_claim += 1;
          logLine(
            log,
            `unmatched pass_id=${row.pass_id} repo=${row.repo} pr=${row.pr_number} attempt=${row.attempt_number} pass_kind=${row.pass_kind} reason=duplicate_artifact_claim gh_comment_id=${nodeId}`
          );
          continue;
        }

        const verdict = row.pass_kind === 'remediation'
          ? null
          : ghReviewStateToVerdict(match.matched.state);
        // Predict the apply-time verdict CHECK so dry-run is a faithful
        // gate. Without this, a verdict the migration would reject (e.g.
        // an unrecognized future GH state) would silently inflate the
        // "populated" count in dry-run and only surface as an
        // apply_constraint_violation at apply time.
        if (
          row.pass_kind !== 'remediation'
          && verdict !== null
          && !REVIEWER_PASS_VERDICT_ALLOWLIST.has(verdict)
        ) {
          summary.unmatched += 1;
          summary.unmatchedByReason.would_violate_verdict_check += 1;
          logLine(
            log,
            `unmatched pass_id=${row.pass_id} repo=${row.repo} pr=${row.pr_number} attempt=${row.attempt_number} pass_kind=${row.pass_kind} reason=would_violate_verdict_check verdict=${JSON.stringify(verdict)} gh_state=${JSON.stringify(match.matched.state ?? null)}`
          );
          continue;
        }
        const capturedAt = now();
        logLine(
          log,
          `matched pass_id=${row.pass_id} repo=${row.repo} pr=${row.pr_number} attempt=${row.attempt_number} pass_kind=${row.pass_kind} gh_comment_id=${nodeId || 'null'} dry_run=${apply ? 'false' : 'true'}${match.reason ? ` reason=${match.reason}` : ''}`
        );
        if (!apply) {
          summary.populated += 1;
          if (nodeId) claimedNodeIds.add(nodeId);
          continue;
        }
        try {
          updateStatement.run(
            verdict,
            match.matched.body,
            nodeId,
            capturedAt,
            row.pass_id
          );
          summary.populated += 1;
          if (nodeId) claimedNodeIds.add(nodeId);
        } catch (err) {
          // Last-ditch safety: per-group dedupe should already block the
          // SQLITE_CONSTRAINT_UNIQUE path, but another worker (or a row
          // populated since the SELECT) can still race the index. The
          // CHECK / trigger on verdict can also fire if GH ever ships a
          // review state we don't map here — include the attempted verdict
          // so the next surprise is diagnosable in one read.
          summary.unmatched += 1;
          summary.unmatchedByReason.apply_constraint_violation += 1;
          logLine(
            log,
            `unmatched pass_id=${row.pass_id} repo=${row.repo} pr=${row.pr_number} attempt=${row.attempt_number} pass_kind=${row.pass_kind} reason=apply_constraint_violation gh_comment_id=${nodeId || 'null'} verdict=${JSON.stringify(verdict)} gh_state=${JSON.stringify(match.matched.state ?? null)} error=${JSON.stringify(ghErrorMessage(err))}`
          );
        }
      }
    }
    return summary;
  } finally {
    closeOwnedReviewDb(db);
  }
}

async function backfillMergeCloseouts(rootDir, {
  repo = null,
  since = null,
  limit = null,
  apply = false,
  now = () => new Date().toISOString(),
  execFileImpl,
  env = process.env,
  log = console,
} = {}) {
  const db = openReviewStateDb(rootDir);
  const summary = {
    scanned: 0,
    bodyCaptured: 0,
    emptyConfirmed: 0,
    emptyRetryable: 0,
    fetchErrors: 0,
  };
  try {
    ensureReviewStateSchema(db);
    const { upsertCloseout, upsertEmptyCloseout } = buildCloseoutUpsertStatements(db);
    const { sql, params } = buildCloseoutQuery({ repo, since, limit });
    const rows = db.prepare(sql).all(params);
    for (const row of rows) {
      summary.scanned += 1;
      let comments;
      try {
        comments = await fetchIssueComments({
          repo: row.repo,
          prNumber: row.pr_number,
          execFileImpl,
          env,
        });
      } catch (err) {
        summary.fetchErrors += 1;
        logLine(
          log,
          `closeout repo=${row.repo} pr=${row.pr_number} outcome=gh_fetch_error error=${JSON.stringify(ghErrorMessage(err))}`
        );
        continue;
      }

      const observedAt = now();
      const closeout = composeMergeCloseoutFromComments({ comments });
      if (closeout.closeoutBodyMd) {
        summary.bodyCaptured += 1;
        logLine(
          log,
          `closeout repo=${row.repo} pr=${row.pr_number} outcome=body_captured dry_run=${apply ? 'false' : 'true'}`
        );
        if (!apply) continue;
        runUpsertCloseout(upsertCloseout, {
          repo: row.repo,
          prNumber: row.pr_number,
          closeoutBodyMd: closeout.closeoutBodyMd,
          closeoutAuthorsJson: JSON.stringify(closeout.closeoutAuthors),
          closeoutPostedAt: closeout.closeoutPostedAt,
          bodyCapturedAt: observedAt,
          scrapeLastCheckedAt: observedAt,
          emptyConfirmedAt: null,
          mergedAt: row.merged_at,
          ghArtifactRefsJson: JSON.stringify(closeout.ghArtifactRefs),
        });
        continue;
      }

      const emptyConfirmedAt = shouldConfirmEmptyCloseout({
        mergedAt: row.merged_at,
        observedAt,
      }) ? observedAt : null;
      if (emptyConfirmedAt) summary.emptyConfirmed += 1;
      else summary.emptyRetryable += 1;
      logLine(
        log,
        `closeout repo=${row.repo} pr=${row.pr_number} outcome=${emptyConfirmedAt ? 'empty_confirmed' : 'empty_retryable'} dry_run=${apply ? 'false' : 'true'}`
      );
      if (!apply) continue;
      runUpsertEmptyCloseout(upsertEmptyCloseout, {
        repo: row.repo,
        prNumber: row.pr_number,
        scrapeLastCheckedAt: observedAt,
        emptyConfirmedAt,
        mergedAt: row.merged_at,
      });
    }
    return summary;
  } finally {
    closeOwnedReviewDb(db);
  }
}

async function backfillReviewBodies(rootDir, {
  repo = null,
  since = null,
  limit = null,
  pass = 'all',
  apply = false,
  now = () => new Date().toISOString(),
  execFileImpl,
  env = process.env,
  log = console,
} = {}) {
  const mode = parsePassMode(pass);
  const normalizedSince = parseSince(since);
  const normalizedLimit = parseLimit(limit);
  const summary = {
    reviewerPasses: {
      considered: 0,
      populated: 0,
      unmatched: 0,
      unmatchedByReason: {
        no_artifact_in_window: 0,
        multiple_candidates: 0,
        login_mismatch: 0,
        marker_missing: 0,
        gh_fetch_error: 0,
        duplicate_artifact_claim: 0,
        apply_constraint_violation: 0,
        would_violate_verdict_check: 0,
      },
    },
    closeouts: {
      scanned: 0,
      bodyCaptured: 0,
      emptyConfirmed: 0,
      emptyRetryable: 0,
      fetchErrors: 0,
    },
  };

  if (mode === 'all' || mode === 'bodies') {
    summary.reviewerPasses = await backfillReviewerPassBodies(rootDir, {
      repo,
      since: normalizedSince,
      limit: normalizedLimit,
      apply,
      now,
      execFileImpl,
      env,
      log,
    });
  }
  if (mode === 'all' || mode === 'closeouts') {
    summary.closeouts = await backfillMergeCloseouts(rootDir, {
      repo,
      since: normalizedSince,
      limit: normalizedLimit,
      apply,
      now,
      execFileImpl,
      env,
      log,
    });
  }
  return summary;
}

export {
  GH_LOOKUP_TIMEOUT_MS,
  REMEDIATION_MARKER_REQUIRED_FROM,
  backfillMergeCloseouts,
  backfillReviewerPassBodies,
  backfillReviewBodies,
  buildCloseoutQuery,
  buildReviewerPassQuery,
  formatSummary,
  matchReviewerPassArtifact,
  parseLimit,
  parsePassMode,
  parseSince,
};

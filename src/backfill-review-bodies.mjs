import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { normalizeReviewVerdict } from './kernel/verdict.mjs';
import { REMEDIATION_COMMENT_MARKER_PREFIX } from './adapters/comms/github-pr-comments/pr-comments.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from './review-state.mjs';
import {
  composeMergeCloseoutFromComments,
  fetchIssueComments,
  shouldConfirmEmptyCloseout,
} from './closeout-scraper.mjs';

const execFileAsync = promisify(execFile);

const REVIEWER_LOGIN_BY_CLASS = new Map([
  ['claude', 'claude-reviewer-lacey'],
  ['claude-code', 'claude-reviewer-lacey'],
  ['codex', 'codex-reviewer-lacey'],
]);
const BODY_CAPTURE_GRACE_MS = 5 * 60 * 1000;
const REMEDIATION_MARKER_REQUIRED_FROM = '2026-05-04T00:00:00.000Z';
const GH_LOOKUP_TIMEOUT_MS = 30_000;

function closeOwnedReviewDb(db) {
  if (db?.name === ':memory:') return;
  db?.close();
}

function parseDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildAllowlistedGhEnv(env = process.env) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || null;
  const allowlisted = {
    PATH: env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    HOME: env.HOME ?? '',
  };
  if (token) allowlisted.GH_TOKEN = token;
  return allowlisted;
}

function parseJsonLines(stdout) {
  return String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function reviewerLoginForClass(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return REVIEWER_LOGIN_BY_CLASS.get(normalized) || null;
}

function ghReviewStateToVerdictInput(state) {
  const normalized = String(state || '').trim().toLowerCase();
  if (normalized === 'approved') return 'approved';
  if (normalized === 'commented') return 'comment only';
  if (normalized === 'changes_requested') return 'request changes';
  if (normalized === 'dismissed') return 'dismissed';
  return normalized;
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
  execFileImpl = execFileAsync,
  env = process.env,
  timeoutMs = GH_LOOKUP_TIMEOUT_MS,
} = {}) {
  const { stdout } = await execFileImpl(
    'gh',
    [
      'api',
      '--paginate',
      `repos/${repo}/pulls/${encodeURIComponent(prNumber)}/reviews`,
      '-q',
      '.[] | {node_id: .node_id, submitted_at: .submitted_at, state: .state, body: .body, user: {login: .user.login}}',
    ],
    {
      env: buildAllowlistedGhEnv(env),
      maxBuffer: 25 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
    }
  );
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
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`invalid --limit value: ${value}`);
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
    `  merged PRs scanned:   ${String(summary.closeouts.scanned).padStart(8)}`,
    `  closeout rows advanced:${String(summary.closeouts.advanced).padStart(8)}  (${formatPercent(summary.closeouts.advanced, summary.closeouts.scanned)})`,
    `  unmatched (gh fetch error):${String(summary.closeouts.fetchErrors).padStart(4)}`,
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
    sql: `SELECT pass_id, repo, pr_number, attempt_number, pass_kind, started_at, ended_at, status, reviewer_class
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
  const login = reviewerLoginForClass(row.reviewer_class);
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

function upsertCloseoutRow(db, row) {
  return db.prepare(
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
  ).run(
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

function upsertEmptyCloseoutRow(db, row) {
  return db.prepare(
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
  ).run(
    row.repo,
    row.prNumber,
    row.scrapeLastCheckedAt,
    row.emptyConfirmedAt,
    row.mergedAt
  );
}

async function backfillReviewerPassBodies(rootDir, {
  repo = null,
  since = null,
  limit = null,
  apply = false,
  now = () => new Date().toISOString(),
  execFileImpl = execFileAsync,
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
      const reviews = await fetchPullReviews({
        repo: group.repo,
        prNumber: group.prNumber,
        execFileImpl,
        env,
      });
      const comments = await fetchIssueComments({
        repo: group.repo,
        prNumber: group.prNumber,
        execFileImpl,
        env,
      });
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

        const verdict = row.pass_kind === 'remediation'
          ? null
          : normalizeReviewVerdict(ghReviewStateToVerdictInput(match.matched.state));
        const capturedAt = now();
        summary.populated += 1;
        logLine(
          log,
          `matched pass_id=${row.pass_id} repo=${row.repo} pr=${row.pr_number} attempt=${row.attempt_number} pass_kind=${row.pass_kind} gh_comment_id=${match.matched.nodeId || 'null'} dry_run=${apply ? 'false' : 'true'}${match.reason ? ` reason=${match.reason}` : ''}`
        );
        if (!apply) continue;
        updateStatement.run(
          verdict,
          match.matched.body,
          match.matched.nodeId || null,
          capturedAt,
          row.pass_id
        );
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
  execFileImpl = execFileAsync,
  env = process.env,
  log = console,
} = {}) {
  const db = openReviewStateDb(rootDir);
  const summary = {
    scanned: 0,
    advanced: 0,
    fetchErrors: 0,
  };
  try {
    ensureReviewStateSchema(db);
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
          `closeout repo=${row.repo} pr=${row.pr_number} outcome=gh_fetch_error error=${JSON.stringify(err?.message || String(err))}`
        );
        continue;
      }

      const observedAt = now();
      const closeout = composeMergeCloseoutFromComments({ comments });
      if (closeout.closeoutBodyMd) {
        summary.advanced += 1;
        logLine(
          log,
          `closeout repo=${row.repo} pr=${row.pr_number} outcome=body_captured dry_run=${apply ? 'false' : 'true'}`
        );
        if (!apply) continue;
        upsertCloseoutRow(db, {
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

      summary.advanced += 1;
      const emptyConfirmedAt = shouldConfirmEmptyCloseout({
        mergedAt: row.merged_at,
        observedAt,
      }) ? observedAt : null;
      logLine(
        log,
        `closeout repo=${row.repo} pr=${row.pr_number} outcome=${emptyConfirmedAt ? 'empty_confirmed' : 'empty_retryable'} dry_run=${apply ? 'false' : 'true'}`
      );
      if (!apply) continue;
      upsertEmptyCloseoutRow(db, {
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
  execFileImpl = execFileAsync,
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
      },
    },
    closeouts: {
      scanned: 0,
      advanced: 0,
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

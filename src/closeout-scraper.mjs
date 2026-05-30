import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  readLatestCompletedReviewerPassEndedAt,
  readReviewerPassLogins,
  recordMergeCloseout,
  recordMergeCloseoutScrapeFailure,
} from './review-state.mjs';

const execFileAsync = promisify(execFile);
const EMPTY_CLOSEOUT_SETTLE_MS = 10 * 60 * 1000;
// Comments posted after merge are still captured up to this many ms past
// mergedAt. The original `<= mergedAt` upper bound silently dropped
// operator closeout replies that landed within the natural operator
// cadence (claude-code/codex remediation replies routinely land minutes
// apart after a merge). Capped at 24h so settled-empty rows do not get
// re-scraped against the full PR comment history forever.
const POST_MERGE_CLOSEOUT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETRY_BACKOFF_MS = [50, 150];
const DEFAULT_MAX_ATTEMPTS = DEFAULT_RETRY_BACKOFF_MS.length + 1;
// Per CLAUDE.md's adversarial-review routing table: [clio-agent] PRs are
// reviewed by Codex, so clio-agent maps to the Codex reviewer login. The
// builder/reviewer split is what matters here; this map is consumed to
// build the closeout-author exclusion set, and getting it wrong would
// silently let the real reviewer's comments leak into the operator
// closeout attribution.
const REVIEWER_LOGIN_BY_CLASS = new Map([
  ['claude', 'claude-reviewer-lacey'],
  ['claude-code', 'claude-reviewer-lacey'],
  ['clio-agent', 'codex-reviewer-lacey'],
  ['codex', 'codex-reviewer-lacey'],
]);

// Builder-bot identities that can self-comment on their own PRs (status
// updates, self-replies). These are not operator closeouts — they are
// machine traffic, and including them would misattribute decisions in
// `closeout_authors_json` downstream.
const BUILDER_BOT_LOGINS = new Set([
  'clio-agent',
]);

function isReviewerBotLogin(loginLower) {
  return loginLower.endsWith('-reviewer-lacey');
}

function isGitHubBotLogin(loginLower) {
  return loginLower.endsWith('[bot]');
}

function isExcludedCloseoutAuthor(author, reviewerLogins) {
  const lower = String(author || '').trim().toLowerCase();
  if (!lower) return true;
  if (reviewerLogins.has(lower)) return true;
  if (isReviewerBotLogin(lower)) return true;
  if (isGitHubBotLogin(lower)) return true;
  if (BUILDER_BOT_LOGINS.has(lower)) return true;
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseIsoMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function reviewerLoginForClass(value) {
  return REVIEWER_LOGIN_BY_CLASS.get(String(value || '').trim().toLowerCase()) || null;
}

function isRetryableSqliteError(err) {
  const code = String(err?.code || '').toUpperCase();
  const message = String(err?.message || '').toLowerCase();
  return code === 'SQLITE_BUSY'
    || code === 'SQLITE_LOCKED'
    || message.includes('database is locked')
    || message.includes('database is busy');
}

function isRetryableGhError(err) {
  const code = String(err?.code || '').toUpperCase();
  const message = String(err?.message || '').toLowerCase();
  return err?.killed === true
    || code === 'ETIMEDOUT'
    || code === 'ECONNRESET'
    || code === 'EAI_AGAIN'
    || code === 'ENOTFOUND'
    || code === 'EGHSTDERR'
    || code === 'EGHPARSE'
    || /timed out|timeout|socket hang up|temporary failure|502|503|504|rate limit/i.test(message);
}

async function withRetry(task, {
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  backoffMs = DEFAULT_RETRY_BACKOFF_MS,
  isRetryable = () => false,
  logger = console,
  sleepImpl = sleep,
  label = 'operation',
} = {}) {
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await task(attempt);
    } catch (err) {
      if (attempt >= maxAttempts || !isRetryable(err)) throw err;
      const delayMs = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 0;
      logger.warn?.(
        `[closeout] transient ${label} failure on attempt ${attempt}/${maxAttempts}; retrying in ${delayMs}ms: ${err?.message || err}`
      );
      if (delayMs > 0) {
        await sleepImpl(delayMs);
      }
    }
  }
  throw new Error(`unreachable retry loop for ${label}`);
}

async function fetchPullRequestCreatedAt({
  repo,
  prNumber,
  execFileImpl = execFileAsync,
} = {}) {
  const { stdout } = await execFileImpl(
    'gh',
    ['api', `repos/${repo}/pulls/${encodeURIComponent(prNumber)}`],
    {
      maxBuffer: 5 * 1024 * 1024,
      timeout: 15_000,
    }
  );
  const parsed = JSON.parse(String(stdout || '').trim() || '{}');
  return parsed?.created_at || null;
}

// Stderr lines from `gh` that look like real fatal output (auth errors,
// HTTP failures, GraphQL errors) rather than benign banners (update
// notices, deprecation warnings, ratelimit headers, "Note:" lines).
// Used to decide whether non-empty stderr should fail the call when
// stdout otherwise looks complete. If stdout parsed cleanly into a
// non-empty list, only an explicit fatal-shaped stderr line should
// trip the retry path — benign banners are logged at warn and the
// parsed result is accepted, because failing closed there would brick
// captures on any persistent update banner.
const GH_STDERR_FATAL_PATTERN = /(^|\s)(error:|gh:\s|HTTP\s*[45]\d{2}\b|GraphQL\b|FATAL\b|Unauthorized\b|forbidden\b)/i;

function stderrLooksFatal(stderrText) {
  if (!stderrText) return false;
  return GH_STDERR_FATAL_PATTERN.test(stderrText);
}

async function fetchIssueComments({
  repo,
  prNumber,
  execFileImpl = execFileAsync,
  logger = console,
} = {}) {
  const { stdout, stderr } = await execFileImpl(
    'gh',
    [
      'api',
      '--paginate',
      `repos/${repo}/issues/${encodeURIComponent(prNumber)}/comments`,
      '-q',
      '.[] | {id: .node_id, login: .user.login, created_at: .created_at, body: .body}',
    ],
    {
      maxBuffer: 25 * 1024 * 1024,
      timeout: 15_000,
    }
  );
  const stderrText = String(stderr || '').trim();
  const stdoutText = String(stdout || '');
  const lines = stdoutText.split('\n').filter(Boolean);
  const parsed = [];
  let badLineCount = 0;
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch (parseErr) {
      badLineCount += 1;
      logger.warn?.(
        `[closeout] gh issue-comments non-JSON line for ${repo}#${prNumber} (skipped): ${line.slice(0, 200)} (${parseErr?.message || parseErr})`
      );
    }
  }

  // If we managed to parse at least one entry, accept the result even
  // when stderr was non-empty or some lines failed to parse. A benign
  // `gh` banner (update notice, deprecation, "Note:" header, ratelimit
  // warning) on stderr is a real-world failure mode that would otherwise
  // exhaust the retry budget for every PR until an operator manually
  // clears the noise — far worse than the cost of trusting a parsed
  // page. Only an explicit fatal-shaped stderr line short-circuits this.
  if (parsed.length > 0) {
    if (stderrText) {
      if (stderrLooksFatal(stderrText)) {
        const err = new Error(
          `gh issue-comments emitted fatal-shaped stderr (${stderrText.split('\n', 1)[0]})`
        );
        err.code = 'EGHSTDERR';
        throw err;
      }
      logger.warn?.(
        `[closeout] gh issue-comments stderr for ${repo}#${prNumber} (accepting parsed result): ${stderrText.split('\n', 1)[0]}`
      );
    }
    if (badLineCount > 0) {
      logger.warn?.(
        `[closeout] gh issue-comments skipped ${badLineCount} non-JSON line(s) for ${repo}#${prNumber}`
      );
    }
    return parsed;
  }

  // Zero parsed entries. Decide whether to retry or to return empty.
  if (stderrText) {
    logger.warn?.(
      `[closeout] gh issue-comments stderr for ${repo}#${prNumber} with empty parsed result: ${stderrText.split('\n', 1)[0]}`
    );
    const err = new Error(
      `gh issue-comments emitted stderr with no parsed comments (${stderrText.split('\n', 1)[0]})`
    );
    err.code = 'EGHSTDERR';
    throw err;
  }
  if (badLineCount > 0) {
    // stdout had only non-JSON lines and stderr was empty — treat as a
    // retryable parse failure rather than declaring "no comments".
    const err = new Error(
      `gh issue-comments produced ${badLineCount} non-JSON line(s) and no parsed comments for ${repo}#${prNumber}`
    );
    err.code = 'EGHPARSE';
    throw err;
  }
  return parsed;
}

function uniqueFirstSeen(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function formatCloseoutHeadingTimestamp(value) {
  const iso = new Date(value).toISOString();
  return iso.replace(/\.\d{3}Z$/, 'Z');
}

function composeCloseoutBody(comments) {
  if (!Array.isArray(comments) || comments.length === 0) return null;
  return comments.map((comment) => (
    `### Closeout ${formatCloseoutHeadingTimestamp(comment.created_at)} ${comment.login}\n\n${comment.body}`
  )).join('\n\n');
}

async function scrapeMergeCloseout({
  db,
  repo,
  prNumber,
  mergedAt,
  now = new Date(),
  execFileImpl = execFileAsync,
  logger = console,
  sleepImpl = sleep,
  reviewerLoginResolver = reviewerLoginForClass,
  fetchPullRequestCreatedAtImpl = fetchPullRequestCreatedAt,
  fetchIssueCommentsImpl = fetchIssueComments,
  recordMergeCloseoutImpl = recordMergeCloseout,
  recordMergeCloseoutScrapeFailureImpl = recordMergeCloseoutScrapeFailure,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryBackoffMs = DEFAULT_RETRY_BACKOFF_MS,
} = {}) {
  if (!db) throw new TypeError('scrapeMergeCloseout requires db');
  if (!repo || !prNumber || !mergedAt) {
    throw new TypeError('scrapeMergeCloseout requires repo, prNumber, and mergedAt');
  }

  const mergedAtMs = parseIsoMs(mergedAt);
  if (mergedAtMs === null) {
    throw new TypeError(`Invalid mergedAt timestamp: ${mergedAt}`);
  }

  try {
    return await withRetry(async () => {
      const lowerBound = readLatestCompletedReviewerPassEndedAt(db, { repo, prNumber })
        || await fetchPullRequestCreatedAtImpl({ repo, prNumber, execFileImpl });
      const lowerBoundMs = parseIsoMs(lowerBound);
      if (lowerBoundMs === null) {
        throw new Error(`Unable to resolve closeout lower bound for ${repo}#${prNumber}`);
      }

      const reviewerLogins = new Set(
        readReviewerPassLogins(db, { repo, prNumber, reviewerLoginResolver })
          .map((login) => String(login || '').trim().toLowerCase())
          .filter(Boolean)
      );
      // Window upper bound includes post-merge comments up to the scrape
      // time, capped at mergedAt + POST_MERGE_CLOSEOUT_WINDOW_MS so a
      // slow-cadence rescrape on a very old row can't silently start
      // attributing unrelated commentary as closeout content.
      const upperBoundMs = Math.min(
        Math.max(mergedAtMs, now.getTime()),
        mergedAtMs + POST_MERGE_CLOSEOUT_WINDOW_MS
      );
      const comments = (await fetchIssueCommentsImpl({ repo, prNumber, execFileImpl, logger }))
        .filter((comment) => {
          const createdAtMs = parseIsoMs(comment?.created_at);
          if (createdAtMs === null) return false;
          if (!(createdAtMs > lowerBoundMs && createdAtMs <= upperBoundMs)) return false;
          return !isExcludedCloseoutAuthor(comment?.login, reviewerLogins);
        })
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

      const scrapeCheckedAt = now.toISOString();
      const closeoutBodyMd = composeCloseoutBody(comments);
      const closeoutAuthors = uniqueFirstSeen(comments.map((comment) => comment.login));
      const closeoutPostedAt = comments.length > 0
        ? comments[comments.length - 1].created_at
        : null;
      const settledEmpty = comments.length === 0
        && now.getTime() >= mergedAtMs + EMPTY_CLOSEOUT_SETTLE_MS;
      const ghArtifactRefs = comments.map((comment) => ({
        kind: 'issue_comment',
        id: comment.id,
      }));

      await withRetry(
        async () => recordMergeCloseoutImpl(db, {
          repo,
          prNumber,
          mergedAt,
          scrapeLastCheckedAt: scrapeCheckedAt,
          closeoutBodyMd,
          closeoutAuthors,
          closeoutPostedAt,
          bodyCapturedAt: closeoutBodyMd ? scrapeCheckedAt : null,
          emptyConfirmedAt: closeoutBodyMd ? null : (settledEmpty ? scrapeCheckedAt : null),
          ghArtifactRefs: closeoutBodyMd ? ghArtifactRefs : [],
        }),
        {
          maxAttempts,
          backoffMs: retryBackoffMs,
          isRetryable: isRetryableSqliteError,
          logger,
          sleepImpl,
          label: 'sqlite-write',
        }
      );

      return {
        ok: true,
        repo,
        prNumber,
        mergedAt,
        lowerBound,
        closeoutBodyMd,
        closeoutAuthors,
        closeoutPostedAt,
        ghArtifactRefs,
        settledEmpty,
        commentCount: comments.length,
      };
    }, {
      maxAttempts,
      backoffMs: retryBackoffMs,
      isRetryable: isRetryableGhError,
      logger,
      sleepImpl,
      label: 'gh-fetch',
    });
  } catch (err) {
    logger.warn?.(
      `[closeout] scrape failed for ${repo}#${prNumber}; leaving debt outstanding for the next poll: ${err?.message || err}`
    );
    try {
      // Wrap the failure-debt persist in the same SQLITE_BUSY retry as the
      // success path: a briefly-locked DB on the failure path would
      // otherwise drop the attempt-count bump entirely and silently reset
      // the chronic-failure triage signal.
      await withRetry(
        async () => recordMergeCloseoutScrapeFailureImpl(db, {
          repo,
          prNumber,
          mergedAt,
          scrapeLastCheckedAt: now.toISOString(),
          errorMessage: String(err?.message || err),
        }),
        {
          maxAttempts,
          backoffMs: retryBackoffMs,
          isRetryable: isRetryableSqliteError,
          logger,
          sleepImpl,
          label: 'sqlite-failure-write',
        }
      );
    } catch (persistErr) {
      logger.warn?.(
        `[closeout] failed to persist scrape-failure debt for ${repo}#${prNumber}: ${persistErr?.message || persistErr}`
      );
    }
    return {
      ok: false,
      repo,
      prNumber,
      mergedAt,
      error: err,
    };
  }
}

export {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_BACKOFF_MS,
  EMPTY_CLOSEOUT_SETTLE_MS,
  POST_MERGE_CLOSEOUT_WINDOW_MS,
  composeCloseoutBody,
  fetchIssueComments,
  fetchPullRequestCreatedAt,
  formatCloseoutHeadingTimestamp,
  isExcludedCloseoutAuthor,
  isRetryableGhError,
  isRetryableSqliteError,
  scrapeMergeCloseout,
};

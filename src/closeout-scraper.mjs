import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  GH_LOOKUP_TIMEOUT_MS,
  execGhWithRetry,
  parseDate,
  parseJsonLines,
} from './gh-cli.mjs';
import { callGitHubAdapter, normalizeAdapterArray } from './github-adapter-client.mjs';


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
// Both reviewer-side AND builder-side defensive fallbacks are encoded here:
//   - reviewer-side: 'claude' → claude-reviewer-lacey, 'codex' → codex-reviewer-lacey
//     (these are the values reviewer_class / reviewer_model authoritatively hold).
//     Native Gemini rows are resolved from reviewer_model, not this fallback
//     map, so historical [gemini] builder-tag rows still exclude Codex.
//   - builder-side defensive fallbacks: in legacy rows or job-schema corruption
//     paths, the *builder* tag can end up in reviewer_class. For those rows we
//     must exclude the actual *reviewer* bot per the cross-model routing table.
//     '[clio-agent]' PRs are reviewed by Codex (Clio dispatches Codex writers,
//     so reviewer = opposite = Codex). '[claude-code]' PRs are reviewed by
//     Codex (writer = Claude, opposite = Codex). Both defensive rows must
//     point at codex-reviewer-lacey for the exclusion to fire correctly.
//     The defensive 'claude-code' entry was previously claude-reviewer-lacey,
//     a partial guard that left Codex reviewer comments leaking into operator
//     closeout attribution when reviewer_class held the builder tag.
const REVIEWER_LOGIN_BY_CLASS = new Map([
  ['claude', 'claude-reviewer-lacey'],
  ['claude-code', 'codex-reviewer-lacey'],
  ['clio-agent', 'codex-reviewer-lacey'],
  ['codex', 'codex-reviewer-lacey'],
  ['gemini', 'codex-reviewer-lacey'],
  ['pi', 'codex-reviewer-lacey'],
  // opencode defaults to Anthropic Claude; keep the reviewer cross-model.
  ['opencode', 'codex-reviewer-lacey'],
  ['hermes', 'codex-reviewer-lacey'],
]);
const REVIEWER_LOGIN_BY_MODEL = new Map([
  ['claude', 'claude-reviewer-lacey'],
  ['codex', 'codex-reviewer-lacey'],
  ['gemini', 'gemini-reviewer-lacey'],
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

function reviewerLoginForClass(value, row = null) {
  const reviewerModel = String(row?.reviewer_model || '').trim().toLowerCase();
  if (REVIEWER_LOGIN_BY_MODEL.has(reviewerModel)) {
    return REVIEWER_LOGIN_BY_MODEL.get(reviewerModel);
  }
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
  env = process.env,
  cwd = process.cwd(),
  canExecute,
} = {}) {
  try {
    const adapter = await callGitHubAdapter('pr-created-at', { repo, prNumber }, {
      execFileImpl,
      env,
      cwd,
      canExecute,
    });
    if (adapter.available !== false) {
      const createdAt = adapter.data?.createdAt || adapter.data?.created_at || adapter.data;
      if (createdAt) return String(createdAt);
      throw new Error('GitHub adapter created-at payload missing timestamp');
    }
  } catch {
    // Fall through to the existing gh implementation below.
  }
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

async function scraperFetchIssueComments({
  repo,
  prNumber,
  execFileImpl = execFileAsync,
  logger = console,
  env = process.env,
  cwd = process.cwd(),
  canExecute,
} = {}) {
  try {
    const adapter = await callGitHubAdapter('issue-comments', { repo, prNumber }, {
      execFileImpl,
      env,
      cwd,
      canExecute,
    });
    if (adapter.available !== false) {
      return normalizeAdapterArray(adapter.data, 'comments').map((comment) => ({
        id: comment?.id ?? comment?.node_id ?? comment?.nodeId ?? null,
        login: comment?.login ?? comment?.authorLogin ?? comment?.user?.login ?? null,
        created_at: comment?.created_at ?? comment?.createdAt ?? null,
        body: String(comment?.body ?? ''),
      }));
    }
  } catch {
    // Fall through to the existing gh implementation below.
  }
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
  fetchIssueCommentsImpl = scraperFetchIssueComments,
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
    // Lower-bound resolution is hoisted out of `withRetry` so a flaky
    // `fetchIssueComments` does NOT replay the upstream `gh pulls/{n}` fetch
    // (or the DB read) on every retry — 2-3× redundant GH API calls per
    // failing scrape, compounded across the 20-row tick budget exactly when
    // GH is degraded. The lower bound cannot change between attempts within
    // a single scrape, so resolve it once before the retry shell.
    const lowerBound = readLatestCompletedReviewerPassEndedAt(db, { repo, prNumber })
      || await fetchPullRequestCreatedAtImpl({ repo, prNumber, execFileImpl });
    const lowerBoundMs = parseIsoMs(lowerBound);
    if (lowerBoundMs === null) {
      throw new Error(`Unable to resolve closeout lower bound for ${repo}#${prNumber}`);
    }

    return await withRetry(async () => {
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
      // closeout_posted_at is the FIRST closeout comment's created_at, not
      // the last. The field name reads as "when the closeout was posted,"
      // which is naturally the first comment in the closeout thread. Using
      // the last comment was a semantics mismatch that would mislead any
      // "how long after merge did the operator close this out" analytics
      // query against this column by the spread of the comment thread.
      const closeoutPostedAt = comments.length > 0
        ? comments[0].created_at
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

const CLOSEOUT_MARKER = 'hq:closeout:pr';
const CLOSEOUT_SETTLE_DELAY_MS = 10 * 60 * 1000;

function isMergeCloseoutMarked(body) {
  return String(body || '').includes(CLOSEOUT_MARKER);
}

function stripMergeCloseoutMarker(body) {
  return String(body || '')
    .replace(/<!--\s*hq:closeout:pr\s*-->\s*/gi, '')
    .trim();
}

function normalizeIssueComment(raw = {}) {
  return {
    id: raw.id ?? null,
    nodeId: raw.node_id ?? raw.nodeId ?? null,
    body: String(raw.body ?? ''),
    createdAt: raw.created_at ?? raw.createdAt ?? null,
    updatedAt: raw.updated_at ?? raw.updatedAt ?? null,
    authorLogin: raw?.user?.login ?? raw.authorLogin ?? null,
    url: raw.html_url ?? raw.url ?? null,
  };
}

async function fetchIssueComments({
  repo,
  prNumber,
  execFileImpl,
  env = process.env,
  timeoutMs = GH_LOOKUP_TIMEOUT_MS,
  retries,
  cwd = process.cwd(),
  canExecute,
} = {}) {
  try {
    const adapter = await callGitHubAdapter('issue-comments', { repo, prNumber }, {
      execFileImpl,
      env,
      cwd,
      canExecute,
      timeoutMs,
    });
    if (adapter.available !== false) {
      return normalizeAdapterArray(adapter.data, 'comments').map(normalizeIssueComment);
    }
  } catch {
    // Fall through to the existing gh implementation below.
  }
  const { stdout } = await execGhWithRetry({
    execFileImpl,
    env,
    timeoutMs,
    retries,
    args: [
      'api',
      '--paginate',
      `repos/${repo}/issues/${encodeURIComponent(prNumber)}/comments`,
      '-q',
      '.[] | {id: .id, node_id: .node_id, body: .body, created_at: .created_at, updated_at: .updated_at, html_url: .html_url, user: {login: .user.login}}',
    ],
  });
  return parseJsonLines(stdout).map(normalizeIssueComment);
}

function composeMergeCloseoutFromComments({ comments = [] } = {}) {
  const marked = comments
    .map(normalizeIssueComment)
    .filter((comment) => isMergeCloseoutMarked(comment.body))
    .map((comment) => ({
      ...comment,
      strippedBody: stripMergeCloseoutMarker(comment.body),
      createdAtDate: parseDate(comment.createdAt),
    }))
    .filter((comment) => comment.strippedBody);

  if (marked.length === 0) {
    return {
      closeoutBodyMd: null,
      closeoutAuthors: [],
      closeoutPostedAt: null,
      ghArtifactRefs: [],
      artifactCount: 0,
    };
  }

  marked.sort((left, right) => {
    const leftMs = left.createdAtDate?.getTime() ?? 0;
    const rightMs = right.createdAtDate?.getTime() ?? 0;
    return leftMs - rightMs;
  });
  // Body: last marked comment wins (most recent operator/agent intent).
  // Authors: deduplicated across all marked comments so multi-author
  // closeouts are not silently discarded; column is structurally a JSON
  // array of distinct authors in first-seen order.
  const selected = marked.at(-1);
  const closeoutAuthors = [];
  const seenAuthors = new Set();
  for (const comment of marked) {
    const author = comment.authorLogin;
    if (!author || seenAuthors.has(author)) continue;
    seenAuthors.add(author);
    closeoutAuthors.push(author);
  }
  const ghArtifactRefs = marked.map((comment) => ({
    kind: 'comment',
    id: comment.nodeId || comment.id || null,
    url: comment.url || null,
  }));
  return {
    closeoutBodyMd: selected.strippedBody,
    closeoutAuthors,
    closeoutPostedAt: selected.createdAt || selected.updatedAt || null,
    ghArtifactRefs,
    artifactCount: ghArtifactRefs.length,
  };
}

function shouldConfirmEmptyCloseout({ mergedAt, observedAt }) {
  const merged = parseDate(mergedAt);
  const observed = parseDate(observedAt);
  if (!merged || !observed) return false;
  return observed.getTime() >= (merged.getTime() + CLOSEOUT_SETTLE_DELAY_MS);
}

export {
  CLOSEOUT_MARKER,
  CLOSEOUT_SETTLE_DELAY_MS,
  composeMergeCloseoutFromComments,
  fetchIssueComments,
  isMergeCloseoutMarked,
  normalizeIssueComment,
  shouldConfirmEmptyCloseout,
  stripMergeCloseoutMarker,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_BACKOFF_MS,
  EMPTY_CLOSEOUT_SETTLE_MS,
  POST_MERGE_CLOSEOUT_WINDOW_MS,
  composeCloseoutBody,
  scraperFetchIssueComments,
  fetchPullRequestCreatedAt,
  formatCloseoutHeadingTimestamp,
  isExcludedCloseoutAuthor,
  isRetryableGhError,
  isRetryableSqliteError,
  scrapeMergeCloseout,
};

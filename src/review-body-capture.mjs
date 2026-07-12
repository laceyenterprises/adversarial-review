import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import { openReviewStateDb, ensureReviewStateSchema } from './review-state.mjs';
import { awaitThrottleIfNeeded } from './rate-limit-throttle.mjs';

const execFileAsync = promisify(execFile);
const REVIEW_CAPTURE_LOOKBACK_MS = 2 * 60 * 1000;
// Symmetric forward bound: GitHub artifact `submitted_at`/`created_at` is
// set after our `gh pr review` / comment post returns, so propagation lag
// puts the artifact strictly after our recorded `postedAt`. We default to
// 5 minutes forward to absorb slow runners and GH side delay; the upstream
// caller is expected to capture `postedAt` AFTER the post call returns so
// most of this window is unused on normal latency.
const REVIEW_CAPTURE_FORWARD_MS = 5 * 60 * 1000;
const REVIEW_LOOKUP_TIMEOUT_MS = 8_000;
// The reviewers post via GitHub Apps now (broker provider=github-app-*-reviewer),
// so the canonical review author login is `lacey-<model>-reviewer[bot]`. Keep
// the legacy PAT user `<model>-reviewer-lacey` as a lookup alias while mixed
// deployments and inherited-token fallback paths still exist. Using only the
// old login made the post-review id lookup never match; using only the new App
// login would drop legacy artifacts. Both failures leave gh_comment_id NULL and
// can park reviewed/mergeable PRs behind `blocking-findings-unknown`.
const REVIEWER_BOT_LOGIN_ALIASES = Object.freeze({
  claude: ['lacey-claude-reviewer[bot]', 'claude-reviewer-lacey'],
  codex: ['lacey-codex-reviewer[bot]', 'codex-reviewer-lacey'],
  'claude-code': ['lacey-claude-reviewer[bot]', 'claude-reviewer-lacey'],
  gemini: ['lacey-gemini-reviewer[bot]', 'gemini-reviewer-lacey'],
  pi: ['lacey-codex-reviewer[bot]', 'codex-reviewer-lacey'],
  // opencode defaults to Anthropic Claude; keep the reviewer cross-model.
  opencode: ['lacey-codex-reviewer[bot]', 'codex-reviewer-lacey'],
  hermes: ['lacey-codex-reviewer[bot]', 'codex-reviewer-lacey'],
  GH_CLAUDE_REVIEWER_TOKEN: ['lacey-claude-reviewer[bot]', 'claude-reviewer-lacey'],
  GH_CODEX_REVIEWER_TOKEN: ['lacey-codex-reviewer[bot]', 'codex-reviewer-lacey'],
  GH_GEMINI_REVIEWER_TOKEN: ['lacey-gemini-reviewer[bot]', 'gemini-reviewer-lacey'],
});

// Match two GitHub logins tolerant of the `[bot]` suffix (app-token authors carry
// it; some surfaces strip it) and case.
function loginsMatch(a, b) {
  const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\[bot\]$/, '');
  const na = norm(a);
  const nb = norm(b);
  return na !== '' && na === nb;
}
const REVIEWER_PASS_KINDS = new Set(['first-pass', 'rereview', 'remediation']);

function normalizeBotLoginKey(value) {
  return String(value ?? '').trim();
}

function resolveReviewerBotLogin(value) {
  const key = normalizeBotLoginKey(value);
  if (!key) return null;
  const aliases = REVIEWER_BOT_LOGIN_ALIASES[key] || REVIEWER_BOT_LOGIN_ALIASES[key.toLowerCase()];
  return aliases?.[0] || null;
}

function resolveReviewerBotLoginAliases(value) {
  const key = normalizeBotLoginKey(value);
  if (!key) return [];
  const aliases = REVIEWER_BOT_LOGIN_ALIASES[key] || REVIEWER_BOT_LOGIN_ALIASES[key.toLowerCase()];
  return aliases ? [...aliases] : [];
}

function toEpochMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function withinCaptureWindow(
  candidateAt,
  postedAt,
  lookbackMs = REVIEW_CAPTURE_LOOKBACK_MS,
  forwardMs = REVIEW_CAPTURE_FORWARD_MS,
) {
  const candidateMs = toEpochMs(candidateAt);
  const postedMs = toEpochMs(postedAt);
  if (candidateMs === null || postedMs === null) return false;
  return candidateMs >= (postedMs - lookbackMs) && candidateMs <= postedMs + forwardMs;
}

// GitHub may normalize whitespace (in particular CRLF→LF) on review and
// comment bodies. Normalize both sides before equality to keep the
// exact-match contract robust to those rewrites without falling back to
// "newest comment in window," which produced wrong gh_comment_id values.
function normalizeBodyForMatch(body) {
  if (body == null) return '';
  return String(body).replace(/\r\n/g, '\n');
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

function sortNewestFirst(items, timestampField) {
  return [...items].sort((left, right) => {
    const leftMs = toEpochMs(left?.[timestampField]) ?? -Infinity;
    const rightMs = toEpochMs(right?.[timestampField]) ?? -Infinity;
    return rightMs - leftMs;
  });
}

function pickBestBodyMatch(items, body, timestampField) {
  const target = normalizeBodyForMatch(body);
  const exactMatches = items.filter((item) => normalizeBodyForMatch(item?.body) === target);
  if (exactMatches.length === 0) return null;
  return sortNewestFirst(exactMatches, timestampField)[0] || null;
}

async function lookupRecentReviewArtifact({
  repo,
  prNumber,
  endpoint,
  login,
  postedAt,
  body,
  execFileImpl = execFileAsync,
  env = process.env,
  timeoutMs = REVIEW_LOOKUP_TIMEOUT_MS,
  timestampField = 'created_at',
} = {}) {
  if (!repo || !prNumber || !endpoint || !login || !postedAt) return null;
  await awaitThrottleIfNeeded();
  // `-f per_page=100` makes `gh api` send the field as a JSON body which
  // forces method=POST and the comments endpoint returns HTTP 422
  // ("body wasn't supplied"). `-X GET` keeps the method explicit so the
  // field becomes a query-string parameter as intended. Without this fix
  // every reviewer/remediation body capture failed silently and
  // reviewer_passes.gh_comment_id stayed NULL forever.
  const { stdout } = await execFileImpl(
    'gh',
    [
      'api',
      '--paginate',
      '-X',
      'GET',
      endpoint,
      '-f',
      'per_page=100',
      '-q',
      '.[] | {id: .id, body: .body, login: .user.login, created_at: (.submitted_at // .created_at // null)}',
    ],
    {
      env,
      maxBuffer: 25 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
    }
  );
  const loginAliases = Array.isArray(login) ? login : [login];
  const candidates = parseJsonLines(stdout)
    .filter((item) => loginAliases.some((alias) => loginsMatch(item?.login, alias)))
    .filter((item) => withinCaptureWindow(item?.created_at, postedAt));
  return pickBestBodyMatch(candidates, body, 'created_at');
}

function updateReviewerPassBodyCapture(rootDir, {
  repo,
  prNumber,
  attemptNumber,
  passKind,
  verdict = null,
  bodyMd,
  ghCommentId = null,
  capturedAt = new Date().toISOString(),
  log = console,
} = {}) {
  if (!repo || !Number.isInteger(Number(prNumber)) || !Number.isInteger(Number(attemptNumber)) || !bodyMd) {
    throw new TypeError('Missing required reviewer-pass capture fields');
  }
  const kind = typeof passKind === 'string' ? passKind.trim() : '';
  if (!kind) throw new TypeError('passKind is required');
  if (!REVIEWER_PASS_KINDS.has(kind)) throw new TypeError(`Invalid reviewer pass_kind: ${passKind}`);
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    const result = db.prepare(
      `UPDATE reviewer_passes
          SET verdict = ?,
              body_md = ?,
              gh_comment_id = ?,
              body_captured_at = ?
        WHERE repo = ?
          AND pr_number = ?
          AND attempt_number = ?
          AND pass_kind = ?
          AND body_md IS NULL`
    ).run(
      verdict,
      bodyMd,
      ghCommentId === null || ghCommentId === undefined ? null : String(ghCommentId),
      capturedAt,
      repo,
      Number(prNumber),
      Number(attemptNumber),
      kind,
    );
    // Surface silent misses: a 0-row UPDATE means the row we expected to
    // stamp (created by beginReviewerPass / recordRemediationPassStartedSafe)
    // does not exist for this (repo, pr, attempt, pass_kind). The GitHub
    // comment is real and posted; the local mirror has no row to link it
    // to. Without this warn, attempt-number / passKind drift between the
    // row creator and the capture call is invisible.
    if (result?.changes === 0) {
      log.warn?.(
        `[review-body-capture] capture matched 0 rows for ${repo}#${prNumber} ` +
        `attempt=${Number(attemptNumber)} pass_kind=${kind}; ` +
        `body and gh_comment_id were NOT linked to any reviewer_passes row`
      );
    }
    return result;
  } finally {
    db.close();
  }
}

function hasCapturedReviewerBody(rootDir, {
  repo, prNumber, attemptNumber, passKind, reviewBody,
} = {}) {
  const kind = resolvePassKindForReviewer(passKind, { attemptNumber });
  let db;
  try {
    db = openReviewStateDb(rootDir);
    ensureReviewStateSchema(db);
    const row = db.prepare(
      `SELECT body_md FROM reviewer_passes
        WHERE repo = ? AND pr_number = ? AND attempt_number = ? AND pass_kind = ?`
    ).get(repo, Number(prNumber), Number(attemptNumber), kind);
    return row?.body_md === reviewBody;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

// Build the env override used for the lookup gh subprocess. If a token is
// resolved (preferred reviewer-bot token, then inherited GH_TOKEN), set it
// on the lookup env. If neither is present, omit GH_TOKEN entirely — the
// gh subprocess would otherwise treat the literal string `"null"` as a
// token and fail with an opaque auth error.
function buildLookupEnv(env, preferredToken) {
  const out = { ...env };
  delete out.GH_TOKEN;
  const token = preferredToken || env?.GH_TOKEN;
  if (token) out.GH_TOKEN = token;
  return out;
}

function resolvePassKindForReviewer(passKind, { attemptNumber } = {}) {
  if (typeof passKind === 'string') {
    const trimmed = passKind.trim();
    if (trimmed === 'first-pass' || trimmed === 'rereview') return trimmed;
  }
  const attempt = Number(attemptNumber);
  return Number.isFinite(attempt) && attempt > 1 ? 'rereview' : 'first-pass';
}

async function captureReviewerBodyAfterPost(rootDir, {
  repo,
  prNumber,
  attemptNumber,
  reviewerModel,
  botTokenEnv,
  reviewBody,
  verdict,
  passKind,
  postedAt = new Date().toISOString(),
  execFileImpl = execFileAsync,
  env = process.env,
  log = console,
} = {}) {
  try {
    const logins = resolveReviewerBotLoginAliases(botTokenEnv || reviewerModel);
    let ghCommentId = null;
    if (logins.length > 0) {
      try {
        const lookupEnv = buildLookupEnv(env, botTokenEnv ? env?.[botTokenEnv] : null);
        const artifact = await lookupRecentReviewArtifact({
          repo,
          prNumber,
          endpoint: `repos/${repo}/pulls/${encodeURIComponent(prNumber)}/reviews`,
          login: logins,
          postedAt,
          body: reviewBody,
          execFileImpl,
          env: lookupEnv,
        });
        ghCommentId = artifact?.id ?? null;
        if (!artifact) {
          log.warn?.(`[reviewer] review body capture could not find recent GitHub review id for ${repo}#${prNumber}; storing body without gh_comment_id`);
        }
      } catch (err) {
        log.warn?.(`[reviewer] review body capture review-id lookup failed for ${repo}#${prNumber}: ${err.message}`);
      }
    }
    updateReviewerPassBodyCapture(rootDir, {
      repo,
      prNumber,
      attemptNumber: Number(attemptNumber),
      passKind: resolvePassKindForReviewer(passKind, { attemptNumber }),
      verdict,
      bodyMd: reviewBody,
      ghCommentId,
      capturedAt: postedAt,
      log,
    });
  } catch (err) {
    log.warn?.(`[reviewer] review body capture failed for ${repo}#${prNumber}: ${err.message}`);
  }
}

async function captureRemediationBodyAfterPost(rootDir, {
  repo,
  prNumber,
  attemptNumber,
  workerClass,
  body,
  postedAt = new Date().toISOString(),
  execFileImpl = execFileAsync,
  env = process.env,
  log = console,
} = {}) {
  try {
    const logins = resolveReviewerBotLoginAliases(workerClass);
    let ghCommentId = null;
    if (logins.length > 0) {
      try {
        const lookupEnv = buildLookupEnv(env, null);
        const artifact = await lookupRecentReviewArtifact({
          repo,
          prNumber,
          endpoint: `repos/${repo}/issues/${encodeURIComponent(prNumber)}/comments`,
          login: logins,
          postedAt,
          body,
          execFileImpl,
          env: lookupEnv,
        });
        ghCommentId = artifact?.id ?? null;
        if (!artifact) {
          log.warn?.(`[follow-up-remediation] remediation body capture could not find recent GitHub comment id for ${repo}#${prNumber}; storing body without gh_comment_id`);
        }
      } catch (err) {
        log.warn?.(`[follow-up-remediation] remediation body capture comment-id lookup failed for ${repo}#${prNumber}: ${err.message}`);
      }
    }
    updateReviewerPassBodyCapture(rootDir, {
      repo,
      prNumber,
      attemptNumber: Number(attemptNumber),
      passKind: 'remediation',
      verdict: null,
      bodyMd: body,
      ghCommentId,
      capturedAt: postedAt,
      log,
    });
  } catch (err) {
    log.warn?.(`[follow-up-remediation] remediation body capture failed for ${repo}#${prNumber}: ${err.message}`);
  }
}

export {
  REVIEW_CAPTURE_FORWARD_MS,
  REVIEW_CAPTURE_LOOKBACK_MS,
  REVIEW_LOOKUP_TIMEOUT_MS,
  captureRemediationBodyAfterPost,
  captureReviewerBodyAfterPost,
  hasCapturedReviewerBody,
  lookupRecentReviewArtifact,
  resolveReviewerBotLogin,
  updateReviewerPassBodyCapture,
};

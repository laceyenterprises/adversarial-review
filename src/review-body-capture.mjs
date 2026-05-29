import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import { openReviewStateDb, ensureReviewStateSchema } from './review-state.mjs';

const execFileAsync = promisify(execFile);
const REVIEW_CAPTURE_LOOKBACK_MS = 2 * 60 * 1000;
const REVIEWER_BOT_LOGINS = Object.freeze({
  claude: 'claude-reviewer-lacey',
  codex: 'codex-reviewer-lacey',
  'claude-code': 'claude-reviewer-lacey',
  GH_CLAUDE_REVIEWER_TOKEN: 'claude-reviewer-lacey',
  GH_CODEX_REVIEWER_TOKEN: 'codex-reviewer-lacey',
});

function normalizeBotLoginKey(value) {
  return String(value ?? '').trim();
}

function resolveReviewerBotLogin(value) {
  const key = normalizeBotLoginKey(value);
  if (!key) return null;
  return REVIEWER_BOT_LOGINS[key] || REVIEWER_BOT_LOGINS[key.toLowerCase()] || null;
}

function toEpochMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function withinCaptureWindow(candidateAt, postedAt, lookbackMs = REVIEW_CAPTURE_LOOKBACK_MS) {
  const candidateMs = toEpochMs(candidateAt);
  const postedMs = toEpochMs(postedAt);
  if (candidateMs === null || postedMs === null) return false;
  return candidateMs >= (postedMs - lookbackMs) && candidateMs <= postedMs + 15_000;
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
  const exactMatches = items.filter((item) => String(item?.body || '') === String(body || ''));
  const pool = exactMatches.length > 0 ? exactMatches : items;
  return sortNewestFirst(pool, timestampField)[0] || null;
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
  timeoutMs = 30_000,
  timestampField = 'created_at',
} = {}) {
  if (!repo || !prNumber || !endpoint || !login || !postedAt) return null;
  const { stdout } = await execFileImpl(
    'gh',
    [
      'api',
      '--paginate',
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
  const candidates = parseJsonLines(stdout)
    .filter((item) => item?.login === login)
    .filter((item) => withinCaptureWindow(item?.created_at, postedAt));
  return pickBestBodyMatch(candidates, body, 'created_at');
}

function updateReviewerPassBodyCapture(rootDir, {
  repo,
  prNumber,
  attemptNumber,
  passKinds,
  verdict = null,
  bodyMd,
  ghCommentId = null,
  capturedAt = new Date().toISOString(),
} = {}) {
  if (!repo || !Number.isInteger(Number(prNumber)) || !Number.isInteger(Number(attemptNumber)) || !bodyMd) {
    throw new TypeError('Missing required reviewer-pass capture fields');
  }
  const kinds = Array.isArray(passKinds) ? passKinds.filter(Boolean) : [];
  if (kinds.length === 0) throw new TypeError('passKinds is required');
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    const placeholders = kinds.map(() => '?').join(', ');
    const result = db.prepare(
      `UPDATE reviewer_passes
          SET verdict = ?,
              body_md = ?,
              gh_comment_id = ?,
              body_captured_at = ?
        WHERE repo = ?
          AND pr_number = ?
          AND attempt_number = ?
          AND pass_kind IN (${placeholders})
          AND body_md IS NULL`
    ).run(
      verdict,
      bodyMd,
      ghCommentId === null || ghCommentId === undefined ? null : String(ghCommentId),
      capturedAt,
      repo,
      Number(prNumber),
      Number(attemptNumber),
      ...kinds,
    );
    return result;
  } finally {
    db.close();
  }
}

async function captureReviewerBodyAfterPost(rootDir, {
  repo,
  prNumber,
  attemptNumber,
  reviewerModel,
  botTokenEnv,
  reviewBody,
  verdict,
  postedAt = new Date().toISOString(),
  execFileImpl = execFileAsync,
  env = process.env,
  log = console,
} = {}) {
  try {
    const login = resolveReviewerBotLogin(botTokenEnv || reviewerModel);
    let ghCommentId = null;
    if (login) {
      try {
        const artifact = await lookupRecentReviewArtifact({
          repo,
          prNumber,
          endpoint: `repos/${repo}/pulls/${encodeURIComponent(prNumber)}/reviews`,
          login,
          postedAt,
          body: reviewBody,
          execFileImpl,
          env: { ...env, GH_TOKEN: env[botTokenEnv] || env.GH_TOKEN },
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
      passKinds: ['first-pass', 'rereview'],
      verdict,
      bodyMd: reviewBody,
      ghCommentId,
      capturedAt: postedAt,
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
    const login = resolveReviewerBotLogin(workerClass);
    let ghCommentId = null;
    if (login) {
      try {
        const artifact = await lookupRecentReviewArtifact({
          repo,
          prNumber,
          endpoint: `repos/${repo}/issues/${encodeURIComponent(prNumber)}/comments`,
          login,
          postedAt,
          body,
          execFileImpl,
          env: { ...env, GH_TOKEN: env.GH_TOKEN || null },
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
      passKinds: ['remediation'],
      verdict: null,
      bodyMd: body,
      ghCommentId,
      capturedAt: postedAt,
    });
  } catch (err) {
    log.warn?.(`[follow-up-remediation] remediation body capture failed for ${repo}#${prNumber}: ${err.message}`);
  }
}

export {
  REVIEW_CAPTURE_LOOKBACK_MS,
  captureRemediationBodyAfterPost,
  captureReviewerBodyAfterPost,
  lookupRecentReviewArtifact,
  resolveReviewerBotLogin,
  updateReviewerPassBodyCapture,
};

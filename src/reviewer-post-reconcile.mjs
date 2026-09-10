import { REVIEW_POST_RETRY_DELAYS_MS } from './reviewer-util.mjs';

class AmbiguousReviewerPostUnreconciledError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'AmbiguousReviewerPostUnreconciledError';
    this.cause = cause;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withGhRetry(operation, {
  retryDelaysMs = REVIEW_POST_RETRY_DELAYS_MS,
  isRetryable = () => false,
} = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt >= retryDelaysMs.length) {
        throw err;
      }
      await sleep(retryDelaysMs[attempt]);
    }
  }
  throw lastErr;
}

function normalizeReviewBodyForMatch(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function exactHeadReviewStateForEvent(event) {
  if (event === 'REQUEST_CHANGES') return 'CHANGES_REQUESTED';
  if (event === 'APPROVE') return 'APPROVED';
  return 'COMMENTED';
}

function parseGitHubJsonArray(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return [];
  const jsonStart = text.search(/[\[{]/);
  const payload = jsonStart >= 0 ? text.slice(jsonStart).trim() : text;
  const parsed = JSON.parse(payload);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.data)) return parsed.data;
  return [];
}

async function findMatchingSubmittedReviewAfterAmbiguousPost({
  execFileImpl,
  repo,
  prNumber,
  reviewBody,
  reviewerHeadSha,
  reviewerLogin,
  event,
  env,
  log = console,
} = {}) {
  const expectedBody = normalizeReviewBodyForMatch(reviewBody);
  const expectedCommit = String(reviewerHeadSha || '').trim();
  const expectedLogin = String(reviewerLogin || '').trim();
  const expectedState = exactHeadReviewStateForEvent(event);
  let response;
  try {
    response = await execFileImpl(
      'gh',
      ['api', `repos/${repo}/pulls/${prNumber}/reviews`, '--paginate'],
      {
        env,
        maxBuffer: 5 * 1024 * 1024,
      }
    );
  } catch (err) {
    log.warn?.(
      `[reviewer] ambiguous review post for ${repo}#${prNumber} could not be reconciled: ${err?.message || err}`
    );
    return { status: 'unavailable', error: err };
  }
  let reviews;
  try {
    reviews = parseGitHubJsonArray(response?.stdout);
  } catch (err) {
    log.warn?.(
      `[reviewer] ambiguous review post for ${repo}#${prNumber} returned unreadable review list: ${err?.message || err}`
    );
    return { status: 'unavailable', error: err };
  }
  const matches = reviews.filter((review) => {
    if (!review || typeof review !== 'object') return false;
    if (expectedCommit && String(review.commit_id || '').trim() !== expectedCommit) return false;
    if (expectedState && String(review.state || '').trim() !== expectedState) return false;
    if (normalizeReviewBodyForMatch(review.body) !== expectedBody) return false;
    if (expectedLogin && String(review.user?.login || '').trim() !== expectedLogin) return false;
    return Boolean(review.id);
  });
  if (!matches.length) return { status: 'none' };
  matches.sort((a, b) => String(b.submitted_at || b.submittedAt || '').localeCompare(String(a.submitted_at || a.submittedAt || '')));
  const review = matches[0];
  return {
    status: 'matched',
    reviewArtifact: {
      id: String(review.id),
      commitId: String(review.commit_id || expectedCommit),
    },
  };
}

export {
  AmbiguousReviewerPostUnreconciledError,
  findMatchingSubmittedReviewAfterAmbiguousPost,
  withGhRetry,
};

const GITHUB_API_ROOT = 'https://api.github.com';
const REVIEWER_USER_AGENT = 'adversarial-review-reviewer';

function buildHeaders(token) {
  return {
    Authorization: `token ${token}`,
    'User-Agent': REVIEWER_USER_AGENT,
  };
}

function splitRepo(repo) {
  const [owner, repoName] = String(repo || '').split('/');
  return {
    owner: owner || null,
    repoName: repoName || null,
  };
}

async function probeSelfLogin({
  token,
  fetchImpl = globalThis.fetch,
  log = console,
} = {}) {
  if (!token) return null;
  try {
    const userRes = await fetchImpl(`${GITHUB_API_ROOT}/user`, {
      headers: buildHeaders(token),
    });
    if (!userRes.ok) {
      log.warn?.(`[reviewer-pre-write] self-login probe returned HTTP ${userRes.status}`);
      return null;
    }
    const userJson = await userRes.json();
    return String(userJson?.login || '').trim() || null;
  } catch (err) {
    log.warn?.(`[reviewer-pre-write] self-login probe failed: ${err?.message || err}`);
    return null;
  }
}

async function listPullRequestReviews({
  repo,
  prNumber,
  token,
  fetchImpl = globalThis.fetch,
  log = console,
} = {}) {
  const { owner, repoName } = splitRepo(repo);
  if (!token || !owner || !repoName) return [];
  try {
    const listRes = await fetchImpl(
      `${GITHUB_API_ROOT}/repos/${owner}/${repoName}/pulls/${prNumber}/reviews`,
      { headers: buildHeaders(token) }
    );
    if (!listRes.ok) {
      log.warn?.(`[reviewer-pre-write] review list returned HTTP ${listRes.status}`);
      return [];
    }
    const payload = await listRes.json();
    return Array.isArray(payload) ? payload : [];
  } catch (err) {
    log.warn?.(`[reviewer-pre-write] review list failed: ${err?.message || err}`);
    return [];
  }
}

async function deletePendingReview({
  repo,
  prNumber,
  reviewId,
  token,
  fetchImpl = globalThis.fetch,
  log = console,
} = {}) {
  const { owner, repoName } = splitRepo(repo);
  if (!token || !owner || !repoName || !reviewId) return false;
  try {
    const delRes = await fetchImpl(
      `${GITHUB_API_ROOT}/repos/${owner}/${repoName}/pulls/${prNumber}/reviews/${reviewId}`,
      {
        method: 'DELETE',
        headers: buildHeaders(token),
      }
    );
    if (!delRes.ok) {
      log.warn?.(`[reviewer-pre-write] failed to clear pending review ${reviewId}: HTTP ${delRes.status}`);
      return false;
    }
    log.log?.(`[reviewer-pre-write] cleared pending review ${reviewId} on ${repo}#${prNumber}`);
    return true;
  } catch (err) {
    log.warn?.(`[reviewer-pre-write] failed to clear pending review ${reviewId}: ${err?.message || err}`);
    return false;
  }
}

function pendingReviewsOwnedBy(reviews, selfLogin) {
  return (Array.isArray(reviews) ? reviews : []).filter((review) => (
    review?.state === 'PENDING' &&
    String(review?.user?.login || '').trim() === selfLogin
  ));
}

async function clearPendingReviewsForSelf({
  repo,
  prNumber,
  token,
  fetchImpl = globalThis.fetch,
  log = console,
} = {}) {
  if (!token) return { cleared: 0, listed: 0 };
  const { owner, repoName } = splitRepo(repo);
  if (!owner || !repoName) return { cleared: 0, listed: 0 };

  const selfLogin = await probeSelfLogin({ token, fetchImpl, log });
  if (!selfLogin) return { cleared: 0, listed: 0 };

  const reviews = await listPullRequestReviews({ repo, prNumber, token, fetchImpl, log });
  const listed = reviews.length;
  let cleared = 0;
  for (const pending of pendingReviewsOwnedBy(reviews, selfLogin)) {
    if (await deletePendingReview({
      repo,
      prNumber,
      reviewId: pending?.id,
      token,
      fetchImpl,
      log,
    })) {
      cleared += 1;
    }
  }
  return { cleared, listed, selfLogin };
}

async function reconcilePendingReviewsForSelf({
  repo,
  prNumber,
  token,
  currentHeadSha,
  respawnAgeSeconds,
  now = new Date(),
  fetchImpl = globalThis.fetch,
  log = console,
} = {}) {
  if (!token) {
    return {
      listed: 0,
      cleared: 0,
      retained: 0,
      retainedReason: null,
      respawnDeadlineUtc: null,
      shouldSpawn: true,
      selfLogin: null,
    };
  }
  const { owner, repoName } = splitRepo(repo);
  if (!owner || !repoName) {
    return {
      listed: 0,
      cleared: 0,
      retained: 0,
      retainedReason: null,
      respawnDeadlineUtc: null,
      shouldSpawn: true,
      selfLogin: null,
    };
  }

  const selfLogin = await probeSelfLogin({ token, fetchImpl, log });
  if (!selfLogin) {
    return {
      listed: 0,
      cleared: 0,
      retained: 0,
      retainedReason: null,
      respawnDeadlineUtc: null,
      shouldSpawn: true,
      selfLogin: null,
    };
  }

  const reviews = await listPullRequestReviews({ repo, prNumber, token, fetchImpl, log });
  const pendingMine = pendingReviewsOwnedBy(reviews, selfLogin);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const currentHead = String(currentHeadSha || '').trim() || null;
  const maxFreshDeadlineMs = { value: null };
  let cleared = 0;
  let retained = 0;

  for (const pending of pendingMine) {
    const pendingHeadSha = String(pending?.commit_id || pending?.commitId || '').trim() || null;
    const createdAtMs = Date.parse(pending?.created_at || pending?.createdAt || '');
    const deadlineMs = Number.isFinite(createdAtMs) && Number.isFinite(respawnAgeSeconds)
      ? createdAtMs + (respawnAgeSeconds * 1000)
      : NaN;
    const currentHeadFresh = (
      currentHead &&
      pendingHeadSha === currentHead &&
      Number.isFinite(deadlineMs) &&
      Number.isFinite(nowMs) &&
      deadlineMs > nowMs
    );

    if (currentHeadFresh) {
      retained += 1;
      if (maxFreshDeadlineMs.value === null || deadlineMs > maxFreshDeadlineMs.value) {
        maxFreshDeadlineMs.value = deadlineMs;
      }
      continue;
    }

    if (await deletePendingReview({
      repo,
      prNumber,
      reviewId: pending?.id,
      token,
      fetchImpl,
      log,
    })) {
      cleared += 1;
    }
  }

  return {
    listed: pendingMine.length,
    cleared,
    retained,
    retainedReason: retained > 0 ? 'current-head-fresh-draft' : null,
    respawnDeadlineUtc: Number.isFinite(maxFreshDeadlineMs.value)
      ? new Date(maxFreshDeadlineMs.value).toISOString()
      : null,
    shouldSpawn: retained === 0,
    selfLogin,
  };
}

export {
  clearPendingReviewsForSelf,
  reconcilePendingReviewsForSelf,
};

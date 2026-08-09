// Candidate selection for the proactive merge-agent stuck-dispatch scan.
//
// This stays separate from the scan's dispatch-audit/HQ interpretation so the
// orchestration module can remain a thin caller. Lifecycle cleanup is local
// retry state, never enough on its own to establish that a PR is still active.

function candidateKey(candidate) {
  return `${candidate.repo}#${Number(candidate.prNumber)}`;
}

function isUsableCandidate(candidate, repo) {
  return Boolean(
    candidate?.repo
    && candidate?.prNumber != null
    && candidate?.headSha
    && (!repo || candidate.repo === repo)
  );
}

function normalizedCandidate(candidate) {
  return {
    repo: candidate.repo,
    prNumber: Number(candidate.prNumber),
    headSha: candidate.headSha,
  };
}

// Select dispatch heads that are allowed to enter the expensive stale-dispatch
// classifier. A label-add cleanup covers only GitHub label-write lag, so it must
// match a same-tick current/open PR head; otherwise a merged PR's retry sidecar
// would resurrect its historical LRQ as a false alert.
export function collectStuckMergeAgentCandidateHeads({
  activePRs = [],
  currentPRs = [],
  lifecycleCleanups = [],
  repo = null,
  isEligibleCleanup = () => false,
} = {}) {
  const eligibleHeadsByKey = new Map();
  for (const activePR of activePRs) {
    if (!isUsableCandidate(activePR, repo)) continue;
    eligibleHeadsByKey.set(candidateKey(activePR), normalizedCandidate(activePR));
  }

  const currentHeadsByKey = new Map();
  for (const currentPR of currentPRs) {
    if (!isUsableCandidate(currentPR, repo)) continue;
    currentHeadsByKey.set(candidateKey(currentPR), String(currentPR.headSha));
  }

  for (const cleanup of lifecycleCleanups) {
    if (!isEligibleCleanup(cleanup) || !isUsableCandidate(cleanup, repo)) continue;
    const key = candidateKey(cleanup);
    if (currentHeadsByKey.get(key) !== String(cleanup.headSha)) continue;
    if (!eligibleHeadsByKey.has(key)) {
      eligibleHeadsByKey.set(key, normalizedCandidate(cleanup));
    }
  }
  return eligibleHeadsByKey;
}

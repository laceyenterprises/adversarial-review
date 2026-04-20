import { buildMalformedTitleFailureComment } from './watcher-title-guardrails.mjs';

async function signalMalformedTitleFailure(octokit, { repoPath, owner, repo, prNumber, prTitle }) {
  const structuredFailure = {
    repo: repoPath,
    prNumber,
    title: prTitle,
    reason: 'missing-or-invalid-creation-time-reviewer-tag',
  };
  console.error(`[watcher] MALFORMED_PR_TITLE ${JSON.stringify(structuredFailure)}`);

  const body = buildMalformedTitleFailureComment({ prTitle });

  try {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });
    console.error(`[watcher] Fail-loud comment posted for ${repoPath}#${prNumber}`);
  } catch (err) {
    console.error(`[watcher] Failed to post malformed-title comment for ${repoPath}#${prNumber}:`, err.message);
  }
}

export {
  signalMalformedTitleFailure,
};

// A correct refusal to post an obsolete review asks the watcher to review the
// current head. It is distinct from command/auth failures and costs no attempt.
export const STALE_REVIEW_HEAD_EXIT_CODE = 75;

// Reserved for our size preflight, never inferred from untrusted model output.
export const REVIEWER_PROMPT_TOO_LARGE_EXIT_CODE = 76;

export class ReviewerPromptTooLargeError extends Error {
  constructor(message) {
    super(`[reviewer-prompt-too-large] ${message}`);
    this.name = 'ReviewerPromptTooLargeError';
  }
}

export function reviewerExecutionFailureExitCode(error) {
  return error instanceof ReviewerPromptTooLargeError ? REVIEWER_PROMPT_TOO_LARGE_EXIT_CODE : 1;
}

export function reviewerPostFailureExitCode(error) {
  return error?.failureClass === 'stale-review-head' ? STALE_REVIEW_HEAD_EXIT_CODE : 1;
}

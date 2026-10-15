// A correct refusal to post an obsolete review asks the watcher to review the
// current head. It is distinct from command/auth failures and costs no attempt.
export const STALE_REVIEW_HEAD_EXIT_CODE = 75;

// Reserved for our size preflight, never inferred from untrusted model output.
export const REVIEWER_PROMPT_TOO_LARGE_EXIT_CODE = 76;
export const REVIEWER_CHUNK_BUDGET_EXCEEDED_EXIT_CODE = 77;

export class ReviewerChunkBudgetExceededError extends Error {
  constructor(plan) {
    super(`[reviewer-chunk-budget-exceeded] chunks=${plan.chunkCount} perChunkTimeoutMs=${plan.perChunkTimeoutMs} requiredMs=${plan.requiredMs} capMs=${plan.capMs} promptBytes=${plan.promptBytes ?? 'unknown'}`);
    this.name = 'ReviewerChunkBudgetExceededError';
    this.plan = plan;
  }
}

export class ReviewerPromptTooLargeError extends Error {
  constructor(message) {
    super(`[reviewer-prompt-too-large] ${message}`);
    this.name = 'ReviewerPromptTooLargeError';
  }
}

export function reviewerExecutionFailureExitCode(error) {
  if (error instanceof ReviewerChunkBudgetExceededError) return REVIEWER_CHUNK_BUDGET_EXCEEDED_EXIT_CODE;
  return error instanceof ReviewerPromptTooLargeError ? REVIEWER_PROMPT_TOO_LARGE_EXIT_CODE : 1;
}

export function reviewerPostFailureExitCode(error) {
  return error?.failureClass === 'stale-review-head' ? STALE_REVIEW_HEAD_EXIT_CODE : 1;
}

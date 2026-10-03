// A correct refusal to post an obsolete review asks the watcher to review the
// current head. It is distinct from command/auth failures and costs no attempt.
export const STALE_REVIEW_HEAD_EXIT_CODE = 75;

export function reviewerPostFailureExitCode(error) {
  return error?.failureClass === 'stale-review-head' ? STALE_REVIEW_HEAD_EXIT_CODE : 1;
}

import { awaitThrottleIfNeeded, githubCredential, withGitHubBudgetScope } from './rate-limit-throttle.mjs';

export const REVIEWER_GITHUB_BUDGET_DEFERRED_EXIT_CODE = 79;
export const REVIEWER_GITHUB_BUDGET_DEFERRED = 'github-budget-deferred';
const PREFIX = '[reviewer-github-budget-deferred] ';

// Optional enrichment may catch a failed read. It must still prevent a model
// pass after admission has refused any of its required GitHub budgets.
// An optional second argument supplies { env } for the sending credential.
export function runReviewerPreModel(prepare) {
  return withGitHubBudgetScope({}, async scope => {
    try {
      const prepared = await prepare();
      if (scope.budgetDeferral) throw scope.budgetDeferral;
      // The final successful read can itself spend the last unit. Do not pay
      // for a model pass that already lacks the budget needed to deliver it.
      const options = arguments[1] || {};
      const credential = githubCredential(options);
      for (const resource of ['core', 'graphql']) await awaitThrottleIfNeeded(resource, credential, options);
      return prepared;
    } catch (error) {
      const deferral = scope.budgetDeferral || error;
      if (deferral?.budgetDeferred) deferral.reviewerPreModelBudgetDeferred = true;
      throw deferral;
    }
  });
}

export function reviewerBudgetDeferralReceipt(error) {
  return PREFIX + JSON.stringify({
    resource: error.observation.resource,
    resetAt: error.observation.resetAt,
    remaining: error.observation.remaining,
    credential: error.credential,
  });
}

export function parseReviewerBudgetDeferral(text) {
  for (const line of String(text || '').split(/\r?\n/).reverse()) {
    if (!line.startsWith(PREFIX)) continue;
    try {
      const value = JSON.parse(line.slice(PREFIX.length));
      if (['core', 'graphql'].includes(value.resource)
        && Number.isFinite(Date.parse(value.resetAt))
        && typeof value.credential === 'string'
        && Number.isInteger(value.remaining) && value.remaining >= 0) return value;
    } catch { /* An incomplete receipt is not a typed refusal. */ }
  }
  return null;
}

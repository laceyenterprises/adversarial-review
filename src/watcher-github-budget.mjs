import { resolveThrottleFloor, withGitHubBudgetScope, isGitHubRateLimitError } from './rate-limit-throttle.mjs';

// Scheduling only. A durable success is a priority hint; serve must refresh the
// live head, state and all existing merge predicates before taking action.
async function runLowBudgetClosingTick({ budgets, rows, isReady, serve, logger = console, floor = resolveThrottleFloor() }) {
  const low = Object.values(budgets).filter(bucket => bucket.remaining < floor);
  if (!low.length) return false;
  logger.log(`[watcher] GitHub budget: ${low.map(bucket => `${bucket.resource} remaining=${bucket.remaining} reset=${bucket.resetAt}`).join('; ')}; deferring non-urgent reads`);
  for (const row of rows.filter(isReady)) {
    await withGitHubBudgetScope({ urgent: true }, async () => {
      try { await serve(row); }
      catch (err) {
        if (!isGitHubRateLimitError(err) && !err?.budgetDeferred) logger.error('[watcher] closing read failed:', err.message);
      }
    });
  }
  return true;
}

export { runLowBudgetClosingTick };

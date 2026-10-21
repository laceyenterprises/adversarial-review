import { boundedDiagnostics } from './producer-contracts/diagnostics.mjs';
// One breadcrumb per candidate's grounding transition, before claim/dispatch.
export function createReviewerQuotaBlockLogger() {
  const states = new Map();
  return ({ repoPath, prNumber, route, logger = console }) => {
    const key = JSON.stringify([repoPath, prNumber]);
    if (!route?.quotaBlocked) {
      states.delete(key);
      return false;
    }
    const grounding = route.quotaGrounding || {};
    const reviewer = grounding.reviewer || route.reviewerModel;
    const source = grounding.source || 'fleet-quota-status';
    const state = grounding.state || 'unknown';
    const reason = grounding.reason || 'no-allowed-reviewer-available';
    const diagnostic = boundedDiagnostics(grounding.diagnostics).join('; ');
    const signature = JSON.stringify([reviewer, source, state, reason]);
    if (states.get(key) !== signature) {
      logger.warn?.(`[watcher] reviewer-route DEFERRED repo=${repoPath} pr=${prNumber} `
        + `reviewer=${reviewer} source=${source} state=${state} reason=${reason}${diagnostic ? ` diagnostic=${diagnostic}` : ''}; no review attempt spent`);
      states.set(key, signature);
    }
    return true;
  };
}

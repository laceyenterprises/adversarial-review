import { boundedDiagnostics } from './producer-contracts/diagnostics.mjs';
export const REVIEWER_FLOOR_HOLD_SIGNAL_MS = 15 * 60 * 1000;
// One breadcrumb per candidate's grounding transition, before claim/dispatch.
export function createReviewerQuotaBlockLogger({ now = Date.now } = {}) {
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
    // Preserve diagnostic-field transitions without keying on free-form values.
    const diagnosticFields = [...new Set(boundedDiagnostics(grounding.diagnostics).map(value =>
      value.match(/^(?:[\w.]+:\s*)?[\w$.[\]-]+/)?.[0]?.trim() || 'unknown'))].sort();
    const signature = JSON.stringify([reviewer, source, state, reason, diagnosticFields]);
    const previous = states.get(key);
    const floorHeld = reason === 'primary-personal-anthropic-reserve-floor:no-eligible-reviewer';
    const observedAt = now();
    const floorSince = floorHeld ? (previous?.floorSince ?? observedAt) : null;
    let floorSignaled = floorHeld && previous?.floorSignaled === true;
    if (previous?.signature !== signature) {
      logger.warn?.(`[watcher] reviewer-route DEFERRED repo=${repoPath} pr=${prNumber} `
        + `reviewer=${reviewer} source=${source} state=${state} reason=${reason}${diagnostic ? ` diagnostic=${diagnostic}` : ''}; no review attempt spent`);
    }
    if (floorHeld && !floorSignaled && observedAt - floorSince >= REVIEWER_FLOOR_HOLD_SIGNAL_MS) {
      logger.error?.(`[watcher] reviewer-reserve-floor SUSTAINED_HOLD repo=${repoPath} pr=${prNumber} `
        + `reviewer=${reviewer} heldMs=${observedAt - floorSince} reason=${reason}; inspect reserve capacity and Gemini eligibility`);
      floorSignaled = true;
    }
    states.set(key, { signature, floorSince, floorSignaled });
    return true;
  };
}

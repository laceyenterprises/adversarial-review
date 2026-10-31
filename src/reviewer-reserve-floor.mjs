import { reserveFloorWeeklyMeasurement } from './fleet-quota-status.mjs';

// Reviewer-only policy over the canonical fleet projection. Do not change the
// reserve owner's protected-class exemptions for hammers/responders/builders.
export function personalClaudeReviewerFloor(payload, { workerClass = 'claude-reviewer' } = {}) {
  if (workerClass !== 'claude-reviewer') return null;
  const floor = payload?.reserveFloors?.['anthropic-oauth'];
  const threshold = floor?.remainingPct;
  const weekly = reserveFloorWeeklyMeasurement(floor);
  const rows = Array.isArray(payload?.providerStatuses) ? payload.providerStatuses : [];
  const row = rows.find(entry => String(entry?.provider || '').trim().toLowerCase() === 'anthropic'
    && String(entry?.authPath || entry?.auth_path || '').trim().toLowerCase() === 'oauth');
  // Missing/stale evidence cannot turn a configured preference into a refusal.
  // The producer owns freshness and weekly-window selection; do not refresh
  // timestamps or substitute the short-window measurement here.
  if (!row || row.cachedEvidenceStale === true || weekly?.status !== 'measured'
    || weekly.inferred === true || weekly.confidence === 'stale'
    || !Number.isFinite(threshold) || threshold <= 0 || threshold > 100
    || !Number.isFinite(weekly.percentRemaining)
    || weekly.percentRemaining < 0 || weekly.percentRemaining > threshold) return null;
  return {
    reason: `personal-anthropic-reserve-floor:remaining=${weekly.percentRemaining}<=floor=${threshold}`,
    remainingPct: weekly.percentRemaining,
    floorPct: threshold,
    source: 'hq-fleet-quota-status',
  };
}

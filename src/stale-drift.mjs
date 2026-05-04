const STALE_DRIFT_STOP_CODE = 'stale-drift';

function normalizeLabelNames(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      if (entry && typeof entry.name === 'string') return entry.name.trim();
      return '';
    })
    .filter(Boolean);
}

function hasStaleDriftLabel(labels) {
  return normalizeLabelNames(labels).includes('stale-drift');
}

function shouldSkipReviewerForStaleDrift(pr) {
  if (!hasStaleDriftLabel(pr?.labels)) return null;
  return {
    action: 'reviewer',
    reason: 'stale-drift',
    message: `[watcher] Skipping reviewer for #${pr?.number}: stale-drift label set`,
  };
}

function staleDriftStopDecision(lifecycle, { prNumber, site } = {}) {
  if (site !== 'consume') return null;
  if (lifecycle?.prState !== 'open') return null;
  if (!hasStaleDriftLabel(lifecycle?.labels)) return null;
  return {
    stopCode: STALE_DRIFT_STOP_CODE,
    actionReason: 'stale-drift',
    workerState: 'never-spawned',
    stopReason: `PR #${prNumber} carries the stale-drift label; skipping remediation spawn.`,
    logMessage: `[watcher] Skipping remediation for #${prNumber}: stale-drift label set`,
  };
}

export {
  hasStaleDriftLabel,
  normalizeLabelNames,
  STALE_DRIFT_STOP_CODE,
  shouldSkipReviewerForStaleDrift,
  staleDriftStopDecision,
};

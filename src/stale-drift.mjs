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

function staleDriftStopDecision(lifecycle, { prNumber } = {}) {
  if (!hasStaleDriftLabel(lifecycle?.labels)) return null;
  return {
    stopCode: 'stale-drift',
    actionReason: 'stale-drift',
    workerState: 'never-spawned',
    stopReason: `PR #${prNumber} carries the stale-drift label; skipping remediation spawn.`,
    logMessage: `[watcher] Skipping remediation for #${prNumber}: stale-drift label set`,
  };
}

export {
  hasStaleDriftLabel,
  normalizeLabelNames,
  shouldSkipReviewerForStaleDrift,
  staleDriftStopDecision,
};

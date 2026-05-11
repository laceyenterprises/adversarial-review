/**
 * GitHub PR stale-head guards for the code-pr subject adapter.
 *
 * @typedef {import('../../../kernel/contracts.d.ts').SubjectState} SubjectState
 */

function normalizeLabelNames(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim().toLowerCase();
      if (entry && typeof entry.name === 'string') return entry.name.trim().toLowerCase();
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
  if (!hasStaleDriftLabel(lifecycle?.labels)) return null;
  const renderedPrNumber = prNumber == null ? 'unknown' : prNumber;
  return {
    stopCode: 'stale-drift',
    actionReason: 'stale-drift',
    workerState: site === 'consume' ? 'never-spawned' : 'stopped-stale-drift',
    stopReason: site === 'consume'
      ? `PR #${renderedPrNumber} carries the stale-drift label; skipping remediation spawn.`
      : `PR #${renderedPrNumber} carries the stale-drift label; stopping remediation after the worker already ran.`,
    logMessage: `[watcher] Skipping remediation for #${renderedPrNumber}: stale-drift label set`,
  };
}

export {
  hasStaleDriftLabel,
  normalizeLabelNames,
  shouldSkipReviewerForStaleDrift,
  staleDriftStopDecision,
};

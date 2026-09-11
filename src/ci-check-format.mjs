const DEFAULT_MAX_FORMATTED_CI_CHECKS = 10;

function formatCiCheckList(checks, { maxChecks = DEFAULT_MAX_FORMATTED_CI_CHECKS } = {}) {
  const normalized = Array.isArray(checks) ? checks : [];
  if (normalized.length === 0) return 'none';
  const limit = Number.isInteger(maxChecks) && maxChecks > 0
    ? maxChecks
    : DEFAULT_MAX_FORMATTED_CI_CHECKS;
  const rendered = normalized
    .slice(0, limit)
    .map((check) => `${check?.name || 'unknown-check'}=${check?.state || 'UNKNOWN'}`);
  const overflow = normalized.length - limit;
  if (overflow > 0) {
    rendered.push(`... (+${overflow} more)`);
  }
  return rendered.join(', ');
}

export {
  DEFAULT_MAX_FORMATTED_CI_CHECKS,
  formatCiCheckList,
};

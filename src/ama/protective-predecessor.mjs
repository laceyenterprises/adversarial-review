const PROTECTIVE_PREDECESSOR_TRAILER = 'Protects-Against-Unsafe-Merge-Until-PR';

function normalizePrNumber(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/^#?([1-9][0-9]*)$/u);
  if (!match) return null;
  const prNumber = Number(match[1]);
  return Number.isSafeInteger(prNumber) ? prNumber : null;
}

export function parseProtectivePredecessorDeclaration(body) {
  const text = String(body || '');
  if (!text.trim()) return null;
  const pattern = new RegExp(
    `^\\s*${PROTECTIVE_PREDECESSOR_TRAILER}\\s*:\\s*#?([1-9][0-9]*)\\s*$`,
    'imu',
  );
  const match = text.match(pattern);
  if (!match) return null;
  const prNumber = normalizePrNumber(match[1]);
  if (!prNumber) return null;
  return {
    trailer: PROTECTIVE_PREDECESSOR_TRAILER,
    protectorPrNumber: prNumber,
  };
}

export function normalizeProtectivePredecessorDeclaration(value) {
  if (!value) return null;
  if (typeof value === 'number' || typeof value === 'string') {
    const prNumber = normalizePrNumber(value);
    return prNumber
      ? { trailer: PROTECTIVE_PREDECESSOR_TRAILER, protectorPrNumber: prNumber }
      : null;
  }
  if (typeof value !== 'object') return null;
  const prNumber = normalizePrNumber(
    value.protectorPrNumber ?? value.protector_pr_number ?? value.prNumber ?? value.pr,
  );
  if (!prNumber) return null;
  return {
    trailer: String(value.trailer || PROTECTIVE_PREDECESSOR_TRAILER),
    protectorPrNumber: prNumber,
    reason: value.reason ? String(value.reason) : null,
  };
}

export function resolveProtectivePredecessorDeclaration({ prBody, explicit } = {}) {
  return normalizeProtectivePredecessorDeclaration(explicit)
    || parseProtectivePredecessorDeclaration(prBody);
}

export function isProtectorOpen(protectorState) {
  const state = String(protectorState?.state ?? protectorState?.prState ?? '').trim().toUpperCase();
  if (state === 'OPEN') return true;
  if (protectorState?.isOpen === true) return true;
  return false;
}

export function protectivePredecessorMergeWindowFinding({
  repo,
  dependentPrNumber,
  protectorPrNumber,
  reason = null,
}) {
  return {
    kind: 'protective-predecessor-open-after-dependent-merge',
    severity: 'high',
    repo: String(repo || ''),
    dependentPrNumber: Number(dependentPrNumber),
    protectorPrNumber: Number(protectorPrNumber),
    reason:
      reason ||
      `PR #${dependentPrNumber} declared PR #${protectorPrNumber} as its protective predecessor, but the dependent merged while the protector was still open.`,
  };
}

export function hasMergedDependentProtectingPr({
  repo,
  prNumber,
  mergedDependents = [],
} = {}) {
  const target = Number(prNumber);
  if (!Number.isInteger(target) || target <= 0) return null;
  for (const dependent of Array.isArray(mergedDependents) ? mergedDependents : []) {
    const declaration = normalizeProtectivePredecessorDeclaration(
      dependent.protectivePredecessor || dependent.protective_predecessor || dependent,
    );
    if (!declaration || declaration.protectorPrNumber !== target) continue;
    const state = String(dependent.state ?? dependent.prState ?? '').trim().toUpperCase();
    const merged = state === 'MERGED' || dependent.merged === true || Boolean(dependent.mergedAt || dependent.merged_at);
    if (!merged) continue;
    const dependentRepo = String(dependent.repo || repo || '');
    if (repo && dependentRepo && dependentRepo !== String(repo)) continue;
    return {
      repo: dependentRepo,
      dependentPrNumber: Number(dependent.prNumber ?? dependent.pr_number),
      protectorPrNumber: target,
      declaration,
    };
  }
  return null;
}

export const __testables__ = Object.freeze({
  PROTECTIVE_PREDECESSOR_TRAILER,
  normalizePrNumber,
});

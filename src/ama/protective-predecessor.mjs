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
    'imgu',
  );
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) return null;
  const protectors = [];
  for (const match of matches) {
    const prNumber = normalizePrNumber(match[1]);
    if (prNumber && !protectors.includes(prNumber)) protectors.push(prNumber);
  }
  if (protectors.length === 0) return null;
  return {
    trailer: PROTECTIVE_PREDECESSOR_TRAILER,
    protectorPrNumber: protectors[0],
    protectorPrNumbers: protectors,
  };
}

export function findMalformedProtectivePredecessorLines(body) {
  return String(body || '')
    .split(/\r?\n/u)
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => (
      new RegExp(`^\\s*${PROTECTIVE_PREDECESSOR_TRAILER}\\s*:`, 'iu').test(line)
      && !new RegExp(
        `^\\s*${PROTECTIVE_PREDECESSOR_TRAILER}\\s*:\\s*#?([1-9][0-9]*)\\s*$`,
        'iu',
      ).test(line)
    ))
    .map(({ line, lineNumber }) => ({
      lineNumber,
      line: String(line || '').slice(0, 300),
    }));
}

export function normalizeProtectivePredecessorDeclaration(value) {
  if (!value) return null;
  if (typeof value === 'number' || typeof value === 'string') {
    const prNumber = normalizePrNumber(value);
    return prNumber
      ? {
          trailer: PROTECTIVE_PREDECESSOR_TRAILER,
          protectorPrNumber: prNumber,
          protectorPrNumbers: [prNumber],
        }
      : null;
  }
  if (typeof value !== 'object') return null;
  const prNumber = normalizePrNumber(
    value.protectorPrNumber ?? value.protector_pr_number ?? value.prNumber ?? value.pr,
  );
  if (!prNumber) return null;
  const protectorPrNumbers = Array.isArray(value.protectorPrNumbers)
    ? value.protectorPrNumbers.map(normalizePrNumber).filter(Boolean)
    : [];
  if (!protectorPrNumbers.includes(prNumber)) protectorPrNumbers.unshift(prNumber);
  return {
    trailer: String(value.trailer || PROTECTIVE_PREDECESSOR_TRAILER),
    protectorPrNumber: prNumber,
    protectorPrNumbers,
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
  outcome = 'merged-while-open',
  reason = null,
  detail = null,
}) {
  const normalizedOutcome = String(outcome || '').trim() || 'merged-while-open';
  const dependent = Number(dependentPrNumber);
  const protector = Number(protectorPrNumber);
  const defaultReason = (() => {
    if (normalizedOutcome === 'held-before-merge') {
      return `PR #${dependent} declared PR #${protector} as its protective predecessor; merge was held while the protector remained open.`;
    }
    if (normalizedOutcome === 'state-unreadable') {
      return `PR #${dependent} declared PR #${protector} as its protective predecessor, but the protector state could not be read.`;
    }
    if (normalizedOutcome === 'not-found') {
      return `PR #${dependent} declared PR #${protector} as its protective predecessor, but that protector PR could not be found.`;
    }
    if (normalizedOutcome === 'malformed-trailer') {
      return `PR #${dependent} contains a malformed protective predecessor trailer; merge was held until the body is corrected.`;
    }
    return `PR #${dependent} declared PR #${protector} as its protective predecessor, but the dependent merged while the protector was still open.`;
  })();
  return {
    kind: (() => {
      if (normalizedOutcome === 'held-before-merge') return 'protective-predecessor-open-held-before-merge';
      if (normalizedOutcome === 'state-unreadable') return 'protective-predecessor-state-unreadable';
      if (normalizedOutcome === 'not-found') return 'protective-predecessor-not-found';
      if (normalizedOutcome === 'malformed-trailer') return 'protective-predecessor-malformed-trailer';
      return 'protective-predecessor-open-after-dependent-merge';
    })(),
    severity: 'high',
    repo: String(repo || ''),
    dependentPrNumber: dependent,
    protectorPrNumber: protector,
    outcome: normalizedOutcome,
    reason: reason || defaultReason,
    ...(detail ? { detail } : {}),
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
      dependent.protectivePredecessor || dependent.protective_predecessor,
    );
    if (!declaration || !declaration.protectorPrNumbers?.includes(target)) continue;
    const dependentPrNumber = normalizePrNumber(dependent.prNumber ?? dependent.pr_number);
    if (!dependentPrNumber || dependentPrNumber === target) continue;
    const state = String(dependent.state ?? dependent.prState ?? '').trim().toUpperCase();
    const merged = state === 'MERGED' || dependent.merged === true || Boolean(dependent.mergedAt || dependent.merged_at);
    if (!merged) continue;
    const dependentRepo = String(dependent.repo || repo || '');
    if (repo && dependentRepo && dependentRepo !== String(repo)) continue;
    return {
      repo: dependentRepo,
      dependentPrNumber,
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

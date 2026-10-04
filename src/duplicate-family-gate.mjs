export const DUPLICATE_FAMILY_LABEL = 'duplicate-family';
export const DUPLICATE_FAMILY_HOLD_LABEL = 'duplicate-family-hold';
export const DUPLICATE_FAMILY_UNRESOLVED_REASON = 'duplicate-family-unresolved';

function parseOverride(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function evaluateDuplicateFamilyCandidate(family = null, {
  prNumber = null,
  headSha = null,
} = {}) {
  if (!family) return { member: false, held: false, reason: null, release: null };

  const status = String(family.status || '').trim().toLowerCase();
  if (status === 'inactive' || status === 'resolved') {
    return { member: true, held: false, reason: null, release: status };
  }

  const override = parseOverride(family.operator_override_json);
  const ignored = Array.isArray(override.ignoredCandidates) ? override.ignoredCandidates : [];
  const currentIgnore = ignored.find((entry) => (
    Number(entry?.candidatePrNumber) === Number(prNumber)
    && String(entry?.candidateHeadSha || '') === String(headSha || '')
    && entry?.stale !== true
  ));
  if (currentIgnore) {
    return { member: true, held: false, reason: null, release: 'ignored-not-duplicate' };
  }

  // Content heuristics qualify detection, never override operator adjudication.
  let pending = false;
  if (status === 'advisory') {
    const evidence = parseOverride(family.content_evidence_json);
    const pairs = (evidence.pairs || []).filter((pair) => pair.members?.some((member) =>
      Number(member.prNumber) === Number(prNumber)
      && String(member.headSha || '') === String(headSha || '')));
    pending = pairs.some((pair) => pair.pending === true);
    if (!pairs.some((pair) => pair.corroborated === true || (pair.pending === true && pair.held === true))) {
      return { member: true, held: false, reason: null,
        release: pending ? 'content-pending' : 'identity-only-advisory', ...(pending ? { pending: true } : {}) };
    }
  }

  const selection = override.selection || (
    override.transition === 'survivor-selected' ? override : null
  );
  if (
    (status === 'survivor-selected' || status === 'survivor-merged')
    && Number(family.selected_survivor_pr_number) === Number(prNumber)
    && Number(selection?.candidatePrNumber) === Number(prNumber)
    && String(selection?.candidateHeadSha || '') === String(headSha || '')
    && String(selection?.reportVerifiedHeadSha || '') === String(headSha || '')
    && String(selection?.reportPath || family.report_path || '').trim()
    && selection?.stale !== true
  ) {
    return { member: true, held: false, reason: null, release: status };
  }

  return {
    member: true,
    held: true,
    reason: DUPLICATE_FAMILY_UNRESOLVED_REASON,
    release: null,
    ...(pending ? { pending: true } : {}),
  };
}

export function labelsContainDuplicateFamilyHold(labels) {
  return (Array.isArray(labels) ? labels : []).some((label) => (
    String(typeof label === 'string' ? label : label?.name || '').trim().toLowerCase() ===
    DUPLICATE_FAMILY_HOLD_LABEL
  ));
}

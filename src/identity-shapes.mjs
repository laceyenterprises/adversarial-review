const CODE_PR_DOMAIN_ID = 'code-pr';

function normalizePrNumber(prNumber) {
  const normalized = Number(prNumber);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

function makeCodePrSubjectExternalId(repo, prNumber) {
  const normalizedRepo = String(repo ?? '').trim();
  const normalizedPrNumber = normalizePrNumber(prNumber);
  if (!normalizedRepo || !normalizedPrNumber) return null;
  return `${normalizedRepo}#${normalizedPrNumber}`;
}

// Generic subject identity — no domain is assumed. A partial identity (missing
// subjectExternalId or domainId) collapses domainId to null so downstream
// identity/delivery keys stay well-formed. ARC-03: this primitive carries no
// hardcoded `code-pr` fallback; callers thread the domain that owns the subject.
function buildSubjectIdentity({ domainId = null, subjectExternalId = null, revisionRef = null } = {}) {
  const normalizedSubjectExternalId = subjectExternalId || null;
  return {
    domainId: normalizedSubjectExternalId && domainId ? domainId : null,
    subjectExternalId: normalizedSubjectExternalId,
    revisionRef: revisionRef || null,
  };
}

// code-pr-scoped convenience over buildSubjectIdentity. The domain is an
// explicit, overridable parameter (defaulting to the code-pr domain id for the
// code-pr call sites) rather than a silent fallback baked into the generic path.
function buildCodePrSubjectIdentity({ repo, prNumber, revisionRef = null, domainId = CODE_PR_DOMAIN_ID } = {}) {
  return buildSubjectIdentity({
    domainId,
    subjectExternalId: makeCodePrSubjectExternalId(repo, prNumber),
    revisionRef,
  });
}

function buildDeliveryKey({
  repo,
  prNumber,
  revisionRef = null,
  round = null,
  kind,
  noticeRef = null,
  domainId = CODE_PR_DOMAIN_ID,
} = {}) {
  const identity = buildCodePrSubjectIdentity({ repo, prNumber, revisionRef, domainId });
  return {
    ...identity,
    round: Number.isInteger(Number(round)) && Number(round) >= 0 ? Number(round) : null,
    kind: kind || null,
    noticeRef: noticeRef || null,
  };
}

export {
  CODE_PR_DOMAIN_ID,
  buildCodePrSubjectIdentity,
  buildDeliveryKey,
  buildSubjectIdentity,
  makeCodePrSubjectExternalId,
};

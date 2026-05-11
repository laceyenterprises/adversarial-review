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

function buildCodePrSubjectIdentity({ repo, prNumber, revisionRef = null } = {}) {
  const subjectExternalId = makeCodePrSubjectExternalId(repo, prNumber);
  return {
    domainId: subjectExternalId ? CODE_PR_DOMAIN_ID : null,
    subjectExternalId,
    revisionRef: revisionRef || null,
  };
}

function buildDeliveryKey({
  repo,
  prNumber,
  revisionRef = null,
  round = null,
  kind,
  noticeRef = null,
} = {}) {
  const identity = buildCodePrSubjectIdentity({ repo, prNumber, revisionRef });
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
  makeCodePrSubjectExternalId,
};

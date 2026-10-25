import { appendAmaAuditAttempt, readAmaAuditEntry } from './audit.mjs';
import { exactHammerValidation, hammerRangeMatches } from './hammer-head-validation.mjs';

export const RECOVERED_ATTESTATION_MARKER = '<!-- hq:ham-recovered-attestation -->';
const fullSha = value => /^[a-f0-9]{40}$/.test(value || '');
const normalizeLogin = value => String(value || '').toLowerCase().replace(/\[bot\]$/, '');

function trustedIdentity(identity, head) {
  return Number.isSafeInteger(identity?.databaseId) && identity.databaseId > 0
    && exactHammerValidation({ author: identity.login, body: `HAM-Validated-Head: ${head}` }, head);
}

// Called only after the in-lease range proof and local/remote head comparison.
// Persist a fixed summary, never stderr, tokens, arbitrary bodies or findings.
export function recordPendingAttestation({ hqRoot, repo, prNumber, baseHead, validatedHead, identity, range, counts }) {
  if (!fullSha(baseHead) || !fullSha(validatedHead) || !trustedIdentity(identity, validatedHead)
    || !hammerRangeMatches(range, baseHead, validatedHead)
    || !['total', 'blocking', 'nonBlocking'].every(key => Number.isSafeInteger(counts?.[key]) && counts[key] >= 0)
    || counts.total !== counts.blocking + counts.nonBlocking) throw new Error('invalid pending hammer attestation');
  return appendAmaAuditAttempt({ hqRoot, repo, prNumber, headSha: validatedHead,
    metadata: { closureAuthority: 'ham-terminal-remediation' },
    attempt: { outcome: 'deferred', attemptPhase: 'hammer-audit-comment', reason: 'audit-comment-unavailable',
      ...(process.env.HQ_LAUNCH_REQUEST_ID ? { launchRequestId: process.env.HQ_LAUNCH_REQUEST_ID } : {}),
      pendingAttestation: { baseHead, validatedHead,
        identity: { login: normalizeLogin(identity.login), databaseId: identity.databaseId },
        validationSummary: { rangeVerified: true, ...Object.fromEntries(['total', 'blocking', 'nonBlocking'].map(key => [key, counts[key]])) } } } });
}

export function pendingAttestationBody({ hqRoot, repo, prNumber, reviewedHead, currentHead, identity }) {
  if (!fullSha(reviewedHead) || !fullSha(currentHead)) return '';
  const audit = readAmaAuditEntry(hqRoot, repo, prNumber, currentHead);
  if (!audit) return '';
  if (audit.repo !== repo || audit.prNumber !== Number(prNumber) || audit.headSha !== currentHead) return '';
  const edge = audit.attempts?.findLast(attempt => attempt.attemptPhase === 'hammer-audit-comment'
    && attempt.outcome === 'deferred' && attempt.pendingAttestation)?.pendingAttestation;
  if (!edge || edge.baseHead !== reviewedHead || edge.validatedHead !== currentHead
    || !trustedIdentity(identity, currentHead)
    || edge.identity?.databaseId !== identity.databaseId
    || edge.identity?.login !== normalizeLogin(identity.login)
    || edge.validationSummary?.rangeVerified !== true) return '';
  return `${RECOVERED_ATTESTATION_MARKER}\nRecovered the hammer's previously validated edge after audit comment delivery failed.\n`
    + `HAM-Base-Head: ${edge.baseHead}\nHAM-Validated-Head: ${edge.validatedHead}\n`;
}

// CLOSERGATES-01: a closer that pushed and validated a head, then ran out of
// budget on a transient closure-gate read, records a closure-resume receipt.
// The next launch on that SAME head runs only the closure gates and the merge.
// It does no remediation and no re-validation.
//
// The receipt is an AMA audit attempt in the head-keyed audit file, so a moved
// head can never see it: a different head has a different file. A receipt is
// live only while it is the latest settled attempt for its head. Any later
// merge, refusal or other deferral supersedes it.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendAmaAuditAttempt, readAmaAuditEntry } from './audit.mjs';

export const CLOSURE_RESUME_REASON = 'closure-gate-read-unavailable';
export const CLOSURE_RESUME_PHASE = 'hammer-closure-resume';
export const CLOSURE_RESUME_FILE = 'closure-resume.json';
const SHA = /^[a-f0-9]{40}$/i;
const SETTLED = new Set(['succeeded', 'failed-without-merge', 'superseded', 'deferred']);

// Only a head whose validation audit this run published is a validated head:
// hammer-publish exports HAM_PUBLISHED_AUDIT_HEAD after the entitled audit with
// `HAM-Validated-Head` lands, and clears it whenever the head moves.
export function closureResumeEvidence(env = process.env) {
  const validatedHead = env.POST_REMEDIATION_SHA;
  if (!SHA.test(validatedHead || '') || env.HAM_PUBLISHED_AUDIT_HEAD !== validatedHead) return null;
  if (!SHA.test(env.HAM_REVIEWED_SHA || '')) return null;
  const body = String(env.HAM_AUDIT_COMMENT_BODY || '');
  const validatedLines = body.split(/\r?\n/).filter(line => /^HAM-Validated-Head:/.test(line));
  if (validatedLines.length !== 1 || validatedLines[0].trim() !== `HAM-Validated-Head: ${validatedHead}`) return null;
  return {
    validatedHead: validatedHead.toLowerCase(),
    reviewedHead: env.HAM_REVIEWED_SHA.toLowerCase(),
    baseHead: SHA.test(env.HAM_BASE_HEAD || '') ? env.HAM_BASE_HEAD.toLowerCase() : null,
    validation: {
      auditPublishedHead: validatedHead.toLowerCase(),
      auditCommentSha256: createHash('sha256').update(body).digest('hex'),
    },
  };
}

// Returns the appended audit document, or null when this run has no validated,
// published head to resume from (the caller then records a plain deferral).
export function recordClosureResume({ env = process.env, gate, detail, now } = {}) {
  if (!/^[a-z][a-z0-9-]*$/.test(gate || '')) throw new TypeError('closure gate name required');
  const evidence = closureResumeEvidence(env);
  const hqRoot = env.HAM_HQ_ROOT || env.HQ_ROOT;
  const prNumber = Number(env.HAM_PR_NUMBER);
  if (!evidence || !hqRoot || !env.HAM_REPO || !Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
  const launchRequestId = env.HQ_LAUNCH_REQUEST_ID || null;
  return appendAmaAuditAttempt({
    hqRoot, repo: env.HAM_REPO, prNumber, headSha: evidence.validatedHead, now,
    attempt: {
      outcome: 'deferred', reason: CLOSURE_RESUME_REASON, attemptPhase: CLOSURE_RESUME_PHASE,
      launchRequestId,
      closureResume: { schemaVersion: 1, ...evidence, gate, launchRequestId,
        ...(detail ? { detail: String(detail).slice(-300) } : {}) },
    },
    metadata: { closureAuthority: 'ham-terminal-remediation' },
  });
}

function validReceipt(receipt, headSha) {
  return receipt?.schemaVersion === 1 && SHA.test(headSha || '')
    && receipt.validatedHead === String(headSha).toLowerCase()
    && SHA.test(receipt.reviewedHead || '') && /^[a-z][a-z0-9-]*$/.test(receipt.gate || '');
}

// The closer's read: the live receipt for this exact head, or null.
export function readClosureResume({ hqRoot, repo, prNumber, headSha, readEntryImpl = readAmaAuditEntry }) {
  if (!hqRoot || !repo || !SHA.test(headSha || '')) return null;
  let entry;
  try { entry = readEntryImpl(hqRoot, repo, prNumber, headSha); } catch { return null; }
  const latest = (entry?.attempts || []).findLast(attempt => SETTLED.has(attempt?.outcome));
  if (latest?.attemptPhase !== CLOSURE_RESUME_PHASE || latest.reason !== CLOSURE_RESUME_REASON) return null;
  return validReceipt(latest.closureResume, headSha) ? latest.closureResume : null;
}

// The resumed run's own copy, written by the closer into the new run directory.
export function readRunClosureResume(runDir, headSha) {
  if (!runDir) return null;
  try {
    const receipt = JSON.parse(readFileSync(join(runDir, CLOSURE_RESUME_FILE), 'utf8'));
    return validReceipt(receipt, headSha) ? receipt : null;
  } catch { return null; }
}

export function composeClosureResumePrompt(receipt) {
  return `
## Closure resume (CLOSERGATES-01)

Launch \`${receipt.launchRequestId || 'unknown'}\` already pushed and validated head \`${receipt.validatedHead}\` and published its validation audit. It then stopped at the \`${receipt.gate}\` closure gate on a transient read failure. This launch runs ONLY the closure gates and the merge for that same head. Do not remediate, edit, commit or re-run validation; \`hammer-validate.mjs\` reuses the recorded evidence for this head. Initialize Appendix A, run verify-head, publish the audit, then run Appendix E's CI wait, predicate inputs, predicate and merge. A conflict at verify-head still takes Appendix D: the rebase moves the head, so revalidate that new head normally. If the live head is not \`${receipt.validatedHead}\`, this receipt is void and the normal procedure applies.
`;
}

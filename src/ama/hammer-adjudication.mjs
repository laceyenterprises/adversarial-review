import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hamAuditCommentAuthorMatches } from './ham-provenance.mjs';
import { parseBlockingFindingsSection } from '../kernel/review-findings.mjs';

// HAMFINAL-01 — the hammer's adjudication of a disputed blocking finding is
// FINAL. Operator decision, 2026-10-10 (after agent-os PR 7987 was hand-merged
// over CHANGES_REQUESTED while the hammer sat "pending adjudication"):
//   "Hammers judgement is final"
// A blocking finding the hammer withdraws with concrete exact-head evidence is
// resolved as `withdrawn-by-hammer`. No reviewer re-review is requested, so the
// watcher's same-head duplicate guard can no longer strand the PR, and the gate,
// closer and hammer self-cert all read the withdrawal as a resolved finding.
export const HAMMER_WITHDRAWN_RESOLUTION = 'withdrawn-by-hammer';
export const HAMMER_FINAL_OPERATOR_DECISION = 'Hammers judgement is final';
export const HAM_FINDING_DISPUTE_PREFIX = 'HAM finding dispute — ';

const SHA40 = /^[a-f0-9]{40}$/i;
const SHA64 = /^[a-f0-9]{64}$/i;

const sha256 = (text) => createHash('sha256').update(String(text)).digest('hex');

export function blockingFindingIdentity(finding) {
  return sha256(JSON.stringify([finding?.title, finding?.file]));
}

// `null` when the body has no parseable blocking section; never synthesized.
export function blockingFindingIdentitiesFromBody(body) {
  const findings = parseBlockingFindingsSection(String(body ?? ''));
  return Array.isArray(findings) ? findings.map(blockingFindingIdentity) : null;
}

export function evidenceDigest(evidence) {
  return sha256(String(evidence ?? '').trim());
}

// Guardrail: a withdrawal needs concrete exact-head evidence — a quoted repro
// command and its output, or a quote of the head file showing the cited code
// is absent. Both are carried as a non-empty fenced block; prose alone is not
// evidence.
export function hasConcreteExactHeadEvidence(evidence) {
  const fences = String(evidence ?? '').matchAll(/^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm);
  for (const [, , content] of fences) {
    if (content.trim()) return true;
  }
  return false;
}

export function buildWithdrawalComment({ reviewRef, findingNumber, identity, headSha, findingReviewedHead, evidence }) {
  const trimmed = String(evidence ?? '').trim();
  return `${HAM_FINDING_DISPUTE_PREFIX}${reviewRef} finding=${findingNumber}\n`
    + `Resolution: ${HAMMER_WITHDRAWN_RESOLUTION}\n`
    + `Finding-Identity: ${identity}\n`
    + `Reviewed-Head: ${headSha}\nFinding-Reviewed-Head: ${findingReviewedHead}\n`
    + `Evidence-SHA256: ${evidenceDigest(trimmed)}\n\n${trimmed}\n\n`
    + 'Adjudication is final: the hammer withdrew this blocking finding with the exact-head evidence above '
    + `(operator decision 2026-10-10: "${HAMMER_FINAL_OPERATOR_DECISION}"). No re-review is requested; `
    + 'closure continues on this head.';
}

// Parses the comment `buildWithdrawalComment` produced. The embedded evidence
// must still hash to the recorded digest and still carry concrete evidence, so
// an edited or prose-only comment is not a withdrawal.
export function parseWithdrawalComment(body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  if (!text.startsWith(HAM_FINDING_DISPUTE_PREFIX)) return null;
  const [header, ...rest] = text.split('\n\n');
  const fields = Object.fromEntries(header.split('\n').slice(1)
    .map((line) => /^([A-Za-z0-9-]+): (.+)$/.exec(line)).filter(Boolean)
    .map(([, key, value]) => [key.toLowerCase(), value.trim()]));
  const evidence = rest.slice(0, -1).join('\n\n').trim();
  const withdrawal = {
    resolution: fields.resolution,
    identity: fields['finding-identity'],
    headSha: fields['reviewed-head'],
    findingReviewedHead: fields['finding-reviewed-head'],
    evidenceSha256: fields['evidence-sha256'],
  };
  if (withdrawal.resolution !== HAMMER_WITHDRAWN_RESOLUTION || !SHA64.test(withdrawal.identity || '')
    || !SHA40.test(withdrawal.headSha || '') || !SHA40.test(withdrawal.findingReviewedHead || '')
    || !SHA64.test(withdrawal.evidenceSha256 || '') || evidenceDigest(evidence) !== withdrawal.evidenceSha256
    || !hasConcreteExactHeadEvidence(evidence)) {
    return null;
  }
  return withdrawal;
}

// PR comments (timeline events or `gh pr view --json comments`) authored by the
// entitled HAM identity, matching a successfully admitted durable withdrawal.
// A post alone is insufficient: the helper can fail its subsequent head check.
export function hammerWithdrawalsFromComments(comments, recordedWithdrawals = []) {
  return (Array.isArray(comments) ? comments : []).flatMap((comment) => {
    const author = typeof comment?.author === 'string' ? comment.author
      : comment?.author?.login || comment?.user?.login || comment?.actor?.login || null;
    const body = typeof comment?.body === 'string' ? comment.body : comment?.comment?.body;
    if (!hamAuditCommentAuthorMatches(author)) return [];
    const withdrawal = parseWithdrawalComment(body);
    if (!withdrawal) return [];
    const admitted = recordedWithdrawals.some((row) => row.resolution === HAMMER_WITHDRAWN_RESOLUTION
      && row.commentId && [comment.id, comment.node_id].includes(row.commentId)
      && hamAuditCommentAuthorMatches(row.commentAuthor)
      && String(row.commentAuthor).replace(/\[bot\]$/, '').toLowerCase()
        === String(author).replace(/\[bot\]$/, '').toLowerCase()
      && row.commentSha256 === sha256(body)
      && row.identity === withdrawal.identity && row.headSha === withdrawal.headSha
      && row.findingReviewedHead === withdrawal.findingReviewedHead
      && row.evidenceSha256 === withdrawal.evidenceSha256);
    return admitted ? [withdrawal] : [];
  });
}

// Read-only and fail-soft, like the reviewer's dispute-context read: a missing,
// legacy or unreadable store contributes no withdrawals (the finding stays
// blocking), it never throws into the gate.
export function readHammerWithdrawals({ rootDir, repo, prNumber, logger = console, strict = false }) {
  if (!rootDir || !repo || !prNumber) {
    if (strict) throw new Error("withdrawal store identity missing");
    return [];
  }
  const path = join(rootDir, 'data', 'reviews.db');
  if (!existsSync(path)) {
    if (strict) throw new Error("withdrawal store missing");
    return [];
  }
  let db;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    return db.prepare(`SELECT identity, head_sha AS headSha, finding_reviewed_head AS findingReviewedHead,
      evidence_sha256 AS evidenceSha256, resolution, comment_id AS commentId,
      comment_author AS commentAuthor, comment_sha256 AS commentSha256 FROM ham_finding_disputes
      WHERE repo=? AND pr_number=? AND resolution=? AND comment_id IS NOT NULL`)
      .all(repo, Number(prNumber), HAMMER_WITHDRAWN_RESOLUTION);
  } catch (error) {
    if (strict) throw error;
    logger?.warn?.(`[ama] hammer withdrawal read failed; treating findings as unresolved: ${error?.message || error}`);
    return [];
  } finally { db?.close(); }
}

// A withdrawal resolves a finding of the review on `reviewedHead` when it names
// that finding identity and binds both the cited review and the evaluated head.
// Cross-head coverage must be validated independently, never inferred here.
// Applies only when the structured blocker list is known and complete.
export function resolveHammerAdjudication({
  blockingFindingState, blockingFindingCount, blockingFindingIdentities, reviewedHead, currentHead = reviewedHead,
} = {}, withdrawals = []) {
  const count = Number(blockingFindingCount);
  const identities = Array.isArray(blockingFindingIdentities) ? blockingFindingIdentities : null;
  const head = String(reviewedHead || '');
  const applicable = String(blockingFindingState || '').toLowerCase() === 'known'
    && Number.isInteger(count) && count > 0 && identities !== null && identities.length === count && new Set(identities).size === count
    && SHA40.test(head) && SHA40.test(currentHead || '');
  const resolved = applicable
    ? (Array.isArray(withdrawals) ? withdrawals : []).filter((entry) => entry?.resolution === HAMMER_WITHDRAWN_RESOLUTION
      && identities.includes(entry.identity)
      && SHA64.test(entry.evidenceSha256 || '')
      && entry.findingReviewedHead === head && entry.headSha === currentHead)
    : [];
  const withdrawnIdentities = [...new Set(resolved.map((entry) => entry.identity))];
  return {
    applicable,
    withdrawnIdentities,
    withdrawnCount: withdrawnIdentities.length,
    allBlockingWithdrawn: applicable && identities.every((identity) => withdrawnIdentities.includes(identity)),
  };
}

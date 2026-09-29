// HAMBG-02: a hammer LRQ that ends `succeeded` has only proven that its process
// exited 0. Headless Claude hammers backgrounded their close and ended the
// session (SEV2 2026-09-29): 5 of 19 succeeded runs left the PR open, and the
// closer never looked again. A succeeded hammer counts as having closed its PR
// only when
//   - the PR merged, or
//   - a terminal no-merge audit exists for the PR's current head.
// Anything else is `hammer-exited-without-close`.
//
// The no-merge audit has two forms, and the hammer can leave either:
//   - the local AMA audit (`ham_append_terminal_audit failed-without-merge ...`
//     in bin/hammer-merge.sh, or the gate-cap park in bin/hammer-verify-head.sh)
//     with status `failed-without-merge` for the current head;
//   - the hammer's audit PR comment (HAM_TERMINAL_REMEDIATION_AUDIT_MARKER) for
//     the current head, rewritten into a no-merge closing status. agent-os#7334
//     left only this form.
// The marker alone is NOT enough: hammer-publish posts the same comment before
// the merge, so adversarial-review#1178 and agent-os#7345 carry it for their
// current head and never closed.
//
// Everything here is pure; dispatch-closer does the reads and the writes.

import { hamAuditCommentAuthorMatches } from './ham-provenance.mjs';

export const HAMMER_EXITED_WITHOUT_CLOSE = 'hammer-exited-without-close';
export const HAMMER_OUTCOME_UNCONFIRMED = 'hammer-outcome-unconfirmed';

const HAM_TERMINAL_REMEDIATION_HEAD_RE = /^[ \t]*HAM-Terminal-Remediation-Head:[ \t]*([0-9a-f]{7,40})[ \t]*$/im;
// `HAM closing status — no merge` is the line mandate 0b requires and the
// gate-cap park writes. `Merge: not performed` is the form agent-os#7334's
// hammer wrote before that line was required.
const HAM_NO_MERGE_STATEMENT_RE = /^[ \t>*_]*(?:HAM closing status[ \t]*[—–-]+[ \t]*no merge\b|Merge:[ \t]*not performed\b)/im;

/**
 * Whether the PR carries the hammer's no-merge closing status for `headSha`.
 *
 * @param {Array<object>} comments  PR comments (`body`, `author`/`user`).
 * @param {object} args
 * @param {string} args.marker      HAM_TERMINAL_REMEDIATION_AUDIT_MARKER.
 * @param {string} args.headSha     The PR's current head.
 * @returns {boolean}
 */
export function hasHamNoMergeAuditCommentForHead(comments, { marker, headSha } = {}) {
  const head = String(headSha || '').trim().toLowerCase();
  if (!head || !marker) return false;
  return (Array.isArray(comments) ? comments : []).some((comment) => {
    const body = String(comment?.body || '');
    if (!body.includes(marker) || !HAM_NO_MERGE_STATEMENT_RE.test(body)) return false;
    const author = typeof comment?.author === 'string'
      ? comment.author
      : comment?.author?.login || comment?.user?.login || null;
    if (!hamAuditCommentAuthorMatches(author)) return false;
    const auditHead = String(HAM_TERMINAL_REMEDIATION_HEAD_RE.exec(body)?.[1] || '').toLowerCase();
    return Boolean(auditHead) && head.startsWith(auditHead);
  });
}

/**
 * Classify a hammer whose LRQ ended `succeeded`.
 *
 * @param {object} args
 * @param {string|null} args.livePrState  `gh pr view` state; null when the probe failed.
 * @param {boolean|null} args.noMergeAuditForCurrentHead  null when the PR's
 *   comments could not be read: an honest no-merge report cannot be ruled out.
 * @param {boolean=} args.concurrentWriter  The LRQ reported a lost push race.
 * @returns {{ closed: boolean, outcome: string }}
 */
export function classifySucceededHammerOutcome({
  livePrState,
  noMergeAuditForCurrentHead = false,
  concurrentWriter = false,
} = {}) {
  const state = String(livePrState || '').trim().toUpperCase();
  if (state === 'MERGED') return { closed: true, outcome: 'merged' };
  if (state === 'CLOSED') return { closed: true, outcome: 'pr-closed' };
  if (state !== 'OPEN') return { closed: false, outcome: HAMMER_OUTCOME_UNCONFIRMED };
  if (concurrentWriter) return { closed: false, outcome: 'no-merge:concurrent-writer' };
  if (noMergeAuditForCurrentHead === null) return { closed: false, outcome: HAMMER_OUTCOME_UNCONFIRMED };
  if (noMergeAuditForCurrentHead) return { closed: true, outcome: 'failed-without-merge' };
  return { closed: false, outcome: HAMMER_EXITED_WITHOUT_CLOSE };
}

function parseTimeMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The dispatch record of this review series' newest hammer launch, when it is
 * newer than the record at the reviewed head.
 *
 * A dispatch writes its record at the PR's head at that moment, but the closer
 * reads the record at the reviewed head. Once a hammer pushes, the reviewed head
 * stops moving (auto-refresh is suppressed for closer commits), so a later
 * launch's record is never read. adversarial-review#1178's second hammer and
 * agent-os#7341's only hammer were never observed that way.
 *
 * @param {Array<object>} records  Every dispatch record for this PR.
 * @param {object} args
 * @param {string} args.reviewedSha         The current reviewed head (the series).
 * @param {string} args.reviewedHeadSha     Head the reviewed-head record is keyed on.
 * @param {object|null} args.reviewedHeadRecord
 * @returns {object|null}
 */
export function selectNewerHammerLaunchRecord(records, {
  reviewedSha,
  reviewedHeadSha,
  reviewedHeadRecord = null,
} = {}) {
  const series = String(reviewedSha || '').trim();
  if (!series) return null;
  const reviewedHead = String(reviewedHeadSha || '').trim();
  let newest = null;
  for (const record of Array.isArray(records) ? records : []) {
    const headSha = String(record?.headSha || '').trim();
    if (!headSha || headSha === reviewedHead) continue;
    if (String(record?.reviewedSha || '').trim() !== series) continue;
    if (!record?.launchRequestId) continue;
    const dispatchedMs = parseTimeMs(record.dispatchedAt);
    if (dispatchedMs === null) continue;
    if (!newest || dispatchedMs > newest.dispatchedMs) newest = { record, dispatchedMs };
  }
  if (!newest) return null;
  if (reviewedHeadRecord?.launchRequestId === newest.record.launchRequestId) return null;
  const reviewedMs = parseTimeMs(reviewedHeadRecord?.dispatchedAt);
  if (reviewedMs !== null && reviewedMs >= newest.dispatchedMs) return null;
  return newest.record;
}

/**
 * Whether `lease` is the recorded launch's own lease, carried to another head.
 *
 * The orchestration rekeys a dispatched closer lease onto the head the hammer
 * pushed and keeps its `lrqId`. Such a lease is not "held by another process";
 * whether it is still held depends on that launch's status.
 */
export function isLeaseOfRecordedLaunch(lease, record) {
  const lrqId = String(lease?.lrqId || '').trim();
  return Boolean(lrqId)
    && String(lease?.status || '') === 'dispatched'
    && lrqId === String(record?.launchRequestId || '').trim();
}

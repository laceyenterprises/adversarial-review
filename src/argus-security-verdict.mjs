// ASR-06 — the verdict, and what the gate is allowed to conclude from silence.
//
// ASR-02 classifies, ASR-03 queues, ASR-04 routes, ASR-05 judges. This module is
// the last link: it turns the state of one Argus job into the one thing the
// merge gate needs, which is not "what did Argus find" but "may this merge".
//
// The authority boundary is the operator's, taken before build, and it is
// narrow on purpose:
//
//   `high` BLOCKS.            Install-time code execution, unpinned or
//                             non-registry sources, missing integrity,
//                             typosquat-shaped names, credential surfaces.
//   `medium` and `low` DO NOT. They post as advisory and never hold a merge.
//
// A security reviewer that blocks on everything freezes the dependency lane on
// its first false positive, and these PRs already go unattended for hours. A
// security reviewer that blocks on nothing is not containment. High-only is the
// line that makes "contain" real without making it self-defeating.
//
// The second half is harder than the first, because it is about ABSENCE.
//
//   FAIL CLOSED. A review that errored, stalled, or never returned is not an
//                approval. There is no code path in here from "no answer" to
//                `success`, and the tests assert that as a property over every
//                representable job state rather than case by case.
//
// This mirrors SEN-02: a probe that cannot see reports `blind`, never a health
// verdict. Same principle, higher stakes — a health probe that guesses "ok"
// costs an alert, a security gate that guesses "ok" merges the thing it was
// asked to look at. So silence gets its own answers here (`stalled`, `failed`,
// `missing`) and none of them are green.
//
// Why a stall eventually goes RED rather than staying yellow. `pending` holds
// the merge, so a permanently-pending gate is already fail-closed in the narrow
// sense. But ASR exists because `#909` and `#910` sat 14 hours and NOTHING
// SAID SO. A yellow check that never resolves reproduces exactly that: correct,
// and invisible. Past the deadline the honest report is that Argus is not
// answering, so the gate says it in red — the state an operator actually sees.

import {
  buildArgusJobId,
  findArgusJob as defaultFindArgusJob,
} from './argus-security-queue.mjs';

/**
 * How long an Argus job may sit unfinished before the gate calls it stalled.
 *
 * Generous, because the queue is FIFO and a deep-tier review does real work
 * (install the proposed version, exercise the consumed surface). The deadline
 * is not a review budget; it is the point past which silence is more likely to
 * mean "nothing is draining the queue" than "still working".
 */
export const ARGUS_REVIEW_STALL_DEADLINE_MS = 6 * 60 * 60 * 1000;

/**
 * Verdicts ASR-05 can reach, and the CLI exit code each corresponds to.
 *
 * `needs_verification` (exit 2) is the one that is easy to get wrong. It is not
 * a `high` finding, so under the operator's high-only rule it must NOT block —
 * but SPEC.md is explicit that it "is not an approval" either. It is the deep
 * tier reporting that required empirical verification was missing, stale,
 * mismatched, or failing. That is a statement about EVIDENCE, not about the
 * dependency, which puts it with the other unanswered-question states rather
 * than with the findings. It holds at `pending`; it never blocks and never
 * approves.
 */
export const ARGUS_VERDICTS = Object.freeze({
  APPROVE: 'approve',
  NEEDS_VERIFICATION: 'needs_verification',
  BLOCK: 'block',
});

/**
 * The states this module can report, and whether each may satisfy the gate.
 *
 * Exactly one is green. Keeping that fact in a single frozen table — rather
 * than spread across the branches that produce it — is what lets the
 * regression guard assert "no state but `approved` is ever `success`" over the
 * whole enum instead of over the cases someone remembered to test.
 */
export const ARGUS_VERDICT_STATES = Object.freeze({
  APPROVED: 'approved',
  BLOCKED: 'blocked',
  NEEDS_VERIFICATION: 'needs-verification',
  QUEUED: 'queued',
  IN_PROGRESS: 'in-progress',
  STALLED: 'stalled',
  FAILED: 'failed',
  MISSING: 'missing',
  MALFORMED: 'malformed',
});

const SATISFYING_STATES = Object.freeze(new Set([ARGUS_VERDICT_STATES.APPROVED]));

/**
 * Does this state permit the merge gate to go green?
 *
 * The single source of truth for the fail-closed property. Callers ask this
 * rather than comparing states themselves, so a state added later is
 * non-satisfying by default — the safe direction.
 */
export function argusVerdictSatisfiesGate(state) {
  return SATISFYING_STATES.has(state);
}

/**
 * Does this state block the merge outright (red), as opposed to holding it
 * (yellow)?
 *
 * `blocked` is a real `high` finding. `stalled` and `failed` are the reviewer
 * failing to answer. Both are red, for different reasons, and the gate reason
 * codes keep them distinguishable to an operator reading the check.
 */
export function argusVerdictBlocksGate(state) {
  return state === ARGUS_VERDICT_STATES.BLOCKED
    || state === ARGUS_VERDICT_STATES.STALLED
    || state === ARGUS_VERDICT_STATES.FAILED
    || state === ARGUS_VERDICT_STATES.MALFORMED;
}

function normalizeTimestampMs(value) {
  if (!value) return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Findings that hold blocking authority, from the ASR-05 result document.
 *
 * Read from `findings[].severity` rather than trusting the summary fields,
 * because `blocksMerge` and `highestSeverity` are derived values and a
 * truncated or hand-edited record can carry one without the other. The findings
 * array is the primary evidence.
 */
export function blockingArgusFindings(result) {
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  return findings.filter((finding) => String(finding?.severity ?? '').trim().toLowerCase() === 'high');
}

/**
 * Advisory findings — everything Argus found that must NOT hold the merge.
 *
 * Returned so the caller can post them, because "never blocks" must not decay
 * into "never surfaces". A medium finding nobody sees is the same as a medium
 * finding nobody made.
 */
export function advisoryArgusFindings(result) {
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  return findings.filter((finding) => {
    const severity = String(finding?.severity ?? '').trim().toLowerCase();
    return severity === 'medium' || severity === 'low';
  });
}

function interpretCompletedResult(result) {
  if (!result || typeof result !== 'object') {
    // A job in the `completed` bucket with no result document is not an
    // approval. It is a record we cannot read, which is the `missing` case
    // wearing a completed job's clothes.
    return {
      state: ARGUS_VERDICT_STATES.MALFORMED,
      summary: 'Argus recorded a completed review with no result document.',
    };
  }

  const blocking = blockingArgusFindings(result);
  const verdict = String(result.verdict ?? '').trim().toLowerCase();

  // Blocking findings outrank the recorded verdict. The two can only disagree
  // if the record was truncated or written by something other than ASR-05, and
  // in that disagreement the findings are the evidence and the verdict is the
  // summary. Trusting the summary over the evidence is how a `high` merges.
  if (blocking.length > 0 || verdict === ARGUS_VERDICTS.BLOCK) {
    const count = blocking.length;
    const detail = count > 0
      ? `${count} high-severity finding${count === 1 ? '' : 's'}`
      : 'a blocking verdict';
    return {
      state: ARGUS_VERDICT_STATES.BLOCKED,
      summary: `Argus security review blocks this merge: ${detail}.`,
      blockingFindings: blocking,
    };
  }

  if (verdict === ARGUS_VERDICTS.NEEDS_VERIFICATION) {
    return {
      state: ARGUS_VERDICT_STATES.NEEDS_VERIFICATION,
      summary: 'Argus security review requires empirical verification that is missing or stale.',
    };
  }

  if (verdict === ARGUS_VERDICTS.APPROVE) {
    const advisory = advisoryArgusFindings(result);
    const suffix = advisory.length > 0
      ? ` ${advisory.length} advisory finding${advisory.length === 1 ? '' : 's'} posted.`
      : '';
    return {
      state: ARGUS_VERDICT_STATES.APPROVED,
      summary: `Argus security review approves this head.${suffix}`,
      advisoryFindings: advisory,
    };
  }

  // An unrecognised verdict string. Not a `high`, so not `blocked`; certainly
  // not an approval either. `malformed` is the honest name for a record whose
  // disposition we cannot read.
  return {
    state: ARGUS_VERDICT_STATES.MALFORMED,
    summary: `Argus security review recorded an unrecognised verdict: ${
      result.verdict === undefined ? 'none' : JSON.stringify(result.verdict)
    }.`,
  };
}

/**
 * Resolve the Argus security verdict for one PR head.
 *
 * HEAD-SCOPED, and that is not incidental. `findArgusJob` keys on
 * (repo, prNumber, headSha), so a job that reviewed an earlier tree simply is
 * not found here and the answer is `missing` — never a stale approval carried
 * forward onto a tree no reviewer read. ASR-03 made re-enqueue on a new head
 * mandatory precisely so this lookup can be strict.
 *
 * @param {object}   opts
 * @param {string}   opts.rootDir   repo root that owns `data/`.
 * @param {string}   opts.repo      `owner/repo`.
 * @param {number}   opts.prNumber
 * @param {string}   opts.headSha   the head being gated.
 * @param {number}   [opts.nowMs]
 * @param {number}   [opts.stallDeadlineMs]
 * @param {Function} [opts.findJob] injection seam for tests.
 * @returns {{state: string, satisfiesGate: boolean, blocks: boolean,
 *   summary: string, bucket: string|null, jobPath: string|null,
 *   blockingFindings: Array, advisoryFindings: Array, waitedMs: number|null,
 *   result: object|null}}
 */
export function resolveArgusSecurityVerdict({
  rootDir,
  repo,
  prNumber,
  headSha,
  nowMs = Date.now(),
  stallDeadlineMs = ARGUS_REVIEW_STALL_DEADLINE_MS,
  findJob = defaultFindArgusJob,
} = {}) {
  const finalize = (partial) => ({
    bucket: null,
    jobPath: null,
    blockingFindings: [],
    advisoryFindings: [],
    waitedMs: null,
    result: null,
    ...partial,
    satisfiesGate: argusVerdictSatisfiesGate(partial.state),
    blocks: argusVerdictBlocksGate(partial.state),
  });

  // Can a job for this identity exist AT ALL?
  //
  // ASR-03 refuses to enqueue anything whose repo, PR number, or head SHA fails
  // its normalization, and `buildArgusJobId` is the function that enforces it.
  // Asking it here — rather than re-deriving the rules — means an identity the
  // queue would have rejected is reported `missing`, which does not block,
  // instead of being mistaken for an I/O failure, which does.
  //
  // This is not a fail-open hole. ASR-04 will not route a PR without a full
  // 40/64-hex head; it defers and retries. So a PR that genuinely fired a
  // security trigger always has an enqueueable identity, and cannot reach this
  // branch. What does reach it is the ordinary case of a gate running for a PR
  // Argus was never asked about.
  try {
    buildArgusJobId({ repo, prNumber, headSha });
  } catch {
    return finalize({
      state: ARGUS_VERDICT_STATES.MISSING,
      summary: 'No Argus security review can exist for this head: the queue identity is not well-formed.',
    });
  }

  let located = null;
  try {
    located = findJob(rootDir, { repo, prNumber, headSha });
  } catch (err) {
    // A queue that cannot be read is a security question that cannot be
    // answered. Never let an I/O failure fall through to the approval path.
    return finalize({
      state: ARGUS_VERDICT_STATES.FAILED,
      summary: `Argus security queue could not be read: ${err?.message || err}`,
    });
  }

  if (!located) {
    return finalize({
      state: ARGUS_VERDICT_STATES.MISSING,
      summary: 'No Argus security review exists for this head.',
    });
  }

  const { bucket, jobPath, job } = located;

  if (!job || typeof job !== 'object') {
    return finalize({
      state: ARGUS_VERDICT_STATES.MALFORMED,
      bucket,
      jobPath,
      summary: 'Argus security job record is unreadable.',
    });
  }

  if (bucket === 'failed') {
    return finalize({
      state: ARGUS_VERDICT_STATES.FAILED,
      bucket,
      jobPath,
      summary: `Argus security review failed: ${job.error || 'no error recorded'}`,
    });
  }

  if (bucket === 'completed') {
    const interpreted = interpretCompletedResult(job.result);
    return finalize({
      bucket,
      jobPath,
      result: job.result ?? null,
      blockingFindings: interpreted.blockingFindings ?? [],
      advisoryFindings: interpreted.advisoryFindings ?? [],
      state: interpreted.state,
      summary: interpreted.summary,
    });
  }

  // Still in flight: `pending` or `inProgress`. The deadline runs from the
  // enqueue, not from the claim — a job nothing ever claims is exactly the
  // stall this is watching for, and a claim-anchored clock would never fire for
  // it.
  const startedMs = normalizeTimestampMs(job.enqueuedAt);
  const waitedMs = startedMs === null ? null : Math.max(0, nowMs - startedMs);
  const inProgress = bucket === 'inProgress';

  if (waitedMs !== null && waitedMs > stallDeadlineMs) {
    const hours = Math.floor(waitedMs / (60 * 60 * 1000));
    return finalize({
      state: ARGUS_VERDICT_STATES.STALLED,
      bucket,
      jobPath,
      waitedMs,
      summary: `Argus security review has not returned after ${hours}h; treating silence as unresolved.`,
    });
  }

  return finalize({
    state: inProgress ? ARGUS_VERDICT_STATES.IN_PROGRESS : ARGUS_VERDICT_STATES.QUEUED,
    bucket,
    jobPath,
    waitedMs,
    summary: inProgress
      ? 'Argus security review is in progress for this head.'
      : 'Argus security review is queued for this head.',
  });
}

/**
 * The gate reason code for each state, so an operator reading a red or yellow
 * check can tell "Argus found something" from "Argus never answered" without
 * opening the queue.
 */
export const ARGUS_GATE_REASONS = Object.freeze({
  [ARGUS_VERDICT_STATES.APPROVED]: 'argus-security-approved',
  [ARGUS_VERDICT_STATES.BLOCKED]: 'argus-security-blocked',
  [ARGUS_VERDICT_STATES.NEEDS_VERIFICATION]: 'argus-security-needs-verification',
  [ARGUS_VERDICT_STATES.QUEUED]: 'argus-security-review-queued',
  [ARGUS_VERDICT_STATES.IN_PROGRESS]: 'argus-security-review-in-progress',
  [ARGUS_VERDICT_STATES.STALLED]: 'argus-security-review-stalled',
  [ARGUS_VERDICT_STATES.FAILED]: 'argus-security-review-failed',
  [ARGUS_VERDICT_STATES.MISSING]: 'argus-security-review-missing',
  [ARGUS_VERDICT_STATES.MALFORMED]: 'argus-security-review-malformed',
});

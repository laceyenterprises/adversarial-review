// CYCLECAPHAM-01 — a PR at the review cycle cap goes to the hammer for a final
// decision, not to the operator. Operator decisions, 2026-10-10:
//   "Hammers judgement is final"
//   "Any operator action outside of critical safety requirement should be
//    considered a Sev 1"
// agent-os PR 7956 reached the cap, was labelled "operator attention required"
// and sat ~10h at CHANGES_REQUESTED until a hand merge. The cap still stops
// further review-then-remediate cycles; the capped PR is now owned by the
// ordinary AMA closer, which dispatches the hammer under its existing lease,
// retry cap and gates. Only the hammer's final no-merge decision, or an
// exhausted hammer retry cap, pages the operator.
//
// CIBLOCKHAM-01 — the same route owns a PR whose head fails external CI with no
// remediation job left (rounds spent, or no follow-up job to requeue). agent-os
// PR 8007 parked as `ci-regression-no-job` with nobody owning the red head. The
// two routes share this table: one dispatch flag shape, one final-outcome
// classifier, one page shape and one prompt contract.
//
// Pure leaf: dispatch-closer and the watcher hand-offs all import it.

// The resolution a false finding records. Same literal and field shape as
// HAMFINAL-01's `withdrawn-by-hammer` record (src/ama/hammer-adjudication.mjs
// in PR 1254), so the cap route and the dispute route write one shape.
export const HAMMER_WITHDRAWN_RESOLUTION = 'withdrawn-by-hammer';

export const REVIEW_CYCLE_CAP_HAMMER_FINAL_NO_MERGE_REASON = 'review-cycle-cap-hammer-final-no-merge';
export const REVIEW_CYCLE_CAP_HAMMER_PAGE_EVENT = 'ama.review_cycle_cap.hammer_final';
export const CI_BLOCKED_HAMMER_FINAL_NO_MERGE_REASON = 'ci-blocked-hammer-final-no-merge';
export const CI_BLOCKED_HAMMER_PAGE_EVENT = 'ama.ci_blocked.hammer_final';

// Every route the hammer owns as final adjudicator. `dispatchFlag` is the
// boolean the watcher sets on the dispatch job; the closer reads it back from
// its dispatch context.
export const HAMMER_OWNER_ROUTES = Object.freeze({
  'review-cycle-cap': Object.freeze({
    dispatchFlag: 'reviewCycleCapReached',
    noMergeReason: REVIEW_CYCLE_CAP_HAMMER_FINAL_NO_MERGE_REASON,
    pageEvent: REVIEW_CYCLE_CAP_HAMMER_PAGE_EVENT,
    summary: 'review cycle cap reached',
    headline: 'Review-cycle-cap PR: hammer ended without a merge',
  }),
  'ci-blocked': Object.freeze({
    dispatchFlag: 'ciBlockedHammerOwner',
    noMergeReason: CI_BLOCKED_HAMMER_FINAL_NO_MERGE_REASON,
    pageEvent: CI_BLOCKED_HAMMER_PAGE_EVENT,
    summary: 'external CI failed with no remediation job left',
    headline: 'CI-blocked PR: hammer ended without a merge',
  }),
});

export const HAMMER_OWNER_PAGE_EVENTS = Object.freeze(
  Object.values(HAMMER_OWNER_ROUTES).map((route) => route.pageEvent),
);

// The hammer-owner route a dispatch job or closer dispatch context carries, or
// null for an ordinary closure.
export function hammerOwnerRouteOf(context) {
  for (const [name, route] of Object.entries(HAMMER_OWNER_ROUTES)) {
    if (context?.[route.dispatchFlag] === true) return name;
  }
  return null;
}

export function hammerOwnerRouteForPageEvent(event) {
  return Object.values(HAMMER_OWNER_ROUTES).find((route) => route.pageEvent === event) || null;
}

const HAMMER_CAP_EXHAUSTED_REASONS = new Set([
  'hammer-retry-cap-exhausted',
  'hammer-lifetime-ceiling-reached',
  'hammer-target-redrive-cap-exhausted',
]);
const HAMMER_FINAL_NO_MERGE_REASONS = new Set(
  Object.values(HAMMER_OWNER_ROUTES).map((route) => route.noMergeReason),
);

const HISTORY_LIMIT = 10;
const SUMMARY_LIMIT = 240;
const FAILED_CHECKS_LIMIT = 20;

// The two outcomes that end a hammer-owner route with an operator page.
// Anything else (dispatched, in flight, waiting on CI, a structural hold) is
// not a page.
export function hammerOwnerRouteFinalOutcome(amaClosureResult) {
  const reason = String(amaClosureResult?.reason || '');
  if (HAMMER_FINAL_NO_MERGE_REASONS.has(reason)) return 'hammer-no-merge';
  if (HAMMER_CAP_EXHAUSTED_REASONS.has(reason)) return 'hammer-cap-exhausted';
  return null;
}

export const reviewCycleCapHammerFinalOutcome = hammerOwnerRouteFinalOutcome;

function oneLine(value, limit) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function judgeFindingsLines(reviewed) {
  return [
    '- A finding you judge real: remediate it.',
    '- A finding you judge false: keep the code, and record it in the audit comment as',
    `  \`Resolution: ${HAMMER_WITHDRAWN_RESOLUTION}\` with \`Finding-Identity\` (sha256 of the JSON`,
    '  array `[title, file]`), `Reviewed-Head` (the head you evaluated), `Finding-Reviewed-Head`',
    `  (\`${reviewed}\`) and \`Evidence-SHA256\`, followed by the exact-head evidence in a fenced`,
    '  block: a reproduction command and its output, or a quote of the head file showing the',
    '  cited code is absent. Prose alone is not evidence. Count it in `Remediated-Findings`.',
  ];
}

function finalDecisionLines(reviewed) {
  return [
    `Commit the HAM remediation on the live head with \`Reviewed-Head: ${reviewed}\`, validate, and`,
    'merge under your lease. If you do not merge, post `HAM closing status — no merge.` with your',
    'reasons. That no-merge decision is final: no other hammer is dispatched for this head and the',
    'operator is paged.',
  ];
}

export function composeReviewCycleCapHammerPrompt({ reviewedSha, targetRemediationSha, cap, history = [] } = {}) {
  const reviewed = String(reviewedSha || '').trim() || 'unknown';
  const current = String(targetRemediationSha || '').trim() || reviewed;
  const rows = (Array.isArray(history) ? history : []).slice(-HISTORY_LIMIT);
  const historyLines = rows.length
    ? rows.map((row) => `- ${oneLine(row?.verdict_at, 40)} @${oneLine(row?.head_sha, 12)}: `
      + `${oneLine(row?.verdict_summary, SUMMARY_LIMIT) || 'no summary captured'}`).join('\n')
    : '- No cycle history was captured.';
  const cycles = Number.isInteger(Number(cap)) && Number(cap) > 0 ? `${Number(cap)} ` : '';
  return [
    '',
    '## CYCLECAPHAM-01 — review cycle cap: you are the final adjudicator',
    '',
    `This PR reached the review cycle cap: ${cycles}successive review-then-remediate cycles without`,
    'converging. Automatic review is paused and does not resume. Your decision is final',
    '(operator decision 2026-10-10: "Hammers judgement is final"). Do not request another',
    'adversarial review, and do not use the dispute helper\'s re-review route.',
    '',
    `Read the latest adversarial review on \`${reviewed}\` and the cycle history below. The live`,
    `head \`${current}\` may carry the last remediation push on top of that review. Judge every`,
    'finding against the live head:',
    ...judgeFindingsLines(reviewed),
    '',
    ...finalDecisionLines(reviewed),
    '',
    'Cycle history (oldest first):',
    historyLines,
    '',
  ].join('\n');
}

export function composeCiBlockedHammerPrompt({ reviewedSha, targetRemediationSha, failedChecks = [] } = {}) {
  const reviewed = String(reviewedSha || '').trim() || 'unknown';
  const current = String(targetRemediationSha || '').trim() || reviewed;
  const checks = (Array.isArray(failedChecks) ? failedChecks : []).slice(0, FAILED_CHECKS_LIMIT);
  const checkLines = checks.length
    ? checks.map((check) => `- ${oneLine(check?.name || 'unknown-check', 80)}: `
      + `${oneLine(check?.state || 'UNKNOWN', 40)}`
      + (check?.detailsUrl ? ` (${oneLine(check.detailsUrl, 200)})` : '')).join('\n')
    : '- The watcher did not capture the failing check names; read the PR status checks.';
  return [
    '',
    '## CIBLOCKHAM-01 — failed CI with no remediation job left: you are the owner',
    '',
    `External CI fails on the live head \`${current}\` and no remediation job is left to fix it`,
    '(the remediation rounds are spent, or there is no follow-up job to requeue). Re-review is',
    'parked until CI is green, so nobody else owns this head. Your decision is final',
    '(operator decision 2026-10-10: "Hammers judgement is final"). Reviewer admission requires',
    'green external CI; your dispatch does not.',
    '',
    'Read the failing checks below and fix the failure on the live head. Read the latest',
    `adversarial review on \`${reviewed}\`; the live head may carry an unreviewed remediation`,
    'push on top of it. Judge every finding against the live head:',
    ...judgeFindingsLines(reviewed),
    '',
    ...finalDecisionLines(reviewed),
    '',
    'Failing checks on the live head:',
    checkLines,
    '',
  ].join('\n');
}

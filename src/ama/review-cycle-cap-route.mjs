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
// Pure leaf: dispatch-closer and the watcher hand-off both import it.

// The resolution a false finding records. Same literal and field shape as
// HAMFINAL-01's `withdrawn-by-hammer` record (src/ama/hammer-adjudication.mjs
// in PR 1254), so the cap route and the dispute route write one shape.
export const HAMMER_WITHDRAWN_RESOLUTION = 'withdrawn-by-hammer';

export const REVIEW_CYCLE_CAP_HAMMER_FINAL_NO_MERGE_REASON = 'review-cycle-cap-hammer-final-no-merge';
export const REVIEW_CYCLE_CAP_HAMMER_PAGE_EVENT = 'ama.review_cycle_cap.hammer_final';

const HAMMER_CAP_EXHAUSTED_REASONS = new Set([
  'hammer-retry-cap-exhausted',
  'hammer-lifetime-ceiling-reached',
  'hammer-target-redrive-cap-exhausted',
]);

const HISTORY_LIMIT = 10;
const SUMMARY_LIMIT = 240;

// The two outcomes that end the cap route with an operator page. Anything else
// (dispatched, in flight, waiting on CI, a structural hold) is not a page.
export function reviewCycleCapHammerFinalOutcome(amaClosureResult) {
  const reason = String(amaClosureResult?.reason || '');
  if (reason === REVIEW_CYCLE_CAP_HAMMER_FINAL_NO_MERGE_REASON) return 'hammer-no-merge';
  if (HAMMER_CAP_EXHAUSTED_REASONS.has(reason)) return 'hammer-cap-exhausted';
  return null;
}

function oneLine(value, limit) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
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
    '- A finding you judge real: remediate it.',
    '- A finding you judge false: keep the code, and record it in the audit comment as',
    `  \`Resolution: ${HAMMER_WITHDRAWN_RESOLUTION}\` with \`Finding-Identity\` (sha256 of the JSON`,
    '  array `[title, file]`), `Reviewed-Head` (the head you evaluated), `Finding-Reviewed-Head`',
    `  (\`${reviewed}\`) and \`Evidence-SHA256\`, followed by the exact-head evidence in a fenced`,
    '  block: a reproduction command and its output, or a quote of the head file showing the',
    '  cited code is absent. Prose alone is not evidence. Count it in `Remediated-Findings`.',
    '',
    `Commit the HAM remediation on the live head with \`Reviewed-Head: ${reviewed}\`, validate, and`,
    'merge under your lease. If you do not merge, post `HAM closing status — no merge.` with your',
    'reasons. That no-merge decision is final: no other hammer is dispatched for this head and the',
    'operator is paged.',
    '',
    'Cycle history (oldest first):',
    historyLines,
    '',
  ].join('\n');
}

#!/usr/bin/env node
/**
 * AMA eligibility CLI shim.
 *
 * The AMA closer worker (dispatched by AMA-03) runs this script as the
 * final pre-merge recheck. Reads four JSON fixtures + flags, normalizes
 * them into the (reviewState, prMetadata, cfg) shape that
 * `src/ama/eligibility.mjs::isEligibleForAmaClosure` consumes, and emits
 * the verdict as JSON on stdout.
 *
 * Returns the verdict on stdout. Exit code:
 *   0 — verdict emitted (eligible OR not; both are valid outcomes)
 *   1 — usage error / unparseable input
 *
 * The exit code is NOT a yes/no signal. The caller MUST parse the JSON
 * verdict from stdout — that's the contract the eligibility module
 * exports.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { loadConfigCached } from '../src/config-loader.mjs';
import {
  resolveRoundBudgetForJob,
  summarizePRRemediationLedger,
} from '../src/follow-up-jobs.mjs';
import { classifyBlockingFindings } from '../src/follow-up-merge-agent.mjs';
import { normalizeGithubMergeability } from '../src/github-mergeability.mjs';
import { extractReviewVerdict, normalizeReviewVerdict } from '../src/kernel/verdict.mjs';

// Blocking-finding state for a head with NO authoritative review body to
// classify (no review on the reviewed head, blank body). The AMA gate fails
// closed on `unknown`; never synthesize `known: 0` out of nothing. Mirrors
// `adversarial-gate-status.mjs::UNKNOWN_BLOCKERS`.
const UNKNOWN_BLOCKERS = Object.freeze({
  blockingFindingState: 'unknown',
  blockingFindingCount: 0,
});

const SUBMITTED_REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED']);
const AUTHORITATIVE_REVIEWER_LOGINS = new Set([
  'lacey-claude-reviewer',
  'claude-reviewer-lacey',
  'lacey-codex-reviewer',
  'codex-reviewer-lacey',
]);

function normalizeLogin(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\[bot\]$/, '');
}

function reviewAuthorLogin(review) {
  return review?.author?.login || review?.user?.login || null;
}

function reviewCommitOid(review) {
  return review?.commit?.oid || review?.commit_id || review?.commitId || null;
}

function reviewSubmittedAt(review) {
  return review?.submittedAt || review?.submitted_at || null;
}

function normalizedStructuredVerdict(body) {
  return String(normalizeReviewVerdict(extractReviewVerdict(body)) || '').toLowerCase();
}

function isAuthoritativeReview(review, reviewedSha) {
  if (!reviewSubmittedAt(review) || String(reviewCommitOid(review) || '') !== String(reviewedSha || '')) {
    return false;
  }
  if (!SUBMITTED_REVIEW_STATES.has(String(review?.state || '').toUpperCase())) {
    return false;
  }
  if (!AUTHORITATIVE_REVIEWER_LOGINS.has(normalizeLogin(reviewAuthorLogin(review)))) {
    return false;
  }
  return true;
}

// Classify standing blocking findings from the SAME authoritative review body
// the verdict is derived from, reusing the merge-agent classifier so the
// AMA-closer pre-merge path and the merge-agent path agree. An empty /
// `- None.` `## Blocking Issues` section on a settled body resolves to
// `known: 0`; a populated section yields `count >= 1`; a missing/blank body
// fails closed to `unknown`. Mirrors `classifyBlockersFromBody` in
// `adversarial-gate-status.mjs`.
function classifyBlockersFromReviewBody(body, verdict) {
  if (!String(body ?? '').trim()) return { ...UNKNOWN_BLOCKERS };
  const { count, state } = classifyBlockingFindings(body, {
    lastVerdict: verdict || null,
  });
  return { blockingFindingState: state, blockingFindingCount: count };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = resolve(__dirname, '..');

const USAGE = `\
Usage:
  ama-check --pr <pr.json> --reviews <reviews.json>
            --protection <protection.json> --timeline <timeline.json>
            --reviewed-sha <sha> --risk-class <class>

Inputs:
  --pr            JSON from \`gh pr view --json number,headRefOid,state,isDraft,
                  mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName\`
  --repo          owner/name slug for the PR; required for final-hammer
                  exhaustion recomputation
  --root-dir      adversarial-review checkout root containing data/follow-up-jobs
                  (default: repository root containing this script)
  --reviews       JSON from \`gh pr view --json reviews\`
  --protection    JSON from \`gh api repos/<owner>/<repo>/branches/<base>/protection\`
  --timeline      JSON from \`gh api repos/<owner>/<repo>/issues/<n>/timeline --paginate\`
  --reviewed-sha  the head SHA the watcher authorized; the predicate's
                  head-match gate is against this value.
  --risk-class    resolved risk class from the spec/plan/dispatch sidecar
                  (low | medium | high | critical | unknown)

Emits:
  JSON object on stdout: { eligible: bool, reasons: string[], trace: {...} }
`;

function parseInputs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      pr: { type: 'string' },
      reviews: { type: 'string' },
      protection: { type: 'string' },
      timeline: { type: 'string' },
      'reviewed-sha': { type: 'string' },
      'risk-class': { type: 'string' },
      repo: { type: 'string' },
      'root-dir': { type: 'string' },
      // AMA final hammer: the watcher passes the dispatch-time observation for
      // audit context only. Exhaustion is recomputed from the durable ledger at
      // closer runtime before any waiver is applied.
      'review-cycle-exhausted': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  return values;
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isBranchProtectionUnavailableSentinel(value) {
  return value?.branchProtectionUnavailable === true && value?.reason === 'github_plan';
}

function loadProtectionJson(path, cfg) {
  const parsed = loadJson(path);
  if (cfg?.branchProtection?.required === false) {
    return parsed;
  }
  if (isBranchProtectionUnavailableSentinel(parsed)) {
    throw new Error(
      'branch protection is required but protection input reported GitHub plan unavailability',
    );
  }
  return parsed;
}

function recomputeReviewCycleExhausted({ rootDir, repo, prNumber }) {
  const normalizedRepo = String(repo || '').trim();
  const normalizedPr = Number(prNumber);
  if (!normalizedRepo) {
    throw new Error('missing --repo for review-cycle exhaustion recomputation');
  }
  if (!Number.isFinite(normalizedPr)) {
    throw new Error('missing PR number for review-cycle exhaustion recomputation');
  }

  const ledger = summarizePRRemediationLedger(rootDir, {
    repo: normalizedRepo,
    prNumber: normalizedPr,
  });
  const resolution = resolveRoundBudgetForJob(
    { riskClass: ledger.latestRiskClass },
    { rootDir },
  );
  const latestMaxRounds = Number(ledger.latestMaxRounds);
  const effectiveRoundBudget =
    Number.isInteger(latestMaxRounds) && latestMaxRounds > resolution.roundBudget
      ? latestMaxRounds
      : resolution.roundBudget;

  return (
    Number.isFinite(effectiveRoundBudget)
    && effectiveRoundBudget > 0
    && Number(ledger.completedRoundsForPR) >= effectiveRoundBudget
  );
}

/**
 * Normalize a `gh pr view --json reviews` payload + the
 * `--reviewed-sha` flag into the `reviewState` shape the eligibility
 * predicate consumes. Picks the latest review submitted at or after
 * the reviewed SHA was set.
 *
 * Reviewer-family resolution is best-effort: the predicate records
 * cross-model attribution per SPEC §4.2 #2 but does NOT gate on it
 * (audit-only). If the reviewer login isn't easily classifiable, the
 * `reviewerFamily` field stays null — the predicate's structural
 * gates still fire.
 */
function buildReviewState({ reviewsJson, prJson, timelineJson, reviewedSha, riskClass, reviewCycleExhausted = false }) {
  const reviews = Array.isArray(reviewsJson?.reviews) ? reviewsJson.reviews : [];
  // Use the newest verdict-bearing review on the reviewed head from a trusted
  // adversarial reviewer bot. GitHub's raw review state is not merge authority:
  // an unrelated later COMMENTED review, or a bot review body with no
  // structured `## Verdict`, must not synthesize comment-only / known:0.
  const authoritativeReviewsForHead = reviews
    .filter((r) => isAuthoritativeReview(r, reviewedSha))
    .map((review) => ({
      review,
      verdict: normalizedStructuredVerdict(review?.body),
    }))
    .filter((entry) => entry.verdict && entry.verdict !== 'unknown')
    .sort((a, b) => String(reviewSubmittedAt(b.review) || '').localeCompare(String(reviewSubmittedAt(a.review) || '')));
  const authoritativeReview = authoritativeReviewsForHead[0] || null;
  const verdict = authoritativeReview?.verdict || '';

  // Standing blocking findings must come from an authoritative review body
  // ON the reviewed head — never the off-head fallback, and never synthesized.
  // Without this, `reviewState.blockingFindingState` is `undefined`, so the
  // eligibility predicate's `classifyBlockingFindings` returns
  // `{ known: false }` for EVERY PR, pushing `blocking-findings-unknown` +
  // `verdict-not-settled-success` and deferring every settled-success closure
  // (the watcher's eligibility pass set these from the durable job, so it
  // passed while this pre-merge re-verification always failed closed).
  const { blockingFindingState, blockingFindingCount } = authoritativeReview
    ? classifyBlockersFromReviewBody(authoritativeReview.review.body, verdict)
    : { ...UNKNOWN_BLOCKERS };

  // Walk the timeline for the latest current-head `operator-approved`
  // labeled event. The eligibility predicate applies the head-scope +
  // attribution + non-author rules itself; this layer only normalizes
  // the shape.
  const timeline = Array.isArray(timelineJson) ? timelineJson : [];
  const latestLabeledFor = (label) => {
    const events = timeline
      .filter((e) => e?.event === 'labeled' && String(e?.label?.name || '').toLowerCase() === label)
      .slice()
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    return events[0] || null;
  };
  const opApprovedEvent = latestLabeledFor('operator-approved');

  const reviewState = {
    verdict,
    headSha: reviewedSha,
    riskClass,
    // Remediation-pending is operator-side state the closer can't fully
    // observe; default false here. The watcher's eligibility check
    // already gated on this; if the head changed since dispatch, the
    // head-match gate will fail and the closer defers.
    remediationPending: false,
    // AMA final hammer: the dispatched value is audit context only. The
    // merge-time closer recomputes exhaustion from the durable ledger before
    // passing a true value here.
    reviewCycleExhausted: reviewCycleExhausted === true,
    // Authoritative blocking-finding classification from the on-head review
    // body. The eligibility predicate's settled-success gate requires
    // `blockingFindingState === 'known'` AND `blockingFindingCount === 0`.
    blockingFindingState,
    blockingFindingCount,
    operatorApprovedEvidence: opApprovedEvent?.commit_id
      ? {
          applied: true,
          observedRevisionRef: opApprovedEvent.commit_id,
          actor: opApprovedEvent?.actor?.login || null,
          eventId: String(opApprovedEvent?.node_id || opApprovedEvent?.id || ''),
          observedAt: opApprovedEvent?.created_at || null,
        }
      : null,
    prAuthor: prJson?.author?.login || null,
    reviewerFamily: null,
  };
  return reviewState;
}

function buildPrMetadata({ prJson, protectionJson }) {
  // Branch-protection contexts come from
  // `required_status_checks.contexts` or, on newer GitHub responses,
  // `required_status_checks.checks[].context`.
  const checks = protectionJson?.required_status_checks || {};
  const requiredContexts = []
    .concat(Array.isArray(checks?.contexts) ? checks.contexts : [])
    .concat(Array.isArray(checks?.checks) ? checks.checks.map((c) => c?.context).filter(Boolean) : []);

  return {
    prNumber: Number(prJson?.number),
    headSha: String(prJson?.headRefOid || ''),
    isOpen: String(prJson?.state || '').toUpperCase() === 'OPEN',
    isDraft: prJson?.isDraft === true,
    mergeableState: normalizeGithubMergeability(prJson),
    labels: Array.isArray(prJson?.labels)
      ? prJson.labels.map((l) => String(l?.name || l)).filter(Boolean)
      : [],
    statusCheckRollup: Array.isArray(prJson?.statusCheckRollup) ? prJson.statusCheckRollup : [],
    branchProtection: { requiredContexts },
    author: prJson?.author?.login || null,
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseInputs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  for (const required of ['pr', 'reviews', 'protection', 'timeline', 'reviewed-sha', 'risk-class']) {
    if (!args[required]) {
      process.stderr.write(`error: --${required} is required\n${USAGE}`);
      return 1;
    }
  }
  const cfg = loadConfigCached().getMergeAuthorityConfig();
  let prJson, reviewsJson, protectionJson, timelineJson;
  try {
    prJson = loadJson(args.pr);
    reviewsJson = loadJson(args.reviews);
    protectionJson = loadProtectionJson(args.protection, cfg);
    timelineJson = loadJson(args.timeline);
  } catch (err) {
    process.stderr.write(`error: failed to load input JSON: ${err.message}\n`);
    return 1;
  }
  const dispatchedReviewCycleExhausted =
    String(args['review-cycle-exhausted'] || '').trim().toLowerCase() === 'true';
  let reviewCycleExhausted = false;
  if (dispatchedReviewCycleExhausted) {
    try {
      reviewCycleExhausted = recomputeReviewCycleExhausted({
        rootDir: args['root-dir'] ? resolve(args['root-dir']) : DEFAULT_ROOT_DIR,
        repo: args.repo,
        prNumber: prJson?.number,
      });
    } catch (err) {
      process.stderr.write(
        `warning: failed to recompute review-cycle exhaustion; final-hammer waiver disabled: ${err.message}\n`,
      );
      reviewCycleExhausted = false;
    }
  }
  const reviewState = buildReviewState({
    reviewsJson,
    prJson,
    timelineJson,
    reviewedSha: args['reviewed-sha'],
    riskClass: args['risk-class'],
    reviewCycleExhausted,
  });
  const prMetadata = buildPrMetadata({ prJson, protectionJson });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return 0;
}

process.exit(main());

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
import { spawnSync } from 'node:child_process';
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
import { amaAuthoritativeReviewerLoginsForModel } from '../src/ama/reviewer-authority.mjs';
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

function isAuthoritativeReview(review, reviewedSha, authoritativeReviewerLogins) {
  if (!reviewSubmittedAt(review) || String(reviewCommitOid(review) || '') !== String(reviewedSha || '')) {
    return false;
  }
  if (!SUBMITTED_REVIEW_STATES.has(String(review?.state || '').toUpperCase())) {
    return false;
  }
  if (!authoritativeReviewerLogins.has(normalizeLogin(reviewAuthorLogin(review)))) {
    return false;
  }
  return true;
}

// Matches a markdown `## Blocking Issues` (or `Blocking Issue`) heading on its
// own line, any heading level / surrounding whitespace. The AMA path requires
// this section to be PRESENT before it will trust a known-zero blocker count.
const BLOCKING_SECTION_HEADING_RE = /^[ \t]*#{1,6}[ \t]+Blocking[ \t]+Issues?[ \t]*$/im;

// Classify standing blocking findings from the SAME authoritative review body
// the verdict is derived from, reusing the merge-agent classifier so the
// AMA-closer pre-merge path and the merge-agent path agree. A present `##
// Blocking Issues` section that is empty / `- None.` resolves to `known: 0`; a
// populated section yields `count >= 1`; a missing/blank body fails closed to
// `unknown`. Mirrors `classifyBlockersFromBody` in `adversarial-gate-status.mjs`.
//
// AMA-specific stricter contract: the shared `classifyBlockingFindings`
// returns `{ known: 0 }` for a non-`Request changes` body that omits the
// `## Blocking Issues` section ENTIRELY (lenient merge-agent behavior). For
// autonomous closure that is a fail-open — a missing structured section is not
// evidence of zero blockers, it is absence of evidence. So we require the
// section to be present before trusting known-zero; an absent section fails
// closed to `unknown` and the closer parks at `blocking-findings-unknown`.
function classifyBlockersFromReviewBody(body, verdict) {
  const text = String(body ?? '');
  if (!text.trim()) return { ...UNKNOWN_BLOCKERS };
  if (!BLOCKING_SECTION_HEADING_RE.test(text)) return { ...UNKNOWN_BLOCKERS };
  const { count, state } = classifyBlockingFindings(text, {
    lastVerdict: verdict || null,
  });
  return { blockingFindingState: state, blockingFindingCount: count };
}

function extractBlockingFindingTitles(body) {
  const lines = String(body || '').split(/\r?\n/);
  const findings = [];
  let inBlocking = false;
  for (const line of lines) {
    if (/^[ \t]*#{1,6}[ \t]+Blocking[ \t]+Issues?[ \t]*$/i.test(line)) {
      inBlocking = true;
      continue;
    }
    if (inBlocking && /^[ \t]*#{1,6}[ \t]+/.test(line)) break;
    if (!inBlocking) continue;
    const bullet = line.match(/^[ \t]*[-*][ \t]+(.+)$/);
    if (!bullet) continue;
    const raw = bullet[1].trim();
    if (/^none\.?$/i.test(raw)) continue;
    const title = raw.match(/^\*\*([^*]+)\*\*/)?.[1] || raw.replace(/\s+-\s+.*$/, '');
    if (title.trim()) findings.push({ title: title.trim() });
  }
  return findings;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = resolve(__dirname, '..');

const USAGE = `\
Usage:
  ama-check --pr <pr.json> --reviews <reviews.json>
            --protection <protection.json> --timeline <timeline.json>
            --reviewed-sha <sha> --reviewer <model> --risk-class <class>

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
  --reviewer      expected reviewer model/family from reviewed_prs.reviewer
                  or the configured builder route. Unknown values fail closed.
  --risk-class    resolved risk class from the spec/plan/dispatch sidecar
                  (low | medium | high | critical | unknown)
  --ham-terminal-remediation <json>
                  Optional SPEC §1.1.1 HAM terminal-remediation evidence
                  proving HAM-authored live-head remediation, provenance, and
                  PR audit-comment finding mappings.
  --live-commit <json>
                  Test-only fixture for the GitHub commit object that
                  production resolves with gh api repos/{repo}/commits/{head}.

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
      reviewer: { type: 'string' },
      'risk-class': { type: 'string' },
      repo: { type: 'string' },
      'root-dir': { type: 'string' },
      // AMA final hammer: the watcher passes the dispatch-time observation for
      // audit context only. Exhaustion is recomputed from the durable ledger at
      // closer runtime before any waiver is applied.
      'review-cycle-exhausted': { type: 'string' },
      'ham-terminal-remediation': { type: 'string' },
      'live-commit': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  return values;
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fetchLiveCommit({ repo, headSha }) {
  const normalizedRepo = String(repo || '').trim();
  const normalizedHead = String(headSha || '').trim();
  if (!normalizedRepo) {
    throw new Error('missing --repo for HAM live commit verification');
  }
  if (!normalizedHead) {
    throw new Error('missing PR head SHA for HAM live commit verification');
  }
  const result = spawnSync('gh', ['api', `repos/${normalizedRepo}/commits/${normalizedHead}`], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 4,
  });
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    throw new Error(`failed to fetch live commit ${normalizedHead}: ${stderr || `gh exited ${result.status}`}`);
  }
  return JSON.parse(result.stdout);
}

function findAuthoritativeAuditComment(timelineJson, auditComment) {
  const timeline = Array.isArray(timelineJson) ? timelineJson : [];
  const claimedId = String(auditComment?.id || auditComment?.node_id || '');
  const marker = String(auditComment?.marker || 'ham-terminal-remediation').trim().toLowerCase();
  const comments = timeline
    .filter((event) => String(event?.event || '').toLowerCase() === 'commented')
    .filter((event) => String(event?.body || '').trim() !== '');
  if (claimedId) {
    const byId = comments.find((event) => (
      String(event?.id || '') === claimedId || String(event?.node_id || '') === claimedId
    ));
    if (byId) return byId;
  }
  return comments
    .slice()
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .find((event) => String(event?.body || '').toLowerCase().includes(marker)) || null;
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
 * Reviewer-family resolution is fail-closed: live review authority is scoped
 * to the reviewer model/family from the dispatch context. If that route cannot
 * be resolved, no live review body is trusted.
 */
function buildReviewState({
  reviewsJson,
  prJson,
  timelineJson,
  reviewedSha,
  reviewer,
  riskClass,
  reviewCycleExhausted = false,
}) {
  const reviews = Array.isArray(reviewsJson?.reviews) ? reviewsJson.reviews : [];
  const authoritativeReviewerLogins = new Set(
    amaAuthoritativeReviewerLoginsForModel(reviewer).map((login) => normalizeLogin(login)),
  );
  // Use the newest submitted review on the reviewed head from the routed
  // adversarial reviewer bot. The body from that exact review is merge
  // authority; malformed or unknown verdict prose fails closed instead of
  // searching backward for an older permissive verdict.
  const authoritativeReviewsForHead = authoritativeReviewerLogins.size
    ? reviews
      .filter((r) => isAuthoritativeReview(r, reviewedSha, authoritativeReviewerLogins))
      .map((review) => ({
        review,
        verdict: normalizedStructuredVerdict(review?.body),
      }))
      .sort((a, b) => String(reviewSubmittedAt(b.review) || '').localeCompare(String(reviewSubmittedAt(a.review) || '')))
    : [];
  const authoritativeReview = authoritativeReviewsForHead[0] || null;
  const verdict = authoritativeReview?.verdict === 'unknown'
    ? ''
    : authoritativeReview?.verdict || '';

  // Standing blocking findings must come from an authoritative review body
  // ON the reviewed head — never the off-head fallback, and never synthesized.
  // Without this, `reviewState.blockingFindingState` is `undefined`, so the
  // eligibility predicate's `classifyBlockingFindings` returns
  // `{ known: false }` for EVERY PR, pushing `blocking-findings-unknown` +
  // `verdict-not-settled-success` and deferring every settled-success closure
  // (the watcher's eligibility pass set these from the durable job, so it
  // passed while this pre-merge re-verification always failed closed).
  const { blockingFindingState, blockingFindingCount } = authoritativeReview
    ? (verdict
      ? classifyBlockersFromReviewBody(authoritativeReview.review.body, verdict)
      : { ...UNKNOWN_BLOCKERS })
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
    blockingFindings: authoritativeReview
      ? extractBlockingFindingTitles(authoritativeReview.review.body)
      : [],
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
  for (const required of ['pr', 'reviews', 'protection', 'timeline', 'reviewed-sha', 'reviewer', 'risk-class']) {
    if (!args[required]) {
      process.stderr.write(`error: --${required} is required\n${USAGE}`);
      return 1;
    }
  }
  const cfg = loadConfigCached().getMergeAuthorityConfig();
  let prJson, reviewsJson, protectionJson, timelineJson;
  let hamTerminalRemediation = null;
  try {
    prJson = loadJson(args.pr);
    reviewsJson = loadJson(args.reviews);
    protectionJson = loadProtectionJson(args.protection, cfg);
    timelineJson = loadJson(args.timeline);
    if (args['ham-terminal-remediation']) {
      hamTerminalRemediation = loadJson(args['ham-terminal-remediation']);
    }
    if (hamTerminalRemediation) {
      hamTerminalRemediation = {
        ...hamTerminalRemediation,
        liveCommit: args['live-commit']
          ? loadJson(args['live-commit'])
          : fetchLiveCommit({
              repo: args.repo,
              headSha: prJson?.headRefOid,
            }),
        authoritativeAuditComment: findAuthoritativeAuditComment(
          timelineJson,
          hamTerminalRemediation.auditComment,
        ),
      };
    }
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
    reviewer: args.reviewer,
    riskClass: args['risk-class'],
    reviewCycleExhausted,
  });
  const prMetadata = buildPrMetadata({ prJson, protectionJson });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    hamTerminalRemediation,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return 0;
}

process.exit(main());

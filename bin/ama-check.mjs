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
import { parseArgs } from 'node:util';

import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { loadConfigCached } from '../src/config-loader.mjs';

const USAGE = `\
Usage:
  ama-check --pr <pr.json> --reviews <reviews.json>
            --protection <protection.json> --timeline <timeline.json>
            --reviewed-sha <sha> --risk-class <class>

Inputs:
  --pr            JSON from \`gh pr view --json number,headRefOid,state,isDraft,
                  mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName\`
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
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  return values;
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
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
function buildReviewState({ reviewsJson, prJson, timelineJson, reviewedSha, riskClass }) {
  const reviews = Array.isArray(reviewsJson?.reviews) ? reviewsJson.reviews : [];
  // Take the most recent review on the reviewed head; fall back to the
  // most recent review overall.
  const reviewsForHead = reviews.filter((r) => r?.commit?.oid === reviewedSha);
  const latest = (reviewsForHead.length > 0 ? reviewsForHead : reviews)
    .slice()
    .sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')))[0]
    || null;
  // Map GitHub review states to the predicate's normalized verdict
  // strings. APPROVED -> 'approved'; COMMENTED -> 'comment-only';
  // CHANGES_REQUESTED -> 'request-changes'.
  const ghState = String(latest?.state || '').toUpperCase();
  const verdictMap = {
    APPROVED: 'approved',
    COMMENTED: 'comment-only',
    CHANGES_REQUESTED: 'request-changes',
  };
  const verdict = verdictMap[ghState] || String(latest?.state || '').toLowerCase();

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
    operatorApprovedEvidence: opApprovedEvent
      ? {
          applied: true,
          observedRevisionRef: opApprovedEvent?.commit_id || reviewedSha,
          actor: opApprovedEvent?.actor?.login || null,
          eventId: String(opApprovedEvent?.node_id || opApprovedEvent?.id || ''),
          observedAt: opApprovedEvent?.created_at || null,
        }
      : null,
    prAuthor: prJson?.author?.login || null,
    reviewerFamily: latest?.author?.login || null,
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
    mergeableState: String(prJson?.mergeStateStatus || prJson?.mergeable || '').toUpperCase(),
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
  let prJson, reviewsJson, protectionJson, timelineJson;
  try {
    prJson = loadJson(args.pr);
    reviewsJson = loadJson(args.reviews);
    protectionJson = loadJson(args.protection);
    timelineJson = loadJson(args.timeline);
  } catch (err) {
    process.stderr.write(`error: failed to load input JSON: ${err.message}\n`);
    return 1;
  }
  const cfg = loadConfigCached().getMergeAuthorityConfig();
  const reviewState = buildReviewState({
    reviewsJson,
    prJson,
    timelineJson,
    reviewedSha: args['reviewed-sha'],
    riskClass: args['risk-class'],
  });
  const prMetadata = buildPrMetadata({ prJson, protectionJson });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return 0;
}

process.exit(main());

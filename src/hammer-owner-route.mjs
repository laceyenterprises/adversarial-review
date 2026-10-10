// ── Hammer-owner route: hand a PR nobody else owns to the hammer ─────────────
//
// CYCLECAPHAM-01 / CIBLOCKHAM-01 (SEV1). Operator decisions, 2026-10-10:
// "Hammers judgement is final", and any operator action outside a critical
// safety requirement is a SEV1. Two kinds of PR used to park with no owner:
// a PR at the review cycle cap (agent-os PR 7956), and a PR whose head fails
// external CI with no remediation job left to fix it (agent-os PR 8007,
// `ci-regression-no-job`). Both now go to the hammer through this one route.
//
// The route hands the PR to the ordinary AMA closer with the route's dispatch
// flag, the same coexistence path the reviewer-timeout hand-off uses. The
// closer owns the hammer: lease, per-head retry cap, lifetime ceiling and every
// merge predicate are unchanged. The operator is paged only for the two
// route-ending outcomes: the hammer's final no-merge decision, or an exhausted
// hammer retry cap.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMergeAgentCoexistenceForWatcher } from './ama-closure-orchestration.mjs';
import {
  HAMMER_OWNER_ROUTES,
  hammerOwnerRouteFinalOutcome,
} from './ama/review-cycle-cap-route.mjs';
import { buildMergeAgentDispatchJob, fetchMergeAgentCandidate } from './follow-up-merge-agent.mjs';
import { normalizeLabelNames } from './review-cycle-cap-actions.mjs';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function defaultDeliverAlert(text, options) {
  const { deliverAlert } = await import('./alert-delivery.mjs');
  return deliverAlert(text, options);
}

function hammerOwnerPageText({ route, repoPath, prNumber, headSha, outcome, reason }) {
  const head = String(headSha || 'unknown').slice(0, 12);
  const { summary } = HAMMER_OWNER_ROUTES[route];
  return outcome === 'hammer-no-merge'
    ? `SEV1 ${repoPath}#${prNumber}: ${summary} and the hammer's final adjudication is NO MERGE `
      + `(head ${head}). Read its closing-status comment on the PR.`
    : `SEV1 ${repoPath}#${prNumber}: ${summary} and the hammer retry cap is exhausted `
      + `(${reason}, head ${head}) without a merge.`;
}

async function pageHammerOwnerOutcome({
  route,
  repoPath,
  prNumber,
  headSha,
  outcome,
  amaClosureResult,
  deliverAlertImpl,
  logger,
}) {
  const reason = amaClosureResult?.reason || outcome;
  try {
    // The outbox identity is stable per repo#pr@head, so a repeat tick re-uses
    // the queued or delivered page instead of paging again.
    const delivery = await deliverAlertImpl(
      hammerOwnerPageText({ route, repoPath, prNumber, headSha, outcome, reason }),
      {
        event: HAMMER_OWNER_ROUTES[route].pageEvent,
        payload: {
          severity: 'SEV1',
          repo: repoPath,
          prNumber,
          headSha: headSha || null,
          outcome,
          reason,
          route,
          launchRequestId: amaClosureResult?.launchRequestId || null,
        },
      },
    );
    return { paged: true, delivery };
  } catch (err) {
    logger?.error?.(
      `[watcher] ${route} hammer page failed for ${repoPath}#${prNumber}: ${err?.message || err}`
    );
    return { paged: false, error: err };
  }
}

// `reviewedHeadSha` is the head the latest adversarial review actually read.
// The closer is pinned to it, never to the unreviewed live head.
export async function routeToHammerOwner({
  route,
  rootDir = ROOT,
  db,
  repoPath,
  prNumber,
  existing,
  reviewedHeadSha,
  dispatchJobFields = {},
  subjectRef = null,
  currentRevisionRef = null,
  labelNames = [],
  execFileImpl = execFileAsync,
  fetchMergeAgentCandidateImpl = fetchMergeAgentCandidate,
  buildMergeAgentDispatchJobImpl = buildMergeAgentDispatchJob,
  resolveMergeAgentCoexistenceForWatcherImpl = resolveMergeAgentCoexistenceForWatcher,
  deliverAlertImpl = defaultDeliverAlert,
  logger = console,
} = {}) {
  const routeSpec = HAMMER_OWNER_ROUTES[route];
  if (!routeSpec) throw new Error(`unknown hammer-owner route: ${route}`);
  try {
    const candidate = await fetchMergeAgentCandidateImpl(repoPath, prNumber, { rootDir, execFileImpl });
    const dispatchJob = {
      ...buildMergeAgentDispatchJobImpl(rootDir, candidate, { reviewStateDb: db }),
      ...dispatchJobFields,
      [routeSpec.dispatchFlag]: true,
    };
    if (!reviewedHeadSha) throw new Error(`${route} authoritative reviewed head unavailable`);
    const coexistenceDecision = await resolveMergeAgentCoexistenceForWatcherImpl({
      rootDir,
      reviewStateRow: { ...existing, reviewer_head_sha: reviewedHeadSha },
      dispatchJob,
      candidate,
      labelNames: normalizeLabelNames(Array.isArray(candidate?.labels) ? candidate.labels : labelNames),
      repoPath,
      prNumber,
      currentRevisionRef,
      logger,
    });
    const { outcome, amaClosureResult } = coexistenceDecision || {};
    if (outcome === 'pr-terminal') {
      logger?.log?.(
        `[watcher] ${route} hammer route closed for ${repoPath}#${prNumber}: PR already ` +
          `${coexistenceDecision.terminalReason}`
      );
      return { handled: true, outcome, prTerminal: true };
    }
    const finalOutcome = hammerOwnerRouteFinalOutcome(amaClosureResult);
    if (finalOutcome) {
      const headSha = candidate?.headSha || currentRevisionRef || subjectRef?.revisionRef || null;
      const page = await pageHammerOwnerOutcome({
        route, repoPath, prNumber, headSha, outcome: finalOutcome, amaClosureResult, deliverAlertImpl, logger,
      });
      logger?.warn?.(
        `[watcher] ${route} hammer route ended for ${repoPath}#${prNumber}: ${finalOutcome} ` +
          `(${amaClosureResult?.reason}); operator ${page.paged ? 'paged' : 'page failed'}`
      );
      return { handled: true, outcome: finalOutcome, amaClosureResult, page };
    }
    if (outcome === 'dispatch-merge-agent') {
      // AMA is disabled or failed to dispatch. The hammer is the only final
      // adjudicator on this route, so the PR waits for the next tick rather
      // than falling through to the legacy merge-agent lane.
      logger?.warn?.(
        `[watcher] ${route} hammer route unavailable for ${repoPath}#${prNumber}: ` +
          `${amaClosureResult?.reason || 'ama-not-dispatched'}; retrying next tick`
      );
      return { handled: true, outcome: 'hammer-unavailable', amaClosureResult };
    }
    logger?.log?.(
      `[watcher] ${route} routed ${repoPath}#${prNumber} to the hammer for final adjudication: ` +
        `${outcome || 'unknown'} (${amaClosureResult?.reason || (amaClosureResult?.dispatched ? 'dispatched' : 'pending')}) ` +
        `lrq=${amaClosureResult?.launchRequestId || amaClosureResult?.dispatchId || 'none'}`
    );
    return { handled: true, outcome, amaClosureResult };
  } catch (err) {
    logger?.error?.(
      `[watcher] ${route} hammer route failed for ${repoPath}#${prNumber}: ${err?.message || err}`
    );
    return { handled: false, error: err };
  }
}

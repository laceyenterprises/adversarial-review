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
import { observeClosureWait } from './ama/closure-wait.mjs';
import { createNextActionPassKey, shadowNextActionLater } from './pr-next-action-consumer.mjs';
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
import { isOrphanRecoveryWait } from './ama/orphan-watchdog.mjs';
import { normalizeLabelNames } from './review-cycle-cap-actions.mjs';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const passesWithoutLaunch = new Map();
function routeOutcomeLine({ rootDir, repoPath, prNumber, headSha, route, outcome, result, error }) {
  const key = JSON.stringify([rootDir, repoPath, prNumber]);
  const previous = passesWithoutLaunch.get(key);
  const launched = result?.dispatched === true;
  const count = launched ? 0 : (previous?.headSha === headSha ? previous.count : 0) + 1;
  passesWithoutLaunch.delete(key);
  passesWithoutLaunch.set(key, { headSha, count });
  while (passesWithoutLaunch.size > 256) passesWithoutLaunch.delete(passesWithoutLaunch.keys().next().value);
  const reason = error?.message || result?.reason || outcome || 'pending';
  const waiting = isOrphanRecoveryWait(error || result) || (outcome === 'ama-pending'
    && !result?.needsOperator && !/fail|reject|exhausted|cap-reached/i.test(reason));
  const prefix = launched ? `launched lrq=${result.launchRequestId || result.dispatchId || 'unknown'}`
    : `${waiting ? 'waiting' : 'failed'}: ${reason}`;
  return `${prefix} route=${route} repo=${repoPath} pr=${prNumber} head=${headSha || 'unknown'} ownerless_idle_ms=${result?.ownerlessIdleMs ?? 'unknown'} passes_without_launch=${count}`;
}

async function defaultDeliverAlert(text, options) {
  const { deliverAlert } = await import('./alert-delivery.mjs');
  return deliverAlert(text, options);
}

function hammerOwnerPageText({ route, repoPath, prNumber, headSha, outcome, reason }) {
  const head = String(headSha || 'unknown').slice(0, 12);
  const { summary } = HAMMER_OWNER_ROUTES[route];
  const next = ' The PR has neither a reviewer nor a hammer; no automatic step remains on this head. '
    + 'Operator overrides: operator-approved, merge-agent-requested, paused-for-redesign. '
    + 'A new head is adjudicated again subject to the hammer retry cap and lifetime ceiling.';
  return (outcome === 'hammer-no-merge'
    ? `SEV1 ${repoPath}#${prNumber}: ${summary} and the hammer's final adjudication is NO MERGE `
      + `(head ${head}). Read its closing-status comment on the PR.`
    : `SEV1 ${repoPath}#${prNumber}: ${summary} and the hammer retry cap is exhausted `
      + `(${reason}, head ${head}) without a merge.`) + next;
}

async function pageHammerOwnerOutcome({
  rootDir,
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
  if (amaClosureResult?.alertEmitted === true) return { paged: true, alreadyPaged: true };
  try {
    // The outbox identity is stable per repo#pr@head, so a repeat tick re-uses
    // the queued or delivered page instead of paging again.
    const delivery = await observeClosureWait({ rootDir, repo: repoPath, prNumber, headSha,
      reason: hammerOwnerPageText({ route, repoPath, prNumber, headSha, outcome, reason }),
      waitClass: 'final-round', immediate: true,
      pageImpl: text => deliverAlertImpl(text, {
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
      }),
    });
    return { paged: true, delivery, alreadyPaged: !delivery.notify };
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
  let routeHead = currentRevisionRef || subjectRef?.revisionRef || reviewedHeadSha;
  const logOutcome = (outcome, result, error = null) => logger?.log?.(routeOutcomeLine({
    rootDir, repoPath, prNumber, headSha: routeHead, route, outcome, result, error,
  }));
  try {
    const candidate = await fetchMergeAgentCandidateImpl(repoPath, prNumber, { rootDir, execFileImpl });
    routeHead = candidate?.headSha || routeHead;
    const dispatchJob = {
      ...buildMergeAgentDispatchJobImpl(rootDir, candidate, { reviewStateDb: db }),
      ...dispatchJobFields,
      [routeSpec.dispatchFlag]: true,
    };
    if (!reviewedHeadSha) throw new Error(`${route} authoritative reviewed head unavailable`);
    // NXA-02: one observational pass key shared with closure orchestration.
    const passSnapshot = createNextActionPassKey({ subjectKey: `${repoPath}#${prNumber}`, head: routeHead,
      observedAt: new Date().toISOString() });
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
      passSnapshot,
    });
    const { outcome, amaClosureResult } = coexistenceDecision || {};
    if (outcome === 'pr-terminal') {
      logger?.log?.(
        `[watcher] ${route} hammer route closed for ${repoPath}#${prNumber}: PR already ` +
          `${coexistenceDecision.terminalReason}`
      );
      return { handled: true, outcome, prTerminal: true };
    }
    logOutcome(outcome, amaClosureResult);
    const finalOutcome = hammerOwnerRouteFinalOutcome(amaClosureResult);
    if (finalOutcome) {
      const headSha = candidate?.headSha || currentRevisionRef || subjectRef?.revisionRef || null;
      const page = await pageHammerOwnerOutcome({
        rootDir, route, repoPath, prNumber, headSha, outcome: finalOutcome, amaClosureResult, deliverAlertImpl, logger,
      });
      void shadowNextActionLater({ source: 'hammer-owner-route', passSnapshot, repo: repoPath, prNumber, rootDir,
        legacy: { action: 'operator-hold', actor: 'operator',
          reason: finalOutcome === 'hammer-no-merge' ? 'hammer-final-no-merge' : 'retry-exhausted',
          legacyOwner: route, legacyReason: amaClosureResult?.reason || finalOutcome } });
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
    return { handled: true, outcome, amaClosureResult };
  } catch (err) {
    logOutcome('failed', null, err);
    logger?.error?.(
      `[watcher] ${route} hammer route failed for ${repoPath}#${prNumber}: ${err?.message || err}`
    );
    const waiting = isOrphanRecoveryWait(err);
    return { handled: waiting, error: err,
      ...(waiting ? { outcome: 'ama-pending', amaClosureResult: {
        dispatched: false, skipMergeAgent: true, amaEnabled: true, reason: err?.code || err?.reason || 'rate-limited-read',
      } } : {}),
    };
  }
}

/**
 * Linear-backed operator triage sync surface.
 *
 * @typedef {import('../../../kernel/contracts.d.ts').OperatorTriageSync} OperatorTriageSync
 * @typedef {import('../../../kernel/contracts.d.ts').SubjectRef} SubjectRef
 * @typedef {import('../../../kernel/contracts.d.ts').SubjectState} SubjectState
 * @typedef {import('../../../kernel/contracts.d.ts').TriageStatus} TriageStatus
 */

import {
  extractLinearTicketId,
  routePR,
} from '../../subject/github-pr/routing.mjs';

const DEFAULT_CRITICAL_WORDS = ['critical', 'vulnerability', 'security', 'injection'];

function resolveLinearTicketId(subjectRef) {
  return (
    subjectRef?.linearTicketId
    || subjectRef?.linearTicket
    || subjectRef?.triageRef
    || subjectRef?.ticketId
    || null
  );
}

async function defaultLinearClientProvider() {
  if (!process.env.LINEAR_API_KEY) return null;
  if (!defaultLinearClientProvider.clientPromise) {
    defaultLinearClientProvider.clientPromise = import('@linear/sdk')
      .then(({ LinearClient }) => new LinearClient({ apiKey: process.env.LINEAR_API_KEY }));
  }
  return defaultLinearClientProvider.clientPromise;
}

function normalizeStatusName(status, stateNames) {
  const normalized = String(status || '').trim().toLowerCase();
  const map = {
    'pending-review': null,
    'in-review': stateNames.inReview,
    'changes-requested': stateNames.inProgress,
    'remediation-running': stateNames.inProgress,
    'awaiting-rereview': stateNames.inProgress,
    'in-progress': stateNames.inProgress,
    approved: stateNames.done,
    finalized: stateNames.done,
    done: stateNames.done,
    halted: stateNames.cancelled,
    cancelled: stateNames.cancelled,
  };
  return Object.prototype.hasOwnProperty.call(map, normalized)
    ? map[normalized]
    : status;
}

async function setLinearState({
  linearClientProvider,
  logger,
  ticketId,
  targetStateName,
}) {
  if (!ticketId || !targetStateName) return;
  const targetStateNames = Array.isArray(targetStateName)
    ? targetStateName.filter(Boolean)
    : [targetStateName];
  if (targetStateNames.length === 0) return;
  const linear = await linearClientProvider();
  if (!linear) return;

  try {
    const issue = await linear.issue(ticketId);
    if (!issue) return;

    const team = await issue.team;
    const states = await team.states();
    const normalizedTargets = targetStateNames.map((name) => String(name).toLowerCase());
    const targetState = states.nodes.find(
      (s) => normalizedTargets.includes(s.name.toLowerCase())
    );
    if (!targetState) {
      logger.warn?.(`[linear-triage] Linear state "${targetStateNames.join('" or "')}" not found for team`);
      return;
    }

    const currentState = await issue.state;
    if (normalizedTargets.includes(currentState?.name?.toLowerCase())) {
      logger.log?.(`[linear-triage] Linear ${ticketId} already in "${currentState.name}" - skipping`);
      return;
    }

    await linear.updateIssue(issue.id, { stateId: targetState.id });
    logger.log?.(`[linear-triage] Linear ${ticketId} -> "${targetState.name}"`);
  } catch (err) {
    logger.error?.(
      `[linear-triage] Linear update failed for ${ticketId} (-> ${targetStateNames[0]}):`,
      err?.message || err
    );
  }
}

function criticalWordsInSummary(reviewSummary, criticalWords = DEFAULT_CRITICAL_WORDS) {
  const lower = String(reviewSummary || '').toLowerCase();
  return criticalWords.filter((word) => lower.includes(String(word).toLowerCase()));
}

function buildCriticalFlagComment(reviewSummary, criticalWords = DEFAULT_CRITICAL_WORDS) {
  const matches = criticalWordsInSummary(reviewSummary, criticalWords);
  return [
    '**Adversarial review flagged critical issues** - Paul, please review.',
    '',
    `Issues detected: ${matches.join(', ')}`,
    '',
    'Full review posted as a GitHub PR comment.',
  ].join('\n');
}

function createLinearTriageAdapter({
  linearClientProvider = defaultLinearClientProvider,
  logger = console,
  stateNames = {},
  criticalWords = DEFAULT_CRITICAL_WORDS,
} = {}) {
  const resolvedStateNames = {
    inReview: stateNames.inReview || 'In Review',
    inProgress: stateNames.inProgress || 'In Progress',
    done: stateNames.done || ['Done', 'Review Complete'],
    cancelled: stateNames.cancelled || 'Cancelled',
  };
  let linearClientPromise = null;

  function getLinearClient() {
    if (!linearClientPromise) {
      linearClientPromise = Promise.resolve().then(() => linearClientProvider());
    }
    return linearClientPromise;
  }

  async function syncTriageStatus(subjectRef, status) {
    const ticketId = resolveLinearTicketId(subjectRef);
    const targetStateName = normalizeStatusName(status, resolvedStateNames);
    await setLinearState({
      linearClientProvider: getLinearClient,
      logger,
      ticketId,
      targetStateName,
    });
  }

  async function recordReviewerEngagement(subjectRef, attempt) {
    // Reserved operator-surface hook for LAC-486's reviewer-attempt-start
    // integration. Keep the method live in the composite adapter so future
    // watcher/reviewer callers can adopt it without another public-surface
    // churn, even though the current watcher only calls syncTriageStatus and
    // recordReviewCompleted directly.
    if (attempt?.startedAt && !attempt?.completedAt) {
      await syncTriageStatus(subjectRef, 'in-review');
    }
    if (attempt?.completedAt) {
      await syncTriageStatus(subjectRef, 'done');
    }
  }

  async function recordReviewCompleted(subjectRef, {
    critical = false,
    reviewSummary = '',
  } = {}) {
    const ticketId = resolveLinearTicketId(subjectRef);
    if (!ticketId) return;

    await syncTriageStatus(subjectRef, 'done');

    if (!critical) return;
    const linear = await getLinearClient();
    if (!linear) return;
    try {
      const issue = await linear.issue(ticketId);
      if (!issue) return;
      await linear.createComment({
        issueId: issue.id,
        body: buildCriticalFlagComment(reviewSummary, criticalWords),
      });
      logger.log?.(`[linear-triage] Linear ${ticketId} - critical flag comment added`);
    } catch (err) {
      logger.error?.(
        `[linear-triage] Linear critical flag failed for ${ticketId}:`,
        err?.message || err
      );
    }
  }

  return {
    routePR,
    extractLinearTicketId,
    syncTriageStatus,
    recordReviewerEngagement,
    recordReviewCompleted,
  };
}

export {
  DEFAULT_CRITICAL_WORDS,
  buildCriticalFlagComment,
  createLinearTriageAdapter,
  extractLinearTicketId,
  routePR,
};

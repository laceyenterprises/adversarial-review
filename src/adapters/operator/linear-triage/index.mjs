/**
 * Linear-backed operator triage sync surface.
 *
 * @typedef {import('../../../kernel/contracts.d.ts').OperatorTriageSync} OperatorTriageSync
 * @typedef {import('../../../kernel/contracts.d.ts').SubjectRef} SubjectRef
 * @typedef {import('../../../kernel/contracts.d.ts').SubjectState} SubjectState
 * @typedef {import('../../../kernel/contracts.d.ts').TriageStatus} TriageStatus
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from '../../../atomic-write.mjs';
import {
  extractLinearTicketId,
  routePR,
} from '../../subject/github-pr/routing.mjs';

const DEFAULT_CRITICAL_WORDS = ['critical', 'vulnerability', 'security', 'injection'];
const TICKET_PIPELINE_PAUSED_LABEL = 'ticket-pipeline-paused';
const TICKET_PIPELINE_PAUSE_ROOT_ENV = 'ADVERSARIAL_TICKET_PIPELINE_ROOT';
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, '..', '..', '..', '..');

function resolveLinearTicketId(subjectRef) {
  return subjectRef?.linearTicketId || null;
}

function normalizeLabelName(label) {
  return String(typeof label === 'string' ? label : label?.name || '').trim().toLowerCase();
}

function hasTicketPipelinePauseLabel(subjectRef) {
  const labels = Array.isArray(subjectRef?.labels) ? subjectRef.labels : [];
  return labels.some((label) => normalizeLabelName(label) === TICKET_PIPELINE_PAUSED_LABEL);
}

function repoFromSubjectRef(subjectRef) {
  const value = String(subjectRef?.repo || subjectRef?.subjectExternalId || '');
  const marker = value.indexOf('#');
  return (marker === -1 ? value : value.slice(0, marker)).trim();
}

function repoPausePath(rootDir, repo) {
  const safeRepo = String(repo || '')
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .replace(/_+/g, '_')
    || 'unknown';
  return join(rootDir, 'data', 'ticket-pipeline-pauses', `${safeRepo}.json`);
}

function resolveTicketPipelinePauseRoot(rootDir = DEFAULT_ROOT, env = process.env) {
  const override = String(env?.[TICKET_PIPELINE_PAUSE_ROOT_ENV] || '').trim();
  if (override) return resolve(override);
  const hqRoot = String(env?.HQ_ROOT || '').trim();
  if (hqRoot) return resolve(hqRoot, 'adversarial-review');
  return resolve(rootDir);
}

function ticketPipelinePauseDaemonStatusPath(rootDir = DEFAULT_ROOT) {
  return join(resolve(rootDir), 'data', 'ticket-pipeline-pauses', 'daemon-root-status.json');
}

function persistTicketPipelinePauseRootStatus(rootDir = DEFAULT_ROOT, {
  env = process.env,
  logger = null,
  recordedAt = new Date().toISOString(),
  pid = process.pid,
} = {}) {
  const pauseRootDir = resolveTicketPipelinePauseRoot(rootDir, env);
  const filePath = ticketPipelinePauseDaemonStatusPath(rootDir);
  const record = {
    kind: 'adversarial-review-ticket-pipeline-daemon-root-status',
    schemaVersion: 1,
    recordedAt,
    pid,
    rootDir: resolve(rootDir),
    pauseRootDir,
    env: {
      [TICKET_PIPELINE_PAUSE_ROOT_ENV]: env?.[TICKET_PIPELINE_PAUSE_ROOT_ENV] || null,
      HQ_ROOT: env?.HQ_ROOT || null,
    },
  };
  try {
    writeFileAtomic(filePath, `${JSON.stringify(record, null, 2)}\n`);
  } catch (err) {
    logger?.error?.(`[linear-triage] failed to persist ticket-pipeline daemon root status at ${filePath}: ${err?.message || err}`);
  }
  return { filePath, record };
}

function readTicketPipelinePauseRootStatus(rootDir = DEFAULT_ROOT) {
  const filePath = ticketPipelinePauseDaemonStatusPath(rootDir);
  if (!existsSync(filePath)) return null;
  try {
    return { filePath, record: JSON.parse(readFileSync(filePath, 'utf8')) };
  } catch (err) {
    return { filePath, error: err };
  }
}

function recordTicketPipelinePauseAlert(rootDir, { repo, filePath, error, logger = null } = {}) {
  const safeRepo = String(repo || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').replace(/_+/g, '_');
  const recordedAt = new Date().toISOString();
  const alertPath = join(
    resolve(rootDir || DEFAULT_ROOT),
    'data',
    'ticket-pipeline-pauses',
    'alerts',
    `${safeRepo}-${recordedAt.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`,
  );
  const alert = {
    kind: 'adversarial-review-ticket-pipeline-pause-alert',
    schemaVersion: 1,
    alert: 'corrupt-repo-pause-record',
    repo,
    filePath,
    recordedAt,
    error: error?.message || String(error),
  };
  try {
    writeFileAtomic(alertPath, `${JSON.stringify(alert, null, 2)}\n`);
  } catch (err) {
    logger?.error?.(`[linear-triage] failed to persist ticket-pipeline pause alert at ${alertPath}: ${err?.message || err}`);
  }
  return { alertPath, alert };
}

function isRepoTicketPipelinePaused(rootDir, repo, { logger = null, env = process.env } = {}) {
  if (!repo) return false;
  const filePath = repoPausePath(resolveTicketPipelinePauseRoot(rootDir, env), repo);
  if (!existsSync(filePath)) return false;
  try {
    const record = JSON.parse(readFileSync(filePath, 'utf8'));
    return record?.paused !== false;
  } catch (err) {
    logger?.error?.(`[linear-triage] invalid repo pause record at ${filePath}: ${err?.message || err}`);
    recordTicketPipelinePauseAlert(rootDir, { repo, filePath, error: err, logger });
    return true;
  }
}

function isTicketPipelinePaused(subjectRef, { rootDir = DEFAULT_ROOT, logger = null, env = process.env } = {}) {
  if (subjectRef?.ticketPipelinePaused) return true;
  if (hasTicketPipelinePauseLabel(subjectRef)) return true;
  return isRepoTicketPipelinePaused(rootDir, repoFromSubjectRef(subjectRef), { logger, env });
}

async function defaultLinearClientProvider() {
  if (!process.env.LINEAR_API_KEY) return null;
  if (defaultLinearClientProvider.client) {
    return defaultLinearClientProvider.client;
  }
  if (!defaultLinearClientProvider.clientLoadPromise) {
    defaultLinearClientProvider.clientLoadPromise = import('@linear/sdk')
      .then(({ LinearClient }) => new LinearClient({ apiKey: process.env.LINEAR_API_KEY }))
      .then((client) => {
        defaultLinearClientProvider.client = client;
        return client;
      })
      .catch((err) => {
        defaultLinearClientProvider.clientLoadPromise = null;
        throw err;
      });
  }
  return defaultLinearClientProvider.clientLoadPromise;
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
  rootDir = DEFAULT_ROOT,
  env = process.env,
} = {}) {
  persistTicketPipelinePauseRootStatus(rootDir, { env, logger });
  const resolvedStateNames = {
    inReview: stateNames.inReview || 'In Review',
    inProgress: stateNames.inProgress || 'In Progress',
    done: stateNames.done || ['Done', 'Review Complete'],
    cancelled: stateNames.cancelled || 'Cancelled',
  };
  let linearClient = undefined;
  let linearClientLoadPromise = null;

  async function getLinearClient() {
    if (linearClient !== undefined) {
      return linearClient;
    }
    if (!linearClientLoadPromise) {
      linearClientLoadPromise = Promise.resolve()
        .then(() => linearClientProvider())
        .then((client) => {
          if (client) {
            linearClient = client;
          }
          return client;
        })
        .catch((err) => {
          linearClientLoadPromise = null;
          throw err;
        });
    }
    const client = await linearClientLoadPromise;
    if (!client) {
      linearClientLoadPromise = null;
    }
    return client;
  }

  async function syncTriageStatus(subjectRef, status) {
    if (isTicketPipelinePaused(subjectRef, { rootDir, logger })) {
      logger.log?.(`[linear-triage] ticket pipeline paused for ${subjectRef?.subjectExternalId || subjectRef?.repo || '<unknown>'} - skipping ${status}`);
      return;
    }
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
    if (isTicketPipelinePaused(subjectRef, { rootDir, logger })) {
      logger.log?.(`[linear-triage] ticket pipeline paused for ${subjectRef?.subjectExternalId || subjectRef?.repo || '<unknown>'} - skipping review completion`);
      return;
    }
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
    routePR: (prTitle, subject = null, options = {}) => routePR(prTitle, subject, {
      env,
      ...options,
    }),
    extractLinearTicketId,
    syncTriageStatus,
    recordReviewerEngagement,
    recordReviewCompleted,
  };
}

export {
  DEFAULT_CRITICAL_WORDS,
  TICKET_PIPELINE_PAUSED_LABEL,
  buildCriticalFlagComment,
  createLinearTriageAdapter,
  extractLinearTicketId,
  hasTicketPipelinePauseLabel,
  isTicketPipelinePaused,
  persistTicketPipelinePauseRootStatus,
  repoPausePath,
  readTicketPipelinePauseRootStatus,
  resolveTicketPipelinePauseRoot,
  routePR,
  ticketPipelinePauseDaemonStatusPath,
  TICKET_PIPELINE_PAUSE_ROOT_ENV,
};

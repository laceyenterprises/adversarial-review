import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { writeFileAtomic } from './atomic-write.mjs';
import { getFollowUpJobDir, listFollowUpJobsInDir } from './follow-up-jobs.mjs';
import { fetchLatestLabelEvent } from './github-label-events.mjs';

const execFileAsync = promisify(execFile);

const MERGE_AGENT_DISPATCH_SCHEMA_VERSION = 1;
const OPERATOR_SKIP_LABELS = new Set(['merge-agent-skip', 'merge-agent-stuck', 'do-not-merge']);
const MERGE_AGENT_REQUESTED_LABEL = 'merge-agent-requested';
// `operator-approved` is a mobile-friendly override the operator can
// apply from the GitHub iOS/Android app (or the web UI) to say
// "I approve merging this current PR head now; do not wait for the
// adversarial-review/remediation loop to converge." This is the
// escape valve when automation is still reviewing, pending, or
// overcautious but the operator has decided manually.
//
// The label overrides review/remediation-state gates. It does NOT
// override:
//   - `not-mergeable` (force-merging a conflicted PR is ~always wrong)
//   - `checks-failed` / `checks-pending` (CI is a hard gate)
//   - `merge-agent-skip` / `merge-agent-stuck` / `do-not-merge`
//     (those signal "do not dispatch merge-agent now"; if both are
//     present, skip wins)
//   - `pr-not-open` / `merged` (trivially N/A)
const OPERATOR_APPROVED_LABEL = 'operator-approved';
const DEFAULT_MERGE_AGENT_PARENT_SESSION = 'session:adversarial-review:watcher';
const DEFAULT_MERGE_AGENT_PROJECT = 'pr-merge-orchestration';
const SUCCESSFUL_CHECK_STATES = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const PENDING_CHECK_STATES = new Set(['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED', 'WAITING', 'REQUESTED']);

function isoNow() {
  return new Date().toISOString();
}

function resolveMergeAgentParentSession(env = process.env) {
  return (
    env.MERGE_AGENT_PARENT_SESSION ||
    env.HQ_PARENT_SESSION ||
    env.AGENT_SESSION_REF ||
    DEFAULT_MERGE_AGENT_PARENT_SESSION
  );
}

function resolveMergeAgentProject(env = process.env) {
  return (
    env.MERGE_AGENT_HQ_PROJECT ||
    env.HQ_PROJECT ||
    DEFAULT_MERGE_AGENT_PROJECT
  );
}

function normalizeLabelNames(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => {
      if (typeof label === 'string') return label.trim().toLowerCase();
      if (typeof label?.name === 'string') return label.name.trim().toLowerCase();
      return '';
    })
    .filter(Boolean);
}

function normalizeLogin(value) {
  return String(value ?? '').trim().toLowerCase();
}

function extractOperatorNotes(prBody) {
  const text = String(prBody ?? '').trim();
  if (!text) return null;
  return [
    'BEGIN UNTRUSTED PR BODY NOTES',
    text.slice(0, 2_000),
    'END UNTRUSTED PR BODY NOTES',
  ].join('\n');
}

function extractReviewVerdict(reviewBody) {
  const match = String(reviewBody ?? '').match(/##\s+Verdict\s*\n([^\n]+)/i);
  return match ? match[1].trim() : null;
}

function normalizeReviewVerdict(verdict) {
  const text = String(verdict ?? '')
    .replace(/[*_`~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!text) return null;
  if (text.startsWith('request changes')) return 'request-changes';
  if (text.startsWith('comment only')) return 'comment-only';
  if (text.startsWith('approved')) return 'approved';
  return 'unknown';
}

function summarizeChecksConclusion(statusCheckRollup) {
  if (!Array.isArray(statusCheckRollup) || statusCheckRollup.length === 0) {
    return null;
  }

  let sawPending = false;
  for (const item of statusCheckRollup) {
    const rawState = String(
      item?.conclusion
      || item?.status
      || item?.state
      || item?.statusCheckRollup?.state
      || ''
    ).trim().toUpperCase();
    if (!rawState) {
      sawPending = true;
      continue;
    }
    if (PENDING_CHECK_STATES.has(rawState)) {
      sawPending = true;
      continue;
    }
    if (SUCCESSFUL_CHECK_STATES.has(rawState)) {
      continue;
    }
    return rawState;
  }

  return sawPending ? 'PENDING' : 'SUCCESS';
}

function mergeAgentDispatchDir(rootDir) {
  return join(getFollowUpJobDir(rootDir, 'pending'), '..', 'merge-agent-dispatches');
}

function mergeAgentPromptDir(rootDir) {
  return join(getFollowUpJobDir(rootDir, 'pending'), '..', 'merge-agent-prompts');
}

function sanitizeDispatchPathSegment(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '-');
}

function mergeAgentDispatchFilePath(rootDir, job) {
  const safeRepo = sanitizeDispatchPathSegment(String(job?.repo ?? '').replace(/\//g, '__'));
  const safeSha = sanitizeDispatchPathSegment(String(job?.headSha || 'no-sha'));
  return join(
    mergeAgentDispatchDir(rootDir),
    `${safeRepo}-pr-${Number(job?.prNumber)}-${safeSha}.json`
  );
}

function listMergeAgentDispatches(rootDir) {
  const dir = mergeAgentDispatchDir(rootDir);
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        try {
          return JSON.parse(readFileSync(join(dir, name), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getRecordedMergeAgentDispatch(rootDir, job) {
  try {
    return JSON.parse(readFileSync(mergeAgentDispatchFilePath(rootDir, job), 'utf8'));
  } catch {
    return null;
  }
}

function findLatestFollowUpJobForPR(rootDir, { repo, prNumber }) {
  const keys = ['pending', 'inProgress', 'completed', 'failed', 'stopped'];
  let latest = null;
  let latestTs = '';
  for (const key of keys) {
    for (const entry of listFollowUpJobsInDir(rootDir, key)) {
      const job = entry?.job;
      if (!job) continue;
      if (job.repo !== repo) continue;
      if (Number(job.prNumber) !== Number(prNumber)) continue;
      const ts = job.completedAt || job.failedAt || job.stoppedAt || job.claimedAt || job.createdAt || '';
      if (ts > latestTs) {
        latestTs = ts;
        latest = job;
      }
    }
  }
  return latest;
}

function buildMergeAgentPrompt(job) {
  const lines = [
    '# Merge-Agent Dispatch',
    '',
    `- Repo: ${job.repo}`,
    `- PR: #${job.prNumber}`,
    `- Branch: ${job.branch}`,
    `- Base: ${job.baseBranch}`,
  ];
  if (job.headSha) {
    lines.push(`- Head SHA: ${job.headSha}`);
  }
  if (job.operatorNotes) {
    lines.push('- Operator notes from PR body:');
    lines.push(job.operatorNotes);
  } else {
    lines.push('- Operator notes from PR body: none');
  }
  return `${lines.join('\n')}\n`;
}

function pickMergeAgentDispatch(job, {
  recentDispatches = [],
} = {}) {
  return pickMergeAgentDispatchDetail(job, { recentDispatches }).decision;
}

function pickMergeAgentDispatchDetail(job, {
  recentDispatches = [],
} = {}) {
  const normalizedVerdict = normalizeReviewVerdict(job?.lastVerdict);
  const labels = new Set(normalizeLabelNames(job?.labels));
  const hasMergeAgentRequestedLabel = labels.has(MERGE_AGENT_REQUESTED_LABEL);
  const mergeAgentRequested = hasMergeAgentRequestedLabel && isScopedMergeAgentRequest(job);
  const hasOperatorApprovedLabel = labels.has(OPERATOR_APPROVED_LABEL);
  const operatorApproved = hasOperatorApprovedLabel && isScopedOperatorApproval(job);
  const alreadyDispatched = recentDispatches.some((entry) => (
    String(entry?.repo ?? '') === String(job?.repo ?? '')
    && Number(entry?.prNumber) === Number(job?.prNumber)
    && String(entry?.headSha ?? '') === String(job?.headSha ?? '')
  ));

  // Hard skips that even an operator override does NOT bypass include
  // closed/merged PRs and explicit do-not-merge labels.
  // `operator-approved` also keeps mergeability/checks as hard gates,
  // but bypasses review/remediation-state gates for the current head.
  // `merge-agent-requested` is different: it asks the merge-agent to
  // clean/rebase the branch, so it can bypass current
  // mergeability/check/verdict gates, but not hard stop labels, active
  // remediation, or duplicate-dispatch protection.
  if (String(job?.prState ?? '').trim().toLowerCase() !== 'open' || Boolean(job?.merged)) {
    return { decision: 'skip-pr-not-open', trigger: null };
  }

  if ([...OPERATOR_SKIP_LABELS].some((label) => labels.has(label))) {
    // Skip-labels win even when approval/request labels are also present.
    return { decision: 'skip-operator-skip', trigger: null };
  }

  if (operatorApproved) {
    const hardGateDecision = pickOperatorApprovedMergeGate(job);
    if (hardGateDecision.decision !== 'dispatch') {
      return hardGateDecision;
    }
    return alreadyDispatched
      ? { decision: 'skip-already-dispatched', trigger: null }
      : { decision: 'dispatch', trigger: OPERATOR_APPROVED_LABEL };
  }

  const latestFollowUpJobStatus = String(job?.latestFollowUpJobStatus ?? '').trim().toLowerCase();
  if (latestFollowUpJobStatus === 'pending' || latestFollowUpJobStatus === 'in-progress') {
    return { decision: 'skip-remediation-active', trigger: null };
  }

  const normalDecision = pickNormalMergeAgentDispatchDetail({
    job,
    normalizedVerdict,
    operatorApproved,
    hasOperatorApprovedLabel,
  });
  if (normalDecision.decision === 'dispatch') {
    const dispatchDecision = !normalDecision.trigger && mergeAgentRequested
      ? { decision: 'dispatch', trigger: MERGE_AGENT_REQUESTED_LABEL }
      : normalDecision;
    return alreadyDispatched
      ? { decision: 'skip-already-dispatched', trigger: null }
      : dispatchDecision;
  }

  if (hasMergeAgentRequestedLabel) {
    if (!mergeAgentRequested) {
      return { decision: 'skip-merge-agent-requested-stale', trigger: null };
    }
    return alreadyDispatched
      ? { decision: 'skip-already-dispatched', trigger: null }
      : { decision: 'dispatch', trigger: MERGE_AGENT_REQUESTED_LABEL };
  }

  if (hasOperatorApprovedLabel && !operatorApproved) {
    return { decision: 'skip-operator-approval-stale', trigger: null };
  }

  return normalDecision;
}

function pickOperatorApprovedMergeGate(job) {
  if (String(job?.mergeable ?? '').trim().toUpperCase() !== 'MERGEABLE') {
    return { decision: 'skip-not-mergeable', trigger: null };
  }

  const checksConclusion = job?.checksConclusion == null
    ? null
    : String(job.checksConclusion).trim().toUpperCase();
  if (checksConclusion === null) {
    return { decision: 'skip-checks-unknown', trigger: null };
  }
  if (checksConclusion === 'PENDING') {
    return { decision: 'skip-checks-pending', trigger: null };
  }
  if (checksConclusion !== 'SUCCESS') {
    return { decision: 'skip-checks-failed', trigger: null };
  }

  return { decision: 'dispatch', trigger: OPERATOR_APPROVED_LABEL };
}

function pickNormalMergeAgentDispatchDetail({
  job,
  normalizedVerdict,
  operatorApproved,
  hasOperatorApprovedLabel,
}) {
  if (normalizedVerdict === null) {
    return { decision: 'skip-no-verdict', trigger: null };
  }
  if (normalizedVerdict === 'unknown') {
    return { decision: 'skip-unknown-verdict', trigger: null };
  }

  if (String(job?.mergeable ?? '').trim().toUpperCase() !== 'MERGEABLE') {
    return { decision: 'skip-not-mergeable', trigger: null };
  }

  const checksConclusion = job?.checksConclusion == null
    ? null
    : String(job.checksConclusion).trim().toUpperCase();
  if (checksConclusion === 'PENDING') {
    return { decision: 'skip-checks-pending', trigger: null };
  }
  if (checksConclusion !== null && checksConclusion !== 'SUCCESS') {
    return { decision: 'skip-checks-failed', trigger: null };
  }

  const remediationCurrentRound = Number(job?.remediationCurrentRound);
  const remediationMaxRounds = Number(job?.remediationMaxRounds);
  if (!Number.isFinite(remediationCurrentRound) || !Number.isFinite(remediationMaxRounds) || remediationMaxRounds <= 0) {
    return { decision: 'skip-remediation-state-unknown', trigger: null };
  } else if (remediationCurrentRound < remediationMaxRounds) {
    // More remediation rounds available — let the loop continue.
    return { decision: 'skip-remediation-claimable', trigger: null };
  }

  if (normalizedVerdict === 'request-changes' && !operatorApproved) {
    return {
      decision: hasOperatorApprovedLabel ? 'skip-operator-approval-stale' : 'skip-request-changes',
      trigger: null,
    };
  }

  return {
    decision: 'dispatch',
    trigger: normalizedVerdict === 'request-changes' && operatorApproved
      ? OPERATOR_APPROVED_LABEL
      : null,
  };
}

function isScopedOperatorApproval(job) {
  const approval = job?.operatorApproval;
  if (!approval) return false;
  if (!approval.actor || String(approval.actor).trim().toLowerCase() === 'unknown') return false;
  if (job?.prAuthor && normalizeLogin(approval.actor) === normalizeLogin(job.prAuthor)) return false;
  if (!approval.labelEventId && !approval.labelEventNodeId) return false;
  if (!approval.createdAt) return false;
  if (String(approval.headSha || '') !== String(job?.headSha || '')) return false;
  return true;
}

function isScopedMergeAgentRequest(job) {
  const request = job?.mergeAgentRequest;
  if (!request) return false;
  if (!request.actor || String(request.actor).trim().toLowerCase() === 'unknown') return false;
  if (!request.labelEventId && !request.labelEventNodeId) return false;
  if (!request.createdAt) return false;
  if (String(request.headSha || '') !== String(job?.headSha || '')) return false;
  const prUpdatedAt = request.prUpdatedAt || job?.prUpdatedAt || null;
  if (prUpdatedAt && !isoAtOrAfter(request.createdAt, prUpdatedAt)) return false;
  return true;
}

function isoAtOrAfter(candidate, floor) {
  if (!candidate || !floor) return false;
  const candidateEpoch = Date.parse(candidate);
  const floorEpoch = Date.parse(floor);
  if (Number.isNaN(candidateEpoch) || Number.isNaN(floorEpoch)) return false;
  return candidateEpoch >= floorEpoch;
}

function buildScopedOperatorApproval(candidate, latestJob) {
  const event = candidate?.operatorApprovalEvent;
  if (!event) return null;
  if (!candidate?.headSha) return null;
  if (candidate?.prAuthor && normalizeLogin(event.actor) === normalizeLogin(candidate.prAuthor)) return null;
  if (String(event.headSha || '') !== String(candidate.headSha || '')) return null;
  if (!event.codeScopedAt || !isoAtOrAfter(event.createdAt, event.codeScopedAt)) return null;
  return {
    actor: event.actor || null,
    createdAt: event.createdAt || null,
    labelEventId: event.id || null,
    labelEventNodeId: event.nodeId || null,
    headSha: event.headSha || null,
    codeScopedAt: event.codeScopedAt || null,
    codeScopeEventId: event.codeScopeEventId || null,
    codeScopeEventKind: event.codeScopeEventKind || null,
  };
}

function buildScopedMergeAgentRequest(candidate) {
  const event = candidate?.mergeAgentRequestEvent;
  if (!event) return null;
  if (!candidate?.headSha) return null;
  if (candidate?.prUpdatedAt && !isoAtOrAfter(event.createdAt, candidate.prUpdatedAt)) return null;
  return {
    actor: event.actor || null,
    createdAt: event.createdAt || null,
    labelEventId: event.id || null,
    labelEventNodeId: event.nodeId || null,
    headSha: candidate.headSha,
    prUpdatedAt: candidate.prUpdatedAt || null,
  };
}

function recordMergeAgentDispatch(rootDir, job, {
  dispatchedAt = isoNow(),
  prompt,
  dispatchId = null,
  launchRequestId = null,
  trigger = null,
  labelRemoval = null,
} = {}) {
  const dir = mergeAgentDispatchDir(rootDir);
  mkdirSync(dir, { recursive: true });
  const filePath = mergeAgentDispatchFilePath(rootDir, job);
  const doc = {
    schemaVersion: MERGE_AGENT_DISPATCH_SCHEMA_VERSION,
    repo: job.repo,
    prNumber: Number(job.prNumber),
    branch: job.branch,
    baseBranch: job.baseBranch,
    headSha: job.headSha || null,
    operatorApproval: job.operatorApproval || null,
    mergeAgentRequest: job.mergeAgentRequest || null,
    trigger,
    labelRemoval,
    dispatchedAt,
    dispatchId,
    launchRequestId,
    prompt,
  };
  writeFileAtomic(filePath, `${JSON.stringify(doc, null, 2)}\n`);
  return filePath;
}

function updateMergeAgentDispatchLabelRemoval(rootDir, job, {
  recordedDispatch = null,
  trigger,
  attemptedAt,
  removed,
  error = null,
  observedExternally = false,
} = {}) {
  const filePath = mergeAgentDispatchFilePath(rootDir, job);
  const existing = recordedDispatch || getRecordedMergeAgentDispatch(rootDir, job);
  if (!existing) return null;

  const previousAttempts = Array.isArray(existing.labelRemoval?.attempts)
    ? existing.labelRemoval.attempts
    : [];
  const labelRemoval = {
    label: trigger,
    removed: Boolean(removed),
    lastAttemptAt: attemptedAt,
    lastError: removed ? null : error,
    observedExternally: Boolean(observedExternally),
    attempts: [
      ...previousAttempts,
      {
        attemptedAt,
        label: trigger,
        removed: Boolean(removed),
        error: removed ? null : error,
        observedExternally: Boolean(observedExternally),
      },
    ],
  };

  const next = {
    ...existing,
    trigger: existing.trigger || trigger || null,
    labelRemoval,
  };
  writeFileAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
  return filePath;
}

async function removeConsumedTriggerLabel({
  repo,
  prNumber,
  labels,
  trigger,
  ghExecFileImpl,
  now,
} = {}) {
  const normalizedLabels = normalizeLabelNames(labels);
  const result = {
    attempted: false,
    operatorApprovalLabelRemoved: false,
    mergeAgentRequestedLabelRemoved: false,
    labelRemovalErrors: [],
  };

  if (!trigger || !normalizedLabels.includes(trigger)) {
    return result;
  }

  result.attempted = true;
  try {
    await ghExecFileImpl('gh', [
      'pr',
      'edit',
      String(prNumber),
      '--repo',
      repo,
      '--remove-label',
      trigger,
    ], { maxBuffer: 5 * 1024 * 1024 });
    if (trigger === OPERATOR_APPROVED_LABEL) {
      result.operatorApprovalLabelRemoved = true;
    }
    if (trigger === MERGE_AGENT_REQUESTED_LABEL) {
      result.mergeAgentRequestedLabelRemoved = true;
    }
  } catch (err) {
    const detail = err?.message || String(err);
    result.labelRemovalErrors.push({ label: trigger, error: detail });
    console.warn(
      `[follow-up-merge-agent] failed to remove consumed label '${trigger}' from ${repo}#${prNumber}: ${detail}`
    );
  }

  result.labelRemovalAttempt = {
    trigger,
    attemptedAt: now,
    removed: result.labelRemovalErrors.length === 0,
    error: result.labelRemovalErrors[0]?.error || null,
  };
  return result;
}

function writeMergeAgentPrompt(rootDir, job, prompt, { dispatchedAt = isoNow() } = {}) {
  const dir = mergeAgentPromptDir(rootDir);
  mkdirSync(dir, { recursive: true });
  const safeRepo = sanitizeDispatchPathSegment(String(job.repo).replace(/\//g, '__'));
  const safeSha = sanitizeDispatchPathSegment(String(job.headSha || 'no-sha'));
  const safeTs = sanitizeDispatchPathSegment(String(dispatchedAt));
  const filePath = join(dir, `${safeRepo}-pr-${job.prNumber}-${safeSha}-${safeTs}.md`);
  writeFileSync(filePath, prompt, 'utf8');
  return filePath;
}

function parseMergeAgentDispatchOutput(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) {
    throw new Error('hq dispatch returned empty stdout');
  }

  try {
    return JSON.parse(text);
  } catch {}

  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines.slice(index).join('\n').trim();
    if (!candidate.startsWith('{')) continue;
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  throw new Error('hq dispatch did not return machine-readable JSON');
}

async function dispatchMergeAgentForPR({
  rootDir,
  repo,
  prNumber,
  branch,
  baseBranch,
  headSha,
  mergeable,
  checksConclusion,
  labels,
  operatorNotes,
  lastVerdict,
  prState = 'open',
  merged = false,
  prAuthor = null,
  latestFollowUpJobStatus = null,
  remediationCurrentRound = null,
  remediationMaxRounds = null,
  prUpdatedAt = null,
  operatorApproval = null,
  mergeAgentRequest = null,
  execFileImpl = execFileAsync,
  ghExecFileImpl = execFileAsync,
  now = isoNow(),
  hqPath = 'hq',
  parentSession = resolveMergeAgentParentSession(),
  hqProject = resolveMergeAgentProject(),
} = {}) {
  const job = {
    repo,
    prNumber,
    branch,
    baseBranch,
    headSha,
    mergeable,
    checksConclusion,
    labels,
    operatorNotes,
    lastVerdict,
    prState,
    merged,
    prAuthor,
    latestFollowUpJobStatus,
    remediationCurrentRound,
    remediationMaxRounds,
    prUpdatedAt,
    operatorApproval,
    mergeAgentRequest,
  };
  const recordedDispatch = getRecordedMergeAgentDispatch(rootDir, job);
  const dispatchDecision = pickMergeAgentDispatchDetail(job, {
    recentDispatches: recordedDispatch ? [recordedDispatch] : [],
  });
  const { decision, trigger } = dispatchDecision;
  if (decision !== 'dispatch') {
    if (decision === 'skip-already-dispatched' && recordedDispatch?.trigger) {
      const labelRemoval = await removeConsumedTriggerLabel({
        repo,
        prNumber,
        labels,
        trigger: recordedDispatch.trigger,
        ghExecFileImpl,
        now,
      });
      if (labelRemoval.attempted) {
        updateMergeAgentDispatchLabelRemoval(rootDir, job, {
          recordedDispatch,
          trigger: recordedDispatch.trigger,
          attemptedAt: labelRemoval.labelRemovalAttempt.attemptedAt,
          removed: labelRemoval.labelRemovalAttempt.removed,
          error: labelRemoval.labelRemovalAttempt.error,
        });
      } else if (
        recordedDispatch.labelRemoval?.removed !== true
        && !normalizeLabelNames(labels).includes(recordedDispatch.trigger)
      ) {
        updateMergeAgentDispatchLabelRemoval(rootDir, job, {
          recordedDispatch,
          trigger: recordedDispatch.trigger,
          attemptedAt: now,
          removed: true,
          observedExternally: true,
        });
      }
      return {
        decision,
        trigger: recordedDispatch.trigger,
        labelRemovalRetried: labelRemoval.attempted,
        operatorApprovalLabelRemoved: labelRemoval.operatorApprovalLabelRemoved,
        mergeAgentRequestedLabelRemoved: labelRemoval.mergeAgentRequestedLabelRemoved,
        labelRemovalErrors: labelRemoval.labelRemovalErrors,
      };
    }
    return { decision };
  }

  const prompt = buildMergeAgentPrompt(job);
  const promptPath = writeMergeAgentPrompt(rootDir, job, prompt, { dispatchedAt: now });

  const args = [
    'dispatch',
    '--worker-class', 'merge-agent',
    '--task-kind', 'merge',
    '--repo', repo.split('/')[1] || repo,
    '--pr', String(prNumber),
    '--ticket', `PR-${prNumber}`,
    '--parent-session', parentSession,
    '--project', hqProject,
    '--prompt', promptPath,
  ];
  const { stdout } = await execFileImpl(hqPath, args, { maxBuffer: 5 * 1024 * 1024 });
  const parsed = parseMergeAgentDispatchOutput(stdout);

  recordMergeAgentDispatch(rootDir, job, {
    dispatchedAt: now,
    prompt,
    dispatchId: parsed?.dispatchId || null,
    launchRequestId: parsed?.lrq || parsed?.launchRequestId || null,
    trigger,
  });

  const labelRemoval = await removeConsumedTriggerLabel({
    repo,
    prNumber,
    labels,
    trigger,
    ghExecFileImpl,
    now,
  });
  if (labelRemoval.attempted) {
    updateMergeAgentDispatchLabelRemoval(rootDir, job, {
      trigger,
      attemptedAt: labelRemoval.labelRemovalAttempt.attemptedAt,
      removed: labelRemoval.labelRemovalAttempt.removed,
      error: labelRemoval.labelRemovalAttempt.error,
    });
  }

  return {
    decision,
    trigger,
    prompt,
    dispatchId: parsed?.dispatchId || null,
    launchRequestId: parsed?.lrq || parsed?.launchRequestId || null,
    operatorApprovalLabelRemoved: labelRemoval.operatorApprovalLabelRemoved,
    mergeAgentRequestedLabelRemoved: labelRemoval.mergeAgentRequestedLabelRemoved,
    labelRemovalErrors: labelRemoval.labelRemovalErrors,
  };
}

async function fetchMergeAgentCandidate(repo, prNumber, {
  execFileImpl = execFileAsync,
} = {}) {
  const { stdout } = await execFileImpl(
    'gh',
    [
      'pr',
      'view',
      String(prNumber),
      '--repo',
      repo,
      '--json',
      'mergeable,headRefName,baseRefName,headRefOid,body,labels,statusCheckRollup,state,mergedAt,closedAt,updatedAt,author',
    ],
    { maxBuffer: 5 * 1024 * 1024 }
  );
  const parsed = JSON.parse(String(stdout || '{}'));
  const labels = parsed.labels || [];
  const normalizedLabels = normalizeLabelNames(labels);
  const hasOperatorApproved = normalizedLabels.includes(OPERATOR_APPROVED_LABEL);
  const hasMergeAgentRequested = normalizedLabels.includes(MERGE_AGENT_REQUESTED_LABEL);
  const [operatorApprovalEvent, mergeAgentRequestEvent] = await Promise.all([
    hasOperatorApproved
      ? fetchLatestLabelEvent(repo, prNumber, OPERATOR_APPROVED_LABEL, { execFileImpl })
      : null,
    hasMergeAgentRequested
      ? fetchLatestLabelEvent(repo, prNumber, MERGE_AGENT_REQUESTED_LABEL, { execFileImpl })
      : null,
  ]);
  return {
    repo,
    prNumber,
    branch: parsed.headRefName,
    baseBranch: parsed.baseRefName,
    headSha: parsed.headRefOid || null,
    mergeable: parsed.mergeable || 'UNKNOWN',
    checksConclusion: summarizeChecksConclusion(parsed.statusCheckRollup),
    labels,
    operatorNotes: extractOperatorNotes(parsed.body),
    prState: parsed.mergedAt ? 'merged' : String(parsed.state || 'unknown').trim().toLowerCase(),
    merged: Boolean(parsed.mergedAt),
    prAuthor: parsed.author?.login || null,
    closedAt: parsed.closedAt || null,
    mergedAt: parsed.mergedAt || null,
    prUpdatedAt: parsed.updatedAt || null,
    operatorApprovalEvent,
    mergeAgentRequestEvent,
  };
}

function buildMergeAgentDispatchJob(rootDir, candidate) {
  const latestJob = findLatestFollowUpJobForPR(rootDir, {
    repo: candidate.repo,
    prNumber: candidate.prNumber,
  });
  return {
    ...candidate,
    lastVerdict: extractReviewVerdict(latestJob?.reviewBody),
    latestFollowUpJobStatus: latestJob?.status || null,
    remediationCurrentRound: Number(latestJob?.remediationPlan?.currentRound || 0),
    remediationMaxRounds: Number(latestJob?.remediationPlan?.maxRounds || 0),
    operatorApproval: buildScopedOperatorApproval(candidate, latestJob),
    mergeAgentRequest: buildScopedMergeAgentRequest(candidate),
  };
}

export {
  OPERATOR_APPROVED_LABEL,
  OPERATOR_SKIP_LABELS,
  buildMergeAgentDispatchJob,
  buildMergeAgentPrompt,
  buildScopedOperatorApproval,
  buildScopedMergeAgentRequest,
  dispatchMergeAgentForPR,
  extractOperatorNotes,
  extractReviewVerdict,
  fetchMergeAgentCandidate,
  findLatestFollowUpJobForPR,
  isScopedOperatorApproval,
  isScopedMergeAgentRequest,
  listMergeAgentDispatches,
  normalizeReviewVerdict,
  pickMergeAgentDispatch,
  pickMergeAgentDispatchDetail,
  recordMergeAgentDispatch,
  resolveMergeAgentParentSession,
  resolveMergeAgentProject,
  summarizeChecksConclusion,
  writeMergeAgentPrompt,
};

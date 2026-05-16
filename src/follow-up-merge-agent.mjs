import { execFile } from 'node:child_process';
import {
  constants as fsConstants,
  accessSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

import { writeFileAtomic } from './atomic-write.mjs';
import {
  MERGE_AGENT_REQUESTED_LABEL,
  OPERATOR_APPROVED_LABEL,
} from './adapters/operator/github-pr-label-controls/index.mjs';
import { getFollowUpJobDir, listFollowUpJobsInDir } from './follow-up-jobs.mjs';
import { fetchLatestLabelEvent } from './github-label-events.mjs';
import { extractReviewVerdict, normalizeReviewVerdict } from './review-verdict.mjs';

const execFileAsync = promisify(execFile);

const MERGE_AGENT_DISPATCH_SCHEMA_VERSION = 1;
const OPERATOR_SKIP_LABELS = new Set(['merge-agent-skip', 'merge-agent-stuck', 'do-not-merge']);
const DEFAULT_HQ_PATH = 'hq';
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
const DEFAULT_MERGE_AGENT_PARENT_SESSION = 'session:adversarial-review:watcher';
const DEFAULT_MERGE_AGENT_PROJECT = 'pr-merge-orchestration';
const SUCCESSFUL_CHECK_STATES = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const PENDING_CHECK_STATES = new Set(['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED', 'WAITING', 'REQUESTED']);

// Final-pass-on-request-changes is the opt-in escape valve for the
// convergence-loop deadlock observed on 2026-05-14: when the reviewer
// keeps returning Request changes and the round budget exhausts before
// any verdict turns clean, every PR halts and waits for the operator.
// With this flag enabled, the merge-agent is dispatched anyway once
// remediationCurrentRound >= remediationMaxRounds, on the explicit
// design assumption that the merge-agent's own comment_only_followups
// sub-worker is the right place to triage final reviewer findings
// (apply if trivial, defer if non-trivial, refuse to merge if a
// blocker-class issue is still standing).
//
// This is a behavioral change to the merge pipeline, so it is gated
// off by default. Operators flip MERGE_AGENT_FINAL_PASS_ON_REQUEST_CHANGES=1
// to enable it.
const FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER = 'final-pass-on-budget-exhausted';
const FINAL_PASS_ON_REQUEST_CHANGES_ENV = 'MERGE_AGENT_FINAL_PASS_ON_REQUEST_CHANGES';

function isFinalPassOnRequestChangesEnabled({ env = process.env } = {}) {
  const raw = env?.[FINAL_PASS_ON_REQUEST_CHANGES_ENV];
  if (raw == null) return false;
  const normalized = String(raw).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function isoNow() {
  return new Date().toISOString();
}

// Detect whether agent-os (the host OS that provides the `hq` worker-pool
// CLI + the merge-agent adapter) is present on this machine. The
// follow-up-merge-agent dispatch path is the only flow in adversarial-review
// that requires agent-os; everything else (watcher, reviewer, remediation)
// works standalone. So when agent-os is missing — OSS installs, fresh
// clones, CI sandboxes — we cleanly skip the merge-agent dispatch instead
// of blowing up on an ENOENT from `hq`.
//
// Detection order:
//   1. Explicit operator opt-out via `ADV_REVIEW_MERGE_AGENT_DISABLED=1`
//      (lets the operator force OSS mode even on a machine that has hq).
//   2. Explicit operator opt-in via `ADV_REVIEW_MERGE_AGENT_AGENT_OS=1`
//      (escape hatch for environments where detection misfires).
//   3. Explicit `hqPath` argument, when it is not the default `'hq'`.
//   4. `HQ_BIN` env var points to an existing file.
//   5. `hqPath` (defaults to `'hq'`) resolves on PATH.
// We resolve PATH in-process instead of spawning hq itself because hq can be
// slow to cold-start and we run this on every watcher tick.
function isExecutableFile(candidatePath, {
  fsImpl = { accessSync, existsSync, statSync },
} = {}) {
  if (!candidatePath) return false;
  const stat = fsImpl.statSync;
  if (typeof stat === 'function') {
    try {
      if (!stat(candidatePath).isFile()) return false;
    } catch {
      return false;
    }
  }
  if (typeof fsImpl.accessSync === 'function') {
    try {
      fsImpl.accessSync(candidatePath, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return Boolean(fsImpl.existsSync?.(candidatePath));
}

function resolveExecutableOnPath(command, {
  env = process.env,
  fsImpl = { accessSync, existsSync, statSync },
} = {}) {
  const trimmed = String(command ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return isExecutableFile(trimmed, { fsImpl }) ? trimmed : null;
  }
  const pathEntries = String(env.PATH ?? '').split(delimiter);
  for (const entry of pathEntries) {
    if (!entry) continue;
    const candidate = join(entry, trimmed);
    if (isExecutableFile(candidate, { fsImpl })) {
      return candidate;
    }
  }
  return null;
}

function detectAgentOsPresence({
  env = process.env,
  hqPath = DEFAULT_HQ_PATH,
  fsImpl = { accessSync, existsSync, statSync },
} = {}) {
  if (String(env.ADV_REVIEW_MERGE_AGENT_DISABLED ?? '').trim() === '1') {
    return { present: false, source: 'operator-disabled' };
  }
  if (String(env.ADV_REVIEW_MERGE_AGENT_AGENT_OS ?? '').trim() === '1') {
    return { present: true, source: 'operator-enabled' };
  }
  const trimmedHqPath = String(hqPath ?? '').trim();
  if (trimmedHqPath && trimmedHqPath !== DEFAULT_HQ_PATH) {
    const resolved = resolveExecutableOnPath(trimmedHqPath, { env, fsImpl });
    if (resolved) {
      return { present: true, source: 'arg:hqPath', path: resolved };
    }
    return { present: false, source: 'not-found' };
  }
  const hqBin = String(env.HQ_BIN ?? '').trim();
  if (hqBin && isExecutableFile(hqBin, { fsImpl })) {
    return { present: true, source: 'env:HQ_BIN', path: hqBin };
  }
  const resolved = resolveExecutableOnPath(trimmedHqPath || DEFAULT_HQ_PATH, { env, fsImpl });
  if (resolved) {
    return { present: true, source: 'path', path: resolved };
  }
  return { present: false, source: 'not-found' };
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

function summarizeChecksConclusion(statusCheckRollup) {
  if (!Array.isArray(statusCheckRollup)) {
    return null;
  }
  if (statusCheckRollup.length === 0) {
    return 'SUCCESS';
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

function mergeAgentSkippedDispatchDir(rootDir) {
  return join(getFollowUpJobDir(rootDir, 'pending'), '..', 'merge-agent-skips');
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

function mergeAgentSkippedDispatchFilePath(rootDir, job) {
  const safeRepo = sanitizeDispatchPathSegment(String(job?.repo ?? '').replace(/\//g, '__'));
  const safeSha = sanitizeDispatchPathSegment(String(job?.headSha || 'no-sha'));
  return join(
    mergeAgentSkippedDispatchDir(rootDir),
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

function listMergeAgentSkippedDispatches(rootDir) {
  const dir = mergeAgentSkippedDispatchDir(rootDir);
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

function buildMergeAgentPrompt(job, { trigger = null } = {}) {
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
  if (trigger) {
    lines.push(`- Dispatch trigger: ${trigger}`);
  }
  if (trigger === FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER) {
    lines.push('');
    lines.push('## Mode: final-pass-on-budget-exhausted');
    lines.push('');
    lines.push(
      'The adversarial-review round budget for this PR is consumed and the'
      + ' latest reviewer verdict is still `Request changes`. You are the'
      + ' final automated pass before operator escalation.'
    );
    lines.push('');
    lines.push('Required behavior:');
    lines.push(
      '1. Run `comment_only_followups.py` (your existing sub-worker triage'
      + ' step) against the latest review body. Apply every actionable'
      + ' in-scope finding inline. Use `suggestions_unable_to_apply` only'
      + ' for findings that genuinely should not be completed inside this'
      + ' PR (multi-PR scope, cross-module refactors, or conflicts with PR'
      + ' intent). For each such follow-up, file a Linear ticket before'
      + ' proceeding; do not leave the work only as prose in a PR comment'
      + ' and do not stop the PR merely because follow-up work exists.'
      + ' Refuse to merge if any blocker-class finding remains (data'
      + ' corruption, secret leakage, security regression, broken external'
      + ' contract). For non-empty'
      + ' `blockers_observed`, the refusal receipt/log summary must include'
      + ' only the blocker count plus normalized blocker kinds. Keep detailed'
      + ' blocker payloads exclusively in the workspace-local'
      + ' `.adversarial-follow-up/followups-reply.json` artifact; never copy'
      + ' blocker summaries, reasoning, quoted secrets, or sample payloads'
      + ' into PR comments, stdout/stderr summaries, or merge receipts.'
    );
    lines.push(
      '2. Proceed to rebase + merge when triage returns'
      + ' `no-followups-needed`, or when triage returns `addressed` after'
      + ' making light-to-medium code/config fixes. For light-to-medium'
      + ' fixes, force-push the updated head, wait for the required checks'
      + ' on that pushed head, then merge; do not request another review.'
      + ' Exit `awaiting-rereview` only when the in-PR fix is a major'
      + ' refactor whose review risk deserves another adversarial pass.'
      + ' If the remaining refactor work belongs across modules or future'
      + ' PRs, file the Linear tickets described above and proceed with this'
      + ' merge instead of using `awaiting-rereview` or stopping the PR.'
      + ' A non-empty `blockers_observed` result must hard-refuse the merge.'
    );
    lines.push(
      '3. Treat this dispatch the same way you would treat an'
      + ' `operator-approved` dispatch for review/remediation state, EXCEPT'
      + ' that the safety floor (no blocker-class merges) is stricter:'
      + ' the operator did not personally vouch for this head.'
    );
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
  finalPassOnRequestChangesEnabled = isFinalPassOnRequestChangesEnabled(),
} = {}) {
  return pickMergeAgentDispatchDetail(job, {
    recentDispatches,
    finalPassOnRequestChangesEnabled,
  }).decision;
}

function pickMergeAgentDispatchDetail(job, {
  recentDispatches = [],
  finalPassOnRequestChangesEnabled = isFinalPassOnRequestChangesEnabled(),
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
    finalPassOnRequestChangesEnabled,
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
  finalPassOnRequestChangesEnabled = false,
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
  if (checksConclusion === null) {
    return { decision: 'skip-checks-unknown', trigger: null };
  }
  if (checksConclusion === 'PENDING') {
    return { decision: 'skip-checks-pending', trigger: null };
  }
  if (checksConclusion !== 'SUCCESS') {
    return { decision: 'skip-checks-failed', trigger: null };
  }

  const remediationCurrentRound = Number(job?.remediationCurrentRound);
  const remediationMaxRounds = Number(job?.remediationMaxRounds);
  if (!Number.isFinite(remediationCurrentRound) || !Number.isFinite(remediationMaxRounds) || remediationMaxRounds <= 0) {
    return { decision: 'skip-remediation-state-unknown', trigger: null };
  } else if (
    remediationCurrentRound < remediationMaxRounds
    && normalizedVerdict === 'request-changes'
  ) {
    // request-changes verdict with budget left → let the remediation
    // loop continue. Merge-agent racing an in-flight remediation cycle
    // would either fight the remediation worker or merge a state the
    // reviewer asked to change.
    //
    // For a comment-only verdict we DO NOT wait for the round cap to
    // exhaust. Clean verdict = nothing to remediate = the pipeline has
    // reached its natural end and merge-agent should pick up now.
    // Previously this gate fired regardless of verdict, which forced
    // unnecessary review passes when round 1 was already clean and
    // contributed to PR #90's stuck state.
    return { decision: 'skip-remediation-claimable', trigger: null };
  }

  // Reaching this point means remediationCurrentRound >= remediationMaxRounds.
  // Verdict is one of: 'comment-only', 'request-changes', plus any normalized
  // verdict the kernel knows about. The legacy behavior was: refuse to
  // dispatch on Request changes once the budget is exhausted unless an
  // operator-approved label was applied. In practice the reviewer almost
  // always returns Request changes on the final round (see follow-up-jobs.mjs
  // notes near LEGACY_DEFAULT_MAX_REMEDIATION_ROUNDS), which means every PR
  // converged to "operator must admin-merge" — the daemon never auto-merged
  // a single PR in the observed window leading up to 2026-05-14.
  //
  // With FINAL_PASS_ON_BUDGET_EXHAUSTED enabled, we let merge-agent take the
  // final pass: it owns the comment_only_followups sub-worker path, which is
  // already designed to triage non-blocking findings (apply if trivial,
  // defer if non-trivial) and refuse to merge when a blocker-class issue
  // is still standing. The trigger value lets the dispatch record and the
  // merge-agent prompt distinguish this from an operator-approved override.
  if (
    normalizedVerdict === 'request-changes'
    && !operatorApproved
    && finalPassOnRequestChangesEnabled
  ) {
    return {
      decision: 'dispatch',
      trigger: FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER,
    };
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
  // Self-approval check intentionally removed at single-operator scale; see
  // buildScopedOperatorApproval for the design note. Re-introduce the
  // distinct-actor rule when there is a second human reviewer.
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
  // Self-approval check intentionally removed at single-operator scale: every
  // PR is authored by the operator's gh CLI identity (workers push under the
  // operator's GitHub account), so requiring a distinct actor was a 100%
  // false-positive rule and made `operator-approved` non-functional. The
  // headSha + codeScopedAt + commit-timing checks below remain as the real
  // freshness gates. Re-introduce a distinct-actor check when there is a
  // second human reviewer.
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

function recordMergeAgentSkippedDispatch(rootDir, job, {
  skippedAt = isoNow(),
  decision,
  trigger = null,
  agentOsState = null,
  labelRemoval = null,
} = {}) {
  const dir = mergeAgentSkippedDispatchDir(rootDir);
  mkdirSync(dir, { recursive: true });
  const filePath = mergeAgentSkippedDispatchFilePath(rootDir, job);
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
    skippedAt,
    decision,
    agentOsDetectionSource: agentOsState?.source || null,
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
  hqPath = DEFAULT_HQ_PATH,
  agentOsDetectImpl = detectAgentOsPresence,
  env = process.env,
} = {}) {
  const runtimeEnv = { ...process.env, ...env };
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
    // Honor the merged runtime env so callers can opt-in per-invocation
    // without mutating process.env globally. This keeps the flag consistent
    // with the rest of dispatchMergeAgentForPR (agent-os detection, parent
    // session, project) which already routes through runtimeEnv.
    finalPassOnRequestChangesEnabled: isFinalPassOnRequestChangesEnabled({ env: runtimeEnv }),
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

  // OSS guard. If agent-os (hq + merge-agent adapter) is not present on
  // this host, skip only brand-new merge-agent launches. Existing dispatch
  // records still flow through the idempotent label-reconciliation path
  // above, so consumed trigger labels keep converging after a host mode
  // change or temporary hq outage.
  const agentOsState = agentOsDetectImpl({ env: runtimeEnv, hqPath });
  if (!agentOsState.present) {
    const labelRemoval = await removeConsumedTriggerLabel({
      repo,
      prNumber,
      labels,
      trigger,
      ghExecFileImpl,
      now,
    });
    const skippedRecordPath = recordMergeAgentSkippedDispatch(rootDir, job, {
      skippedAt: now,
      decision: 'skip-no-agent-os',
      trigger,
      agentOsState,
      labelRemoval: labelRemoval.labelRemovalAttempt || null,
    });
    return {
      decision: 'skip-no-agent-os',
      agentOsDetectionSource: agentOsState.source,
      trigger,
      skippedRecordPath,
      operatorApprovalLabelRemoved: labelRemoval.operatorApprovalLabelRemoved,
      mergeAgentRequestedLabelRemoved: labelRemoval.mergeAgentRequestedLabelRemoved,
      labelRemovalErrors: labelRemoval.labelRemovalErrors,
    };
  }
  const resolvedHqPath = agentOsState.path || hqPath;
  const parentSession = resolveMergeAgentParentSession(runtimeEnv);
  const hqProject = resolveMergeAgentProject(runtimeEnv);

  const prompt = buildMergeAgentPrompt(job, { trigger });
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
  // Machine-readable trigger for the worker. The prompt also carries it
  // for human/agent readability, but adapters that branch on dispatch mode
  // should read the env var rather than parsing markdown.
  const dispatchEnv = trigger
    ? { ...runtimeEnv, MERGE_AGENT_DISPATCH_TRIGGER: trigger }
    : runtimeEnv;
  const { stdout } = await execFileImpl(resolvedHqPath, args, {
    env: dispatchEnv,
    maxBuffer: 5 * 1024 * 1024,
  });
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
  operatorApprovalEvent = undefined,
  mergeAgentRequestEvent = undefined,
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
  const [resolvedOperatorApprovalEvent, resolvedMergeAgentRequestEvent] = await Promise.all([
    hasOperatorApproved && operatorApprovalEvent === undefined
      ? fetchLatestLabelEvent(repo, prNumber, OPERATOR_APPROVED_LABEL, { execFileImpl })
      : operatorApprovalEvent ?? null,
    hasMergeAgentRequested && mergeAgentRequestEvent === undefined
      ? fetchLatestLabelEvent(repo, prNumber, MERGE_AGENT_REQUESTED_LABEL, { execFileImpl })
      : mergeAgentRequestEvent ?? null,
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
    operatorApprovalEvent: resolvedOperatorApprovalEvent,
    mergeAgentRequestEvent: resolvedMergeAgentRequestEvent,
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
  FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER,
  FINAL_PASS_ON_REQUEST_CHANGES_ENV,
  OPERATOR_APPROVED_LABEL,
  MERGE_AGENT_REQUESTED_LABEL,
  OPERATOR_SKIP_LABELS,
  buildMergeAgentDispatchJob,
  buildMergeAgentPrompt,
  buildScopedOperatorApproval,
  buildScopedMergeAgentRequest,
  detectAgentOsPresence,
  dispatchMergeAgentForPR,
  extractOperatorNotes,
  extractReviewVerdict,
  fetchMergeAgentCandidate,
  findLatestFollowUpJobForPR,
  isFinalPassOnRequestChangesEnabled,
  isScopedOperatorApproval,
  isScopedMergeAgentRequest,
  listMergeAgentDispatches,
  listMergeAgentSkippedDispatches,
  normalizeReviewVerdict,
  pickMergeAgentDispatch,
  pickMergeAgentDispatchDetail,
  recordMergeAgentDispatch,
  resolveMergeAgentParentSession,
  resolveMergeAgentProject,
  summarizeChecksConclusion,
  writeMergeAgentPrompt,
};

import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { getFollowUpJobDir, listFollowUpJobsInDir } from './follow-up-jobs.mjs';

const execFileAsync = promisify(execFile);

const MERGE_AGENT_DISPATCH_SCHEMA_VERSION = 1;
const OPERATOR_SKIP_LABELS = new Set(['merge-agent-skip', 'do-not-merge']);
// `operator-approved` is a mobile-friendly override the operator can
// apply from the GitHub iOS/Android app (or the web UI) to say
// "I've read the review, the substance is fine, please dispatch the
// merge-agent and merge this PR even though the verdict is
// `Request changes`." This is the escape valve when the codex/claude
// reviewer's verdict is overcautious but the review-of-review loop
// has converged or the operator has decided manually.
//
// The label ONLY overrides the `request-changes` verdict skip. It
// does NOT override:
//   - `not-mergeable` (force-merging a conflicted PR is ~always wrong)
//   - `checks-failed` / `checks-pending` (CI is a hard gate)
//   - `merge-agent-skip` / `do-not-merge` (those signal "absolutely
//     do not merge"; if both are present, skip wins)
//   - `pr-not-open` / `merged` (trivially N/A)
const OPERATOR_APPROVED_LABEL = 'operator-approved';
const SUCCESSFUL_CHECK_STATES = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const PENDING_CHECK_STATES = new Set(['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED', 'WAITING', 'REQUESTED']);

function isoNow() {
  return new Date().toISOString();
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
  const normalizedVerdict = normalizeReviewVerdict(job?.lastVerdict);
  const labels = new Set(normalizeLabelNames(job?.labels));
  const operatorApproved = labels.has(OPERATOR_APPROVED_LABEL);

  // Hard skips that even an operator override does NOT bypass:
  // closed/merged PRs, conflicting trees, failed/pending CI, or an
  // explicit do-not-merge label. The operator-approved label only
  // says "I'm OK with the review verdict", not "ignore CI/conflicts".
  if (normalizedVerdict === null && !operatorApproved) {
    return 'skip-no-verdict';
  }
  if (normalizedVerdict === 'request-changes' && !operatorApproved) {
    return 'skip-request-changes';
  }
  if (normalizedVerdict === 'unknown' && !operatorApproved) {
    return 'skip-unknown-verdict';
  }

  if (String(job?.prState ?? '').trim().toLowerCase() !== 'open' || Boolean(job?.merged)) {
    return 'skip-pr-not-open';
  }

  if (String(job?.mergeable ?? '').trim().toUpperCase() !== 'MERGEABLE') {
    return 'skip-not-mergeable';
  }

  if ([...OPERATOR_SKIP_LABELS].some((label) => labels.has(label))) {
    // Skip-labels win even when operator-approved is also present.
    // If both are applied (e.g. operator added approved earlier and
    // then changed their mind), refuse to dispatch — the more
    // conservative signal wins.
    return 'skip-operator-skip';
  }

  const checksConclusion = job?.checksConclusion == null
    ? null
    : String(job.checksConclusion).trim().toUpperCase();
  if (checksConclusion === 'PENDING') {
    return 'skip-checks-pending';
  }
  if (checksConclusion !== null && checksConclusion !== 'SUCCESS') {
    return 'skip-checks-failed';
  }

  const latestFollowUpJobStatus = String(job?.latestFollowUpJobStatus ?? '').trim().toLowerCase();
  if (latestFollowUpJobStatus === 'pending' || latestFollowUpJobStatus === 'in-progress') {
    return 'skip-remediation-active';
  }

  const remediationCurrentRound = Number(job?.remediationCurrentRound);
  const remediationMaxRounds = Number(job?.remediationMaxRounds);
  if (!Number.isFinite(remediationCurrentRound) || !Number.isFinite(remediationMaxRounds) || remediationMaxRounds <= 0) {
    if (operatorApproved) {
      // Operator-approved bypasses the unknown-state guard — they've
      // told us to merge regardless of where the remediation ledger
      // thinks we are.
    } else {
      return 'skip-remediation-state-unknown';
    }
  } else if (remediationCurrentRound < remediationMaxRounds && !operatorApproved) {
    // More remediation rounds available — let the loop continue.
    // operator-approved bypasses this check: when the operator says
    // "merge as-is", we don't burn another round just because the
    // budget allows it.
    return 'skip-remediation-claimable';
  }

  const alreadyDispatched = recentDispatches.some((entry) => (
    String(entry?.repo ?? '') === String(job?.repo ?? '')
    && Number(entry?.prNumber) === Number(job?.prNumber)
    && String(entry?.headSha ?? '') === String(job?.headSha ?? '')
  ));
  if (alreadyDispatched) {
    return 'skip-already-dispatched';
  }

  return 'dispatch';
}

function recordMergeAgentDispatch(rootDir, job, {
  dispatchedAt = isoNow(),
  prompt,
  dispatchId = null,
  launchRequestId = null,
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
    dispatchedAt,
    dispatchId,
    launchRequestId,
    prompt,
  };
  writeFileSync(filePath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return filePath;
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
  latestFollowUpJobStatus = null,
  remediationCurrentRound = null,
  remediationMaxRounds = null,
  execFileImpl = execFileAsync,
  now = isoNow(),
  hqPath = 'hq',
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
    latestFollowUpJobStatus,
    remediationCurrentRound,
    remediationMaxRounds,
  };
  const recordedDispatch = getRecordedMergeAgentDispatch(rootDir, job);
  const decision = pickMergeAgentDispatch(job, {
    recentDispatches: recordedDispatch ? [recordedDispatch] : [],
  });
  if (decision !== 'dispatch') {
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
    '--prompt', promptPath,
  ];
  const { stdout } = await execFileImpl(hqPath, args, { maxBuffer: 5 * 1024 * 1024 });
  const parsed = parseMergeAgentDispatchOutput(stdout);

  recordMergeAgentDispatch(rootDir, job, {
    dispatchedAt: now,
    prompt,
    dispatchId: parsed?.dispatchId || null,
    launchRequestId: parsed?.lrq || parsed?.launchRequestId || null,
  });

  return {
    decision,
    prompt,
    dispatchId: parsed?.dispatchId || null,
    launchRequestId: parsed?.lrq || parsed?.launchRequestId || null,
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
      'mergeable,headRefName,baseRefName,headRefOid,body,labels,statusCheckRollup,state,mergedAt,closedAt',
    ],
    { maxBuffer: 5 * 1024 * 1024 }
  );
  const parsed = JSON.parse(String(stdout || '{}'));
  return {
    repo,
    prNumber,
    branch: parsed.headRefName,
    baseBranch: parsed.baseRefName,
    headSha: parsed.headRefOid || null,
    mergeable: parsed.mergeable || 'UNKNOWN',
    checksConclusion: summarizeChecksConclusion(parsed.statusCheckRollup),
    labels: parsed.labels || [],
    operatorNotes: extractOperatorNotes(parsed.body),
    prState: parsed.mergedAt ? 'merged' : String(parsed.state || 'unknown').trim().toLowerCase(),
    merged: Boolean(parsed.mergedAt),
    closedAt: parsed.closedAt || null,
    mergedAt: parsed.mergedAt || null,
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
  };
}

export {
  buildMergeAgentDispatchJob,
  buildMergeAgentPrompt,
  dispatchMergeAgentForPR,
  extractOperatorNotes,
  extractReviewVerdict,
  fetchMergeAgentCandidate,
  findLatestFollowUpJobForPR,
  listMergeAgentDispatches,
  pickMergeAgentDispatch,
  recordMergeAgentDispatch,
  summarizeChecksConclusion,
  writeMergeAgentPrompt,
};

import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { getFollowUpJobDir, listFollowUpJobsInDir } from './follow-up-jobs.mjs';

const execFileAsync = promisify(execFile);

const MERGE_AGENT_DISPATCH_SCHEMA_VERSION = 1;
const DEFAULT_DISPATCH_WINDOW_MINUTES = 10;
const OPERATOR_SKIP_LABELS = new Set(['merge-agent-skip', 'merge-agent-stuck']);
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
  return text.slice(0, 2_000);
}

function extractReviewVerdict(reviewBody) {
  const match = String(reviewBody ?? '').match(/##\s+Verdict\s*\n([^\n]+)/i);
  return match ? match[1].trim() : null;
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
  now = isoNow(),
  recentDispatches = [],
  windowMinutes = DEFAULT_DISPATCH_WINDOW_MINUTES,
} = {}) {
  if (String(job?.lastVerdict ?? '').trim() === 'Request changes') {
    return 'skip-request-changes';
  }

  if (String(job?.mergeable ?? '').trim().toUpperCase() !== 'MERGEABLE') {
    return 'skip-not-mergeable';
  }

  const labels = new Set(normalizeLabelNames(job?.labels));
  if ([...OPERATOR_SKIP_LABELS].some((label) => labels.has(label))) {
    return 'skip-operator-skip';
  }

  const checksConclusion = job?.checksConclusion == null
    ? null
    : String(job.checksConclusion).trim().toUpperCase();
  if (checksConclusion !== null && checksConclusion !== 'SUCCESS') {
    return 'skip-checks-pending';
  }

  const windowMs = Math.max(0, Number(windowMinutes) || 0) * 60 * 1000;
  const nowMs = Date.parse(now);
  const alreadyDispatched = recentDispatches.some((entry) => (
    String(entry?.repo ?? '') === String(job?.repo ?? '')
    && Number(entry?.prNumber) === Number(job?.prNumber)
    && String(entry?.headSha ?? '') === String(job?.headSha ?? '')
    && Number.isFinite(Date.parse(entry?.dispatchedAt))
    && Number.isFinite(nowMs)
    && (nowMs - Date.parse(entry.dispatchedAt)) >= 0
    && (nowMs - Date.parse(entry.dispatchedAt)) < windowMs
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
  const safeRepo = String(job.repo).replace(/\//g, '__');
  const safeSha = String(job.headSha || 'no-sha').replace(/[^A-Za-z0-9._-]/g, '-');
  const safeTs = String(dispatchedAt).replace(/[:.]/g, '-');
  const filePath = join(dir, `${safeRepo}-pr-${job.prNumber}-${safeSha}-${safeTs}.json`);
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
  const safeRepo = String(job.repo).replace(/\//g, '__');
  const safeSha = String(job.headSha || 'no-sha').replace(/[^A-Za-z0-9._-]/g, '-');
  const safeTs = String(dispatchedAt).replace(/[:.]/g, '-');
  const filePath = join(dir, `${safeRepo}-pr-${job.prNumber}-${safeSha}-${safeTs}.md`);
  writeFileSync(filePath, prompt, 'utf8');
  return filePath;
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
  execFileImpl = execFileAsync,
  now = isoNow(),
  windowMinutes = DEFAULT_DISPATCH_WINDOW_MINUTES,
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
  };
  const recentDispatches = listMergeAgentDispatches(rootDir);
  const decision = pickMergeAgentDispatch(job, {
    now,
    recentDispatches,
    windowMinutes,
  });
  if (decision !== 'dispatch') {
    return { decision };
  }

  const prompt = buildMergeAgentPrompt(job);
  const promptPath = writeMergeAgentPrompt(rootDir, job, prompt, { dispatchedAt: now });
  recordMergeAgentDispatch(rootDir, job, { dispatchedAt: now, prompt });

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

  let parsed = null;
  try {
    parsed = JSON.parse(String(stdout || '').trim());
  } catch {}

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
      'mergeable,headRefName,baseRefName,headRefOid,body,labels,statusCheckRollup',
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
  };
}

export {
  DEFAULT_DISPATCH_WINDOW_MINUTES,
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

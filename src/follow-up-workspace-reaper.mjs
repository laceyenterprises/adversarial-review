import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { getConfig } from './config-loader.mjs';
import { fetchLivePRLifecycle } from './review-state.mjs';
import { probeWorkerDirectoryUse } from './ama/closer-worktree-reaper.mjs';
import { withFollowUpJobLock } from './follow-up-job-write.mjs';
import { getFollowUpJobDir, readTerminalWorkspaceJobForId, reapTerminalFollowUpWorkspaces } from './follow-up-jobs.mjs';

const execFileAsync = promisify(execFile);
let passOffset = 0;

function workspaceTarget(name) {
  const match = /^([^/]+)__([^/]+)-pr-(\d+)-(?:\d+|\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?Z)(?:\.resume-backup-\d+-\d+)?$/u.exec(name);
  return match ? { repo: `${match[1]}/${match[2]}`, prNumber: Number(match[3]) } : null;
}

// Read primary records in every status and archive month. A corrupt record can
// conceal ownership, so fail the pass closed rather than calling it an orphan.
function jobInventory(rootDir) {
  const jobs = [];
  function scan(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (entry.name.endsWith('.json')) jobs.push(JSON.parse(readFileSync(path, 'utf8')));
    }
  }
  for (const key of ['pending', 'inProgress', 'completed', 'failed', 'stopped', 'stoppedArchived']) {
    scan(getFollowUpJobDir(rootDir, key));
  }
  return jobs;
}

function referencesWorkspace(job, path) {
  return [job.workspaceDir, job.workspacePath, job.remediationWorker?.workspaceDir, job.remediationWorker?.workspacePath,
    ...(job.remediationPlan?.rounds || []).map((round) => round.worker?.workspaceDir)]
    .filter(Boolean).some((reference) => {
      const candidate = resolve(reference);
      return candidate === path || candidate.startsWith(`${path}${sep}`);
    });
}

function activeReference(jobs, path, target, jobId) {
  return jobs.some((job) => (['pending', 'in_progress'].includes(job.status) || liveWorker(job)) && (
    job.jobId === jobId || referencesWorkspace(job, path)
    || (job.repo === target.repo && Number(job.prNumber) === target.prNumber)
  ));
}

function liveWorker(job) {
  const workers = [job.remediationWorker, ...(job.remediationPlan?.rounds || []).map((round) => round.worker)];
  return workers.some((worker) => {
    const pid = Number(worker?.processId);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (err) { return err.code !== 'ESRCH'; }
  });
}

// Keep live lookups and CWD probes asynchronous; the only deletion on the tick
// is an atomic rename into trash. The shared writer lock protects the final
// ownership check and rename from a concurrent resume/claim.
async function reapFollowUpWorkspaces({
  rootDir,
  workspaceRootDir,
  nowMs = Date.now(),
  ttlMs = getConfig('retention.ephemeral.follow_up_workspaces_keep_hours', 72) * 3600_000,
  maxPrLookups = 256,
  budgetMs = 30_000,
  clockImpl = Date.now,
  lookupPRImpl = fetchLivePRLifecycle,
  probeDirectoryImpl = null,
  execCwdImpl = execFileAsync,
  logImpl = console.log,
  logErrorImpl = console.error,
  ...trashOptions
} = {}) {
  const metrics = { reapedPrDone: 0, reapedOrphan: 0, keptOpenPr: 0, prLookups: 0 };
  const decisions = new Map();
  const cache = new Map();
  const started = clockImpl();
  let visited = 0;
  if (workspaceRootDir && existsSync(workspaceRootDir)) {
    let jobs;
    try { jobs = jobInventory(rootDir); }
    catch (err) { logErrorImpl(`[follow-up-jobs] Workspace ownership unreadable: ${err.message}`); }
    const entries = readdirSync(workspaceRootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== '.reap-trash')
      .sort((a, b) => a.name.localeCompare(b.name));
    const offset = entries.length ? passOffset % entries.length : 0;
    const ordered = [...entries.slice(offset), ...entries.slice(0, offset)];
    // Rotate capped/budgeted passes so a retained open-PR prefix cannot starve
    // later workspaces. The daemon retains this cursor between hourly passes.
    passOffset = offset;
    for (const entry of ordered) {
      if (clockImpl() - started < budgetMs && metrics.prLookups < maxPrLookups) visited += 1;
      const path = resolve(workspaceRootDir, entry.name);
      const target = workspaceTarget(entry.name);
      const jobId = entry.name.replace(/\.resume-backup-\d+-\d+$/u, '');
      let reason = 'unknown-target';
      let reap = false;
      let orphan = false;
      let prDone = false;
      try {
        if (!jobs) reason = 'unreadable-job-inventory';
        else if (!target) reason = 'unknown-target';
        else if (activeReference(jobs, path, target, jobId)) reason = 'active-job';
        else if (clockImpl() - started >= budgetMs) reason = 'pass-budget';
        else {
          const key = `${target.repo}#${target.prNumber}`;
          if (!cache.has(key) && metrics.prLookups < maxPrLookups) {
            metrics.prLookups += 1;
            cache.set(key, await lookupPRImpl({ ...target, timeoutMs: Math.max(1, Math.min(2000, budgetMs - (clockImpl() - started))) }));
          }
          const lifecycle = cache.get(key);
          if (!lifecycle || lifecycle.source !== 'live') reason = 'pr-state-unknown-or-capped';
          else if (!['open', 'merged', 'closed'].includes(lifecycle.prState)) reason = 'pr-state-unknown';
          else {
            prDone = ['merged', 'closed'].includes(lifecycle.prState);
            const records = jobs.filter((job) => job.jobId === jobId || referencesWorkspace(job, path));
            orphan = records.length === 0;
            const { terminalJob } = readTerminalWorkspaceJobForId(rootDir, jobId, { logErrorImpl });
            const timestamps = [terminalJob?.completedAt, terminalJob?.failedAt, terminalJob?.stoppedAt].map(Date.parse).filter(Number.isFinite);
            const ageFrom = orphan ? statSync(path).mtimeMs : timestamps.length ? Math.max(...timestamps) : NaN;
            if (!prDone && (!Number.isFinite(ageFrom) || nowMs - ageFrom < ttlMs)) {
              metrics.keptOpenPr += 1;
              reason = 'open-pr-retained';
            } else if (!prDone && !orphan && !terminalJob) reason = 'nonterminal-record';
            else {
              reap = true;
              reason = orphan ? (prDone ? 'orphan-pr-done' : 'orphan-open-ttl') : (prDone ? 'pr-done' : 'open-pr-ttl');
            }
          }
        }
      } catch (err) { reason = `probe-error:${err.message}`; }
      decisions.set(path, { reap, reason, orphan, prDone, target, jobId });
    }
  }
  // One unscoped lsof snapshot per pass, after PR lookups and immediately
  // before the locked ownership check. The existing probe still verifies UID
  // visibility and fails closed on diagnostics, timeouts, and cross-UID paths.
  let cwdSnapshot;
  const probe = probeDirectoryImpl || ((options) => probeWorkerDirectoryUse({
    ...options,
    execFileImpl: (...args) => { cwdSnapshot ||= execCwdImpl(...args); return cwdSnapshot; },
  }));
  for (const [path, decision] of decisions) {
    if (decision.reap) {
      try {
        const use = await probe({ workerDir: path, timeoutMs: 2000 });
        if (use.state !== 'inactive') { decision.reap = false; decision.reason = `cwd-${use.state}`; }
      } catch (err) { decision.reap = false; decision.reason = `cwd-probe-error:${err.message}`; }
    }
    logImpl(`[follow-up-jobs] workspace=${path} action=${decision.reap ? 'reap-candidate' : 'keep'} reason=${decision.reason}`);
  }
  passOffset += Math.max(1, visited);
  return withFollowUpJobLock(join(rootDir, 'data', 'follow-up-jobs'), () => {
    let currentJobs;
    try { currentJobs = jobInventory(rootDir); }
    catch (err) { logErrorImpl(`[follow-up-jobs] Workspace ownership recheck failed: ${err.message}`); }
    const result = reapTerminalFollowUpWorkspaces({
      ...trashOptions, rootDir, workspaceRootDir, nowMs, ttlMs, budgetMs, clockImpl, logErrorImpl,
      workspaceDecisionImpl: (path) => {
        const decision = decisions.get(resolve(path));
        if (!decision?.reap || !currentJobs || activeReference(currentJobs, resolve(path), decision.target, decision.jobId)) return { reap: false };
        return decision;
      },
    });
    for (const path of result.reapedPaths) {
      const decision = decisions.get(resolve(path));
      if (decision.prDone) metrics.reapedPrDone += 1;
      if (decision.orphan) metrics.reapedOrphan += 1;
      logImpl(`[follow-up-jobs] workspace=${path} action=reaped reason=${decision.reason}`);
    }
    return { ...result, ...metrics };
  });
}

export { reapFollowUpWorkspaces, workspaceTarget };

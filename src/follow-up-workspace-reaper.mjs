import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { getConfig } from './config-loader.mjs';
import { fetchLivePRLifecycle } from './review-state.mjs';
import { probeWorkerDirectoryUse } from './ama/closer-worktree-reaper.mjs';
import { getFollowUpJobDir, readTerminalWorkspaceJobForId, reapTerminalFollowUpWorkspaces, resolveWorkspaceReapBudgetMs } from './follow-up-jobs.mjs';

const execFileAsync = promisify(execFile);
let passOffset = 0;

function workspaceTarget(name) {
  const match = /^([^/]+)__([^/]+)-pr-(\d+)-(?:\d+|\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?Z)(?:-\d+)?(?:\.resume-backup-\d+-\d+)?$/u.exec(name);
  return match ? { repo: `${match[1]}/${match[2]}`, prNumber: Number(match[3]) } : null;
}

// Scope unreadable/vanished ownership by ledger filename. Opaque filenames or
// directory errors block new eligibility only, never offline terminal reaping.
function jobInventory(rootDir, {
  keys = ['pending', 'inProgress', 'completed', 'failed', 'stopped', 'stoppedArchived'],
  readFileImpl = readFileSync,
  logErrorImpl = console.error,
} = {}) {
  const jobs = [];
  const unreadableIds = [];
  let scanFailed = false;
  function scan(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (err) {
      if (err.code !== 'ENOENT') {
        scanFailed = true;
        logErrorImpl(`[follow-up-jobs] Workspace ownership directory unreadable ${dir}: ${err.message}`);
      }
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (entry.name.endsWith('.json')) {
        try {
          const job = JSON.parse(readFileImpl(path, 'utf8'));
          if (!job?.jobId || !job.status) throw new Error('missing job identity/status');
          jobs.push(job);
        } catch (err) {
          unreadableIds.push(entry.name.slice(0, -5));
          logErrorImpl(`[follow-up-jobs] Workspace ownership record unreadable ${path}: ${err.message}`);
        }
      }
    }
  }
  for (const key of keys) scan(getFollowUpJobDir(rootDir, key));
  return { jobs, unreadableIds, scanFailed };
}

function ownershipUnknown(inventory, target, jobId) {
  return inventory.scanFailed || inventory.unreadableIds.some((id) => {
    const owner = workspaceTarget(id);
    return id === jobId || !owner || samePR(owner, target);
  });
}

function samePR(left, right) {
  return left.repo?.toLowerCase() === right.repo?.toLowerCase()
    && Number(left.prNumber) === Number(right.prNumber);
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
  return jobs.some((job) => ['pending', 'in_progress'].includes(job.status) && (
    job.jobId === jobId || referencesWorkspace(job, path)
    || samePR(job, target)
  ));
}

async function boundedLookup(lookup, options) {
  let timer;
  try {
    // The subprocess timeout in fetchLivePRLifecycle excludes its throttle wait.
    return await Promise.race([
      Promise.resolve().then(() => lookup(options)),
      new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(null), options.timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

// Keep live lookups and CWD probes asynchronous; the only deletion on the tick
// is an atomic rename into trash. The shared writer lock protects the final
// ownership check and rename from writers. Claims/requeues also get an
// unconditional per-job active-ledger check in the inner reaper.
async function reapFollowUpWorkspaces({
  rootDir,
  workspaceRootDir,
  nowMs = Date.now(),
  ttlMs = getConfig('retention.ephemeral.follow_up_workspaces_keep_hours', 72) * 3600_000,
  maxPrLookups = 256,
  env = process.env,
  budgetMs = resolveWorkspaceReapBudgetMs(env),
  clockImpl = Date.now,
  lookupPRImpl = fetchLivePRLifecycle,
  probeDirectoryImpl = null,
  execCwdImpl = execFileAsync,
  readInventoryFileImpl = readFileSync,
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
    const inventory = jobInventory(rootDir, { readFileImpl: readInventoryFileImpl, logErrorImpl });
    const { jobs } = inventory;
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
        if (!target) reason = 'unknown-target';
        else if (ownershipUnknown(inventory, target, jobId)) reason = 'unreadable-job-inventory';
        else if (activeReference(jobs, path, target, jobId)) reason = 'active-job';
        else if (clockImpl() - started >= budgetMs) reason = 'pass-budget';
        else {
          const key = `${target.repo}#${target.prNumber}`;
          if (!cache.has(key) && metrics.prLookups < maxPrLookups) {
            metrics.prLookups += 1;
            cache.set(key, await boundedLookup(lookupPRImpl, { ...target, timeoutMs: Math.max(1, Math.min(2000, budgetMs - (clockImpl() - started))) }));
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
  const appliedDecisions = new Map();
  const result = reapTerminalFollowUpWorkspaces({
    ...trashOptions, rootDir, workspaceRootDir, nowMs, ttlMs, budgetMs, env, clockImpl, logErrorImpl,
    workspaceDecisionImpl: (path, lookup) => {
      const decision = decisions.get(resolve(path));
      if (!decision?.reap) return { reap: false };
      // Under the per-workspace lock, scan active statuses only. The inner
      // reaper has already re-read this candidate's terminal/archive records.
      const current = jobInventory(rootDir, { keys: ['pending', 'inProgress'], logErrorImpl });
      if (ownershipUnknown(current, decision.target, decision.jobId)
        || activeReference(current.jobs, resolve(path), decision.target, decision.jobId)
        || (decision.orphan && !decision.prDone && (lookup.terminalJob || lookup.unreadableJobRecords))) return { reap: false };
      appliedDecisions.set(resolve(path), decision);
      return decision;
    },
  });
  for (const path of result.reapedPaths) {
    const decision = appliedDecisions.get(resolve(path));
    if (decision?.reap && decision.prDone) metrics.reapedPrDone += 1;
    if (decision?.reap && decision.orphan) metrics.reapedOrphan += 1;
    logImpl(`[follow-up-jobs] workspace=${path} action=reaped reason=${decision?.reap ? decision.reason : 'terminal-ttl'}`);
  }
  return { ...result, ...metrics };
}

export { reapFollowUpWorkspaces, workspaceTarget };

// Stuck-claim sweep + heartbeat emitter + pre-spawn lifecycle recheck.
//
// Why this exists (LAC-957, 2026-05-31):
// On 2026-06-01 ~05:02Z the daemon claimed a remediation job for a PR
// that merged 19 seconds later. The remediator started, noticed the
// merged state, and died — but did NOT release the claim. Because
// maxConcurrent=1, every subsequent tick logged
// `activeAtStart=1 availableAtStart=0 spawned=0` and 6 pending jobs
// piled up behind the orphaned claim until an operator manually moved
// the in-progress JSON to stopped/.
//
// Recovery contract (the three primitives in this file):
//   1. Heartbeat: the daemon touches `lastHeartbeatAt` on each
//      in-progress JSON whose worker process is still alive. The
//      workers themselves are external CLIs (codex / claude) so they
//      cannot self-heartbeat; the daemon's per-tick liveness probe
//      stands in for them. Newly-spawned jobs are seeded with
//      `lastHeartbeatAt = spawnedAt` by `markFollowUpJobSpawned` so
//      the very first sweep pass after spawn sees a fresh timestamp.
//   2. Sweep: after the daemon's live-worker heartbeat pass, any
//      in-progress claim whose `lastHeartbeatAt` is
//      older than the stuck threshold (default 10m) is moved to
//      stopped/ with stopCode='stale-heartbeat'. Records with no
//      `lastHeartbeatAt` fall back to file mtime so legacy
//      pre-heartbeat claims still get reclaimed.
//   3. Pre-spawn lifecycle recheck: just before spawning a worker, the
//      daemon reruns the canonical lifecycle resolver/decision path. If
//      the PR merged/closed, the head changed, or an operator applied a
//      stale-drift label in the prep window, the claim is finalized with
//      the same consume-time stop contract instead of spawning.
//
// The sweep is intentionally a separate path from reconcile.
// Reconcile finalizes workers that exited cleanly (a final-message
// artifact exists; the PID is gone). The sweep is the catch-all for
// the residual class — worker exited without leaving the artifacts
// reconcile expects, OR the worker is "alive" by PID but wedged. The
// stale-heartbeat threshold (10m) is much larger than the tick
// interval (120s) so a temporarily-slow tick doesn't reclaim a healthy
// worker.

import { existsSync, mkdtempSync, promises as fsPromises, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  listInProgressFollowUpJobs,
  markFollowUpJobStopped,
  requeueInProgressFollowUpJobForRetry,
  writeFollowUpJob,
} from './follow-up-jobs.mjs';
import { lifecycleStopDecision, resolveJobPRLifecycleSafe } from './follow-up-lifecycle.mjs';

const IN_PROGRESS_STUCK_THRESHOLD_MS_ENV = 'ADVERSARIAL_FOLLOW_UP_IN_PROGRESS_STUCK_THRESHOLD_MS';
const DEFAULT_IN_PROGRESS_STUCK_THRESHOLD_MS = 10 * 60 * 1000;
const STALE_HEARTBEAT_STOP_CODE = 'stale-heartbeat';
const DIRTY_MERGE_PUSH_RETRY_DELAYS_MS = [250, 750, 1500];
const DIRTY_CONFLICT_SPEC_CAP = 8;
const MODULE_SPEC_SPLIT_HOME_MAP = new Map([
  ['modules/worker-pool', 'projects/worker-pool/SPEC.md'],
]);

function parseTimestampMs(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveInProgressStuckThresholdMs(env = process.env) {
  const raw = env?.[IN_PROGRESS_STUCK_THRESHOLD_MS_ENV];
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_IN_PROGRESS_STUCK_THRESHOLD_MS;
  }
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_IN_PROGRESS_STUCK_THRESHOLD_MS;
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function normalizeBranchName(value) {
  const trimmed = String(value || '').trim();
  return trimmed || null;
}

function isDirtyMergeState(lifecycle) {
  return String(lifecycle?.mergeStateStatus || lifecycle?.mergeableState || '').trim().toUpperCase() === 'DIRTY';
}

function dirtyErrorText(err) {
  return `${err?.message || ''}\n${err?.stderr || ''}\n${err?.stdout || ''}`.toLowerCase();
}

function markDirtyTransientExhausted(err, phase, attempts) {
  err.dirtyTransientExhausted = true;
  err.dirtyTransientPhase = phase;
  err.dirtyTransientAttempts = attempts;
  return err;
}

function isDirtyMergeTransientExhaustedError(err) {
  return err?.dirtyTransientExhausted === true;
}

function isTransientDirtyNetworkError(err) {
  const text = dirtyErrorText(err);
  return [
    'tls handshake timeout',
    'connection reset',
    'connection reset by peer',
    'connection timed out',
    'timeout',
    'temporarily unavailable',
    'temporary failure',
    '503',
    '502',
    '504',
    'github unavailable',
    'the remote end hung up unexpectedly',
    'unable to access',
    'could not read from remote repository',
    'failed to connect',
    "couldn't connect",
    'connection refused',
    'network is unreachable',
    'could not resolve host',
  ].some((needle) => text.includes(needle));
}

function isTransientDirtyPushError(err) {
  return isTransientDirtyNetworkError(err);
}

function isTransientDirtyFetchError(err) {
  if (isTransientDirtyNetworkError(err)) return true;
  const text = dirtyErrorText(err);
  return [
    'index.lock',
    'unable to create',
    'another git process',
    'lock file exists',
  ].some((needle) => text.includes(needle));
}

function isDirtyMergeConflictError(err) {
  const text = `${err?.stderr || ''}\n${err?.stdout || ''}`.toLowerCase();
  return [
    'conflict (',
    'automatic merge failed',
    'merge failed',
  ].some((needle) => text.includes(needle));
}

function isTransientDirtyMergeError(err) {
  const text = dirtyErrorText(err);
  return [
    'index.lock',
    'unable to create',
    'resource temporarily unavailable',
    'temporarily unavailable',
    'input/output error',
    ' eio',
  ].some((needle) => text.includes(needle));
}

async function pushDirtyMergeWithRetry({
  workspaceDir,
  branch,
  execFileImpl,
  retryDelaysMs = DIRTY_MERGE_PUSH_RETRY_DELAYS_MS,
}) {
  const resolvedBranch = normalizeBranchName(branch);
  if (!resolvedBranch) {
    throw new Error('Cannot push DIRTY merge resolution without a PR branch name');
  }
  const args = ['-C', workspaceDir, 'push', 'origin', `HEAD:refs/heads/${resolvedBranch}`];
  const delays = [0, ...retryDelaysMs];
  let lastError = null;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) await sleep(delays[attempt]);
    try {
      const result = await execFileImpl('git', args, { maxBuffer: 10 * 1024 * 1024 });
      return { pushed: true, attempts: attempt + 1, result };
    } catch (err) {
      lastError = err;
      if (!isTransientDirtyPushError(err) || attempt === delays.length - 1) {
        err.dirtyPushAttempts = attempt + 1;
        if (isTransientDirtyPushError(err)) {
          markDirtyTransientExhausted(err, 'push', attempt + 1);
        }
        throw err;
      }
    }
  }
  throw lastError;
}

async function fetchDirtyMergeRefsWithRetry({
  workspaceDir,
  refs,
  execFileImpl,
  retryDelaysMs = DIRTY_MERGE_PUSH_RETRY_DELAYS_MS,
}) {
  const normalizedRefs = [...new Set((refs || []).map(normalizeBranchName).filter(Boolean))];
  if (normalizedRefs.length === 0) {
    throw new Error('DIRTY pre-spawn gate requires at least one git ref to fetch');
  }
  const refspecs = normalizedRefs.map((ref) => `+refs/heads/${ref}:refs/remotes/origin/${ref}`);
  const args = ['-C', workspaceDir, 'fetch', '--prune', 'origin', ...refspecs];
  const delays = [0, ...retryDelaysMs];
  let lastError = null;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) await sleep(delays[attempt]);
    try {
      const result = await execFileImpl('git', args, { maxBuffer: 10 * 1024 * 1024 });
      return { fetched: true, attempts: attempt + 1, result };
    } catch (err) {
      lastError = err;
      if (!isTransientDirtyFetchError(err) || attempt === delays.length - 1) {
        err.dirtyFetchAttempts = attempt + 1;
        if (isTransientDirtyFetchError(err)) {
          markDirtyTransientExhausted(err, 'fetch', attempt + 1);
        }
        throw err;
      }
    }
  }
  throw lastError;
}

async function addDirtyMergeWorktreeWithRetry({
  workspaceDir,
  worktreeDir,
  branch,
  execFileImpl,
  retryDelaysMs = DIRTY_MERGE_PUSH_RETRY_DELAYS_MS,
}) {
  const args = ['-C', workspaceDir, 'worktree', 'add', '--detach', worktreeDir, `origin/${branch}`];
  const delays = [0, ...retryDelaysMs];
  let lastError = null;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) await sleep(delays[attempt]);
    try {
      const result = await execFileImpl('git', args, { maxBuffer: 10 * 1024 * 1024 });
      return { added: true, attempts: attempt + 1, result };
    } catch (err) {
      lastError = err;
      if (!isTransientDirtyMergeError(err) || attempt === delays.length - 1) {
        err.dirtyWorktreeAddAttempts = attempt + 1;
        if (isTransientDirtyMergeError(err)) {
          markDirtyTransientExhausted(err, 'worktree-add', attempt + 1);
        }
        throw err;
      }
    }
  }
  throw lastError;
}

async function mergeDirtyBaseWithRetry({
  worktreeDir,
  baseBranch,
  execFileImpl,
  retryDelaysMs = DIRTY_MERGE_PUSH_RETRY_DELAYS_MS,
}) {
  const args = ['-C', worktreeDir, 'merge', '--no-edit', `origin/${baseBranch}`];
  const delays = [0, ...retryDelaysMs];
  let lastError = null;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) await sleep(delays[attempt]);
    try {
      const result = await execFileImpl('git', args, { maxBuffer: 10 * 1024 * 1024 });
      return { merged: true, attempts: attempt + 1, result };
    } catch (err) {
      lastError = err;
      if (isDirtyMergeConflictError(err)) {
        err.dirtyMergeAttempts = attempt + 1;
        throw err;
      }
      if (!isTransientDirtyMergeError(err) || attempt === delays.length - 1) {
        err.dirtyMergeAttempts = attempt + 1;
        if (isTransientDirtyMergeError(err)) {
          markDirtyTransientExhausted(err, 'merge', attempt + 1);
        }
        throw err;
      }
    }
  }
  throw lastError;
}

async function removeDirtyMergeWorktreeSafely({
  workspaceDir,
  worktreeDir,
  worktreeParent,
  execFileImpl,
  retryDelaysMs = DIRTY_MERGE_PUSH_RETRY_DELAYS_MS,
}) {
  const args = ['-C', workspaceDir, 'worktree', 'remove', '--force', worktreeDir];
  const delays = [0, ...retryDelaysMs];
  let removedGitWorktree = false;
  let lastError = null;
  try {
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      if (delays[attempt] > 0) await sleep(delays[attempt]);
      try {
        await execFileImpl('git', args, { maxBuffer: 10 * 1024 * 1024 });
        removedGitWorktree = true;
        break;
      } catch (err) {
        lastError = err;
        if (!isTransientDirtyMergeError(err) || attempt === delays.length - 1) {
          err.dirtyWorktreeCleanupFailed = true;
          err.dirtyWorktreeRemoveAttempts = attempt + 1;
          if (isTransientDirtyMergeError(err)) {
            markDirtyTransientExhausted(err, 'worktree-remove', attempt + 1);
          }
          throw err;
        }
      }
    }
  } finally {
    if (removedGitWorktree) {
      rmSync(worktreeParent, { recursive: true, force: true });
    }
  }
  if (!removedGitWorktree && lastError) throw lastError;
  return { removed: true };
}

async function attemptDirtyMerge({
  workspaceDir,
  baseBranch,
  branch,
  execFileImpl,
}) {
  const resolvedBase = normalizeBranchName(baseBranch);
  if (!workspaceDir || !existsSync(join(workspaceDir, '.git'))) {
    throw new Error('DIRTY pre-spawn gate requires a checked-out git workspace');
  }
  if (!resolvedBase) {
    throw new Error('DIRTY pre-spawn gate requires baseBranch');
  }
  const resolvedBranch = normalizeBranchName(branch);
  if (!resolvedBranch) {
    throw new Error('DIRTY pre-spawn gate requires a PR branch name');
  }
  const fetch = await fetchDirtyMergeRefsWithRetry({
    workspaceDir,
    refs: [resolvedBase, resolvedBranch],
    execFileImpl,
  });
  const worktreeParent = mkdtempSync(join(tmpdir(), 'dirty-pr-merge-'));
  const worktreeDir = join(worktreeParent, 'worktree');
  let worktreeAdded = false;
  let worktreeAdd = null;
  try {
    worktreeAdd = await addDirtyMergeWorktreeWithRetry({
      workspaceDir,
      worktreeDir,
      branch: resolvedBranch,
      execFileImpl,
    });
    worktreeAdded = true;
    const merge = await mergeDirtyBaseWithRetry({
      worktreeDir,
      baseBranch: resolvedBase,
      execFileImpl,
    });
    try {
      const push = await pushDirtyMergeWithRetry({
        workspaceDir: worktreeDir,
        branch: resolvedBranch,
        execFileImpl,
      });
      return { outcome: 'clean-merged', fetch, worktreeAdd, merge, push };
    } catch (err) {
      throw err;
    }
  } catch (err) {
    if (isDirtyMergeConflictError(err)) {
      const conflictedFiles = await listConflictedFiles({ workspaceDir: worktreeDir, execFileImpl });
      return { outcome: 'conflict', fetch, worktreeAdd, error: err, conflictedFiles };
    }
    throw err;
  } finally {
    if (worktreeAdded) {
      await removeDirtyMergeWorktreeSafely({
        workspaceDir,
        worktreeDir,
        worktreeParent,
        execFileImpl,
      });
    } else if (!existsSync(worktreeDir)) {
      rmSync(worktreeParent, { recursive: true, force: true });
    }
  }
}

async function listConflictedFiles({ workspaceDir, execFileImpl, log = console }) {
  try {
    const { stdout } = await execFileImpl('git', [
      '-C',
      workspaceDir,
      'diff',
      '--name-only',
      '--diff-filter=U',
    ], { maxBuffer: 10 * 1024 * 1024 });
    return String(stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
  } catch (err) {
    log?.warn?.(`[follow-up-remediation] failed to list conflicted files: ${err?.message || err}`);
    return [];
  }
}

function safeReadText(absPath) {
  try {
    if (!existsSync(absPath)) return null;
    return readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

function normalizeRepoRelativePath(filePath) {
  return String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function findProjectSpecByRef(repoRoot, specRef) {
  const ref = String(specRef || '').trim();
  if (!ref) return null;
  const project = ref.split('@')[0]?.trim();
  const direct = project ? join(repoRoot, 'projects', project, 'SPEC.md') : null;
  if (direct && existsSync(direct)) return direct;
  const projectsDir = join(repoRoot, 'projects');
  try {
    const stack = [projectsDir];
    while (stack.length) {
      const dir = stack.pop();
      for (const dirent of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, dirent.name);
        if (dirent.isDirectory()) {
          stack.push(abs);
        } else if (dirent.name === 'plan.json') {
          try {
            const parsed = JSON.parse(readFileSync(abs, 'utf8'));
            if (String(parsed?.specRef || '').trim() === ref) {
              const specPath = join(dirname(abs), 'SPEC.md');
              if (existsSync(specPath)) return specPath;
            }
          } catch {
            // Ignore malformed project metadata while looking for a match.
          }
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function discoverJobSpecRef(job) {
  const candidates = [
    job?.specRef,
    job?.goalLineage?.specRef,
    job?.lineage?.specRef,
    job?.remediationPlan?.specRef,
    job?.plan?.specRef,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (value) return value;
  }
  const lineageText = [
    job?.goalLineage,
    job?.lineage,
    job?.dispatchLineage,
    job?.reviewBody,
    job?.reviewSummary,
  ]
    .filter((value) => typeof value === 'string')
    .join('\n');
  const match = lineageText.match(/\bspecRef`?\s*[:=]\s*`?([A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+)`?/);
  return match?.[1] || null;
}

function owningModuleRoot(filePath) {
  const normalized = normalizeRepoRelativePath(filePath);
  const match = normalized.match(/^(modules|platform|agents|tools)\/([^/]+)(?:\/|$)/);
  return match ? `${match[1]}/${match[2]}` : null;
}

async function resolveModuleSpecPath(repoRoot, moduleRoot) {
  if (!moduleRoot) return null;
  const localSpec = join(repoRoot, moduleRoot, 'SPEC.md');
  if (existsSync(localSpec)) return localSpec;
  const mapped = MODULE_SPEC_SPLIT_HOME_MAP.get(moduleRoot);
  if (mapped && existsSync(join(repoRoot, mapped))) return join(repoRoot, mapped);

  const moduleName = moduleRoot.split('/')[1];
  const directProjectSpec = join(repoRoot, 'projects', moduleName, 'SPEC.md');
  if (existsSync(directProjectSpec)) return directProjectSpec;

  const projectsDir = join(repoRoot, 'projects');
  try {
    for (const projectName of await fsPromises.readdir(projectsDir)) {
      const planPath = join(projectsDir, projectName, 'plan.json');
      if (!existsSync(planPath)) continue;
      let parsed;
      try {
        parsed = JSON.parse(await fsPromises.readFile(planPath, 'utf8'));
      } catch {
        continue;
      }
      const text = JSON.stringify(parsed);
      if (text.includes(moduleRoot) || text.includes(moduleName)) {
        const specPath = join(projectsDir, projectName, 'SPEC.md');
        if (existsSync(specPath)) return specPath;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function makeSpecEvidenceEntry({ kind, path: absPath, repoRoot }) {
  const content = safeReadText(absPath);
  if (!content) return null;
  return {
    kind,
    path: normalizeRepoRelativePath(relative(repoRoot, absPath)),
    content,
  };
}

async function resolveDirtyConflictSpecContext({
  repoRoot,
  job,
  conflictedFiles,
  cap = DIRTY_CONFLICT_SPEC_CAP,
}) {
  const entries = [];
  const missing = [];
  const seen = new Set();
  const addEntry = (entry) => {
    if (!entry || !entry.path || seen.has(entry.path)) return;
    if (entries.length >= cap) {
      seen.add(entry.path);
      missing.push(`${entry.kind} ${entry.path} omitted by DIRTY conflict spec cap (${cap})`);
      return;
    }
    seen.add(entry.path);
    entries.push(entry);
  };

  const specRef = discoverJobSpecRef(job);
  const prSpecPath = findProjectSpecByRef(repoRoot, specRef);
  if (prSpecPath) {
    addEntry(makeSpecEvidenceEntry({ kind: 'pr-spec', path: prSpecPath, repoRoot }));
  } else {
    missing.push(specRef ? `PR spec ${specRef}` : 'PR specRef');
  }

  const moduleRoots = [...new Set((conflictedFiles || []).map(owningModuleRoot).filter(Boolean))];
  for (const moduleRoot of moduleRoots) {
    const agentsPath = join(repoRoot, moduleRoot, 'AGENTS.md');
    if (existsSync(agentsPath)) {
      addEntry(makeSpecEvidenceEntry({ kind: 'module-agents', path: agentsPath, repoRoot }));
    }
    const specPath = await resolveModuleSpecPath(repoRoot, moduleRoot);
    if (specPath) {
      addEntry(makeSpecEvidenceEntry({ kind: 'module-spec', path: specPath, repoRoot }));
    } else {
      missing.push(`${moduleRoot} SPEC.md`);
    }
  }

  return {
    ok: missing.length === 0,
    specRef,
    conflictedFiles: conflictedFiles || [],
    moduleRoots,
    entries,
    missing,
  };
}

function formatDirtyConflictSpecContext(context) {
  const sections = [];
  for (const entry of context.entries || []) {
    sections.push(`### ${entry.kind}: ${entry.path}\n\n${entry.content}`);
  }
  return sections.join('\n\n');
}

function buildDirtyConflictHammerPrompt({
  job,
  baseBranch,
  branch,
  conflictError,
  specContext,
}) {
  const conflictedFiles = (specContext.conflictedFiles || []).map((file) => `- ${file}`).join('\n') || '- (git did not report conflicted files)';
  const specsConsulted = (specContext.entries || []).map((entry) => `- ${entry.kind}: ${entry.path}`).join('\n') || '- None';
  const conflictText = String(conflictError?.stderr || conflictError?.stdout || conflictError?.message || 'merge conflict');
  return `# DIRTY PR Conflict Remediation HAMMER

PR: ${job?.repo}#${job?.prNumber}
Base branch: ${baseBranch}
PR branch: ${branch || '(unknown)'}

The pre-spawn lifecycle gate found GitHub mergeStateStatus=DIRTY. A local diagnostic merge of \`origin/${baseBranch}\` into the PR branch produced conflicts. Your workspace is isolated from that diagnostic index, so recreate the conflicted working tree first:

1. Refuse dirty state: \`git status --porcelain --untracked-files=all\` must be empty.
2. Fetch the current base: \`git fetch --prune origin ${baseBranch}\`.
3. Run \`git merge origin/${baseBranch}\` to reproduce the conflict markers in this worker workspace.
4. Resolve every conflict hunk according to the specs below. Never use \`-X ours\`, \`-X theirs\`, \`--theirs\`, or \`--skip\`. Preserve the acceptance criteria of both sides; do not mechanically choose one side.
5. Validate the resolved tree with the repo tests and the acceptance criteria in the specs below before committing.
6. Push the PR branch with bounded retry for transient network failures only. Terminal auth or permission errors must fail fast and be reported.
7. If the PR spec and a module spec are contradictory, a required spec is missing, or validation fails, do not push. Escalate with the conflict evidence and the specs consulted.

Conflicted files:
${conflictedFiles}

Specs consulted:
${specsConsulted}

Diagnostic merge evidence:
\`\`\`text
${conflictText}
\`\`\`

## Spec Context
${formatDirtyConflictSpecContext(specContext)}
`.trim();
}

// Resolve the timestamp the sweep should compare against the threshold.
// Preference order is documented inline; the fallback to file mtime
// keeps pre-heartbeat / hand-edited records reclaimable.
function resolveLastObservedAtMs(job, jobPath) {
  const heartbeatMs = parseTimestampMs(job?.lastHeartbeatAt);
  if (heartbeatMs !== null) {
    return { sourceMs: heartbeatMs, source: 'lastHeartbeatAt' };
  }
  const spawnedMs = parseTimestampMs(job?.remediationWorker?.spawnedAt);
  if (spawnedMs !== null) {
    return { sourceMs: spawnedMs, source: 'remediationWorker.spawnedAt' };
  }
  const claimedMs = parseTimestampMs(job?.claimedAt);
  if (claimedMs !== null) {
    return { sourceMs: claimedMs, source: 'claimedAt' };
  }
  try {
    const st = statSync(jobPath);
    return { sourceMs: st.mtimeMs, source: 'mtime' };
  } catch {
    return { sourceMs: null, source: 'unavailable' };
  }
}

function sweepStuckInProgressClaims({
  rootDir,
  nowMs = Date.now(),
  thresholdMs = resolveInProgressStuckThresholdMs(),
  log = console,
} = {}) {
  let scanned = 0;
  let reclaimed = 0;
  let skipped = 0;
  const reclaimedAtIso = new Date(nowMs).toISOString();

  for (const { job, jobPath } of listInProgressFollowUpJobs(rootDir)) {
    scanned += 1;
    if (job?.remediationWorker?.dispatchMode === 'hq') {
      skipped += 1;
      continue;
    }
    const { sourceMs, source } = resolveLastObservedAtMs(job, jobPath);
    if (sourceMs === null) {
      skipped += 1;
      continue;
    }
    const ageMs = nowMs - sourceMs;
    if (ageMs <= thresholdMs) {
      skipped += 1;
      continue;
    }

    const jobId = job?.jobId || basename(jobPath);
    const reasonText =
      `Reclaimed orphaned in-progress claim ${jobId}: ${source} is ` +
      `${Math.round(ageMs / 1000)}s old (threshold=${Math.round(thresholdMs / 1000)}s).`;

    markFollowUpJobStopped({
      rootDir,
      jobPath,
      stoppedAt: reclaimedAtIso,
      stopCode: STALE_HEARTBEAT_STOP_CODE,
      stopReason: reasonText,
      sourceStatus: 'in_progress',
      remediationWorker: {
        ...(job?.remediationWorker || {}),
        state: 'reclaimed-stale-heartbeat',
        reclaimedAt: reclaimedAtIso,
        reclaimReason: STALE_HEARTBEAT_STOP_CODE,
        reclaimAgeMs: ageMs,
        reclaimSource: source,
      },
    });
    reclaimed += 1;
    log.log?.(
      `[follow-up-tick ${reclaimedAtIso}] stale-claim-reclaimed jobId=${jobId} ageMs=${ageMs} ` +
      `source=${source} reason=${STALE_HEARTBEAT_STOP_CODE}`
    );
  }

  return { scanned, reclaimed, skipped, thresholdMs };
}

// Emit a heartbeat (`lastHeartbeatAt = now`) on every in-progress job
// whose worker process is still alive. Called once per tick from the
// daemon. Skips entries with no PID handle (HQ-dispatched jobs whose
// liveness is tracked by HQ, not by the daemon). Errors on individual
// records are swallowed so one bad JSON can't stop the rest.
function emitHeartbeatsForActiveJobs({
  rootDir,
  nowMs = Date.now(),
  isWorkerAlive,
  log = console,
} = {}) {
  if (typeof isWorkerAlive !== 'function') {
    throw new Error('emitHeartbeatsForActiveJobs requires isWorkerAlive');
  }
  let scanned = 0;
  let touched = 0;
  let skipped = 0;
  const heartbeatAt = new Date(nowMs).toISOString();
  for (const { job, jobPath } of listInProgressFollowUpJobs(rootDir)) {
    scanned += 1;
    const worker = job?.remediationWorker || {};
    const processId = Number(worker.processId);
    // HQ-dispatched workers don't have a daemon-owned PID; their
    // liveness is HQ's concern. Skip them rather than guess.
    if (worker.dispatchMode === 'hq' || !Number.isInteger(processId) || processId <= 0) {
      skipped += 1;
      continue;
    }
    let alive = false;
    try {
      alive = Boolean(isWorkerAlive(processId));
    } catch (err) {
      log.warn?.(
        `[follow-up-tick ${heartbeatAt}] heartbeat-liveness-failed jobId=${job?.jobId || basename(jobPath)}: ${err?.message || err}`
      );
      continue;
    }
    if (!alive) {
      skipped += 1;
      continue;
    }
    try {
      writeFollowUpJob(jobPath, { ...job, lastHeartbeatAt: heartbeatAt });
      touched += 1;
    } catch (err) {
      log.warn?.(
        `[follow-up-tick ${heartbeatAt}] heartbeat-write-failed jobId=${job?.jobId || basename(jobPath)}: ${err?.message || err}`
      );
    }
  }
  return { scanned, touched, skipped };
}

// Returns an action description (`continue` or `stopped`) so the caller
// knows whether to proceed with spawn. On `stopped` the gate has already
// moved the file out of `in-progress/` with the canonical consume-time
// stop semantics.
async function applyPreSpawnLifecycleGate({
  rootDir,
  job,
  jobPath,
  workspaceDir = null,
  promptPath = null,
  baseBranch = job?.baseBranch || null,
  resolvePRLifecycleImpl,
  execFileImpl,
  stopConsumedJobWithCommentImpl = null,
  postCommentImpl,
  dirtyMergeImpl = attemptDirtyMerge,
  resolveDirtyConflictSpecContextImpl = resolveDirtyConflictSpecContext,
  now = () => new Date().toISOString(),
  log = console,
} = {}) {
  const lifecycle = await resolveJobPRLifecycleSafe({
    rootDir,
    job,
    resolvePRLifecycleImpl,
    execFileImpl,
    log,
  });
  if (isDirtyMergeState(lifecycle)) {
    const nowIso = now();
    const resolvedBaseBranch = normalizeBranchName(baseBranch || lifecycle?.baseBranch || job?.baseBranch);
    const resolvedBranch = normalizeBranchName(job?.branch || lifecycle?.branch || lifecycle?.headRefName);
    let dirtyMerge;
    try {
      dirtyMerge = await dirtyMergeImpl({
        workspaceDir,
        baseBranch: resolvedBaseBranch,
        branch: resolvedBranch,
        execFileImpl,
      });
    } catch (err) {
      if (isDirtyMergeTransientExhaustedError(err)) {
        const requeuedAtMs = Date.parse(nowIso);
        const retryAfter = new Date((Number.isFinite(requeuedAtMs) ? requeuedAtMs : Date.now()) + 60_000).toISOString();
        const phase = err?.dirtyTransientPhase || 'unknown';
        const attempts = err?.dirtyTransientAttempts
          || err?.dirtyFetchAttempts
          || err?.dirtyWorktreeAddAttempts
          || err?.dirtyMergeAttempts
          || err?.dirtyPushAttempts
          || err?.dirtyWorktreeRemoveAttempts
          || null;
        const retryReason = `DIRTY pre-spawn merge resolution hit transient ${phase} failure after ${attempts || 'unknown'} attempt(s): ${err?.message || err}`;
        const requeued = requeueInProgressFollowUpJobForRetry({
          rootDir,
          jobPath,
          requeuedAt: nowIso,
          retryReason,
          retryMetadata: {
            code: 'dirty-merge-transient',
            recoverable: true,
            phase,
            attempts,
            dirtyMergeResolution: {
              outcome: 'transient-failed',
              error: err?.message || String(err),
              phase,
              attempts,
            },
          },
          allowDirectWorkerRetry: true,
          retryAfterOverride: retryAfter,
        });
        log.warn?.(
          `[follow-up-remediation ${nowIso}] dirty-pr-transient-requeued jobId=${job?.jobId} ` +
          `phase=${phase} attempts=${attempts || 'unknown'} retryAfter=${retryAfter}`
        );
        return { action: 'requeued', job: requeued.job, jobPath: requeued.jobPath, reason: 'dirty-merge-transient-failed' };
      }
      const stopped = markFollowUpJobStopped({
        rootDir,
        jobPath,
        stoppedAt: nowIso,
        stopCode: 'dirty-merge-resolution-failed',
        stopReason: `DIRTY pre-spawn merge resolution failed before worker spawn: ${err?.message || err}`,
        sourceStatus: 'in_progress',
        remediationWorker: {
          ...(job?.remediationWorker || {}),
          state: 'never-spawned',
          reconciledAt: nowIso,
          preSpawnLifecycleCheckAt: nowIso,
          dirtyMergeResolution: {
            outcome: 'failed',
            error: err?.message || String(err),
            pushAttempts: err?.dirtyPushAttempts || null,
          },
        },
      });
      return { action: 'stopped', job: stopped.job, jobPath: stopped.jobPath, reason: 'dirty-merge-resolution-failed' };
    }

    if (dirtyMerge?.outcome === 'clean-merged') {
      const nextJob = {
        ...job,
        baseBranch: resolvedBaseBranch || job?.baseBranch || null,
        branch: resolvedBranch || job?.branch || null,
        remediationWorker: {
          ...(job?.remediationWorker || {}),
          preSpawnLifecycleCheckAt: nowIso,
          dirtyMergeResolution: {
            outcome: 'clean-merged',
            pushed: true,
            pushAttempts: dirtyMerge?.push?.attempts || 1,
            resolvedAt: nowIso,
          },
        },
      };
      writeFollowUpJob(jobPath, nextJob);
      log.log?.(
        `[follow-up-remediation ${nowIso}] dirty-pr-clean-merged jobId=${job?.jobId} ` +
        `base=${resolvedBaseBranch} branch=${resolvedBranch}`
      );
      return { action: 'continue', reason: 'dirty-clean-merged', job: nextJob, jobPath };
    }

    if (dirtyMerge?.outcome === 'conflict') {
      const conflictedFiles = Array.isArray(dirtyMerge.conflictedFiles)
        ? dirtyMerge.conflictedFiles
        : [];
      const repoRoot = workspaceDir ? resolve(workspaceDir) : resolve(rootDir || '.');
      const specContext = await resolveDirtyConflictSpecContextImpl({
        repoRoot,
        job,
        conflictedFiles,
      });
      if (!specContext.ok || specContext.entries.length === 0) {
        const stopped = markFollowUpJobStopped({
          rootDir,
          jobPath,
          stoppedAt: nowIso,
          stopCode: 'dirty-conflict-spec-context-missing',
          stopReason: `DIRTY PR merge conflict could not be assigned to complete spec context; missing: ${specContext.missing.join(', ') || 'spec context'}.`,
          sourceStatus: 'in_progress',
          remediationWorker: {
            ...(job?.remediationWorker || {}),
            state: 'never-spawned',
            reconciledAt: nowIso,
            preSpawnLifecycleCheckAt: nowIso,
            dirtyMergeResolution: {
              outcome: 'conflict-spec-context-missing',
              conflictedFiles,
              specsConsulted: specContext.entries.map((entry) => entry.path),
              missingSpecs: specContext.missing,
            },
          },
        });
        return { action: 'stopped', job: stopped.job, jobPath: stopped.jobPath, reason: 'dirty-conflict-spec-context-missing' };
      }

      if (promptPath) {
        writeFileSync(promptPath, `${buildDirtyConflictHammerPrompt({
          job,
          baseBranch: resolvedBaseBranch,
          branch: resolvedBranch,
          conflictError: dirtyMerge.error,
          specContext,
        })}\n`, 'utf8');
      }
      const nextJob = {
        ...job,
        baseBranch: resolvedBaseBranch || job?.baseBranch || null,
        branch: resolvedBranch || job?.branch || null,
        remediationWorker: {
          ...(job?.remediationWorker || {}),
          preSpawnLifecycleCheckAt: nowIso,
          dirtyMergeResolution: {
            outcome: 'conflict-hammer-dispatch',
            conflictedFiles,
            specsConsulted: specContext.entries.map((entry) => entry.path),
            specRef: specContext.specRef || null,
            resolvedAt: nowIso,
          },
        },
      };
      writeFollowUpJob(jobPath, nextJob);
      log.log?.(
        `[follow-up-remediation ${nowIso}] dirty-pr-conflict-hammer jobId=${job?.jobId} ` +
        `base=${resolvedBaseBranch} branch=${resolvedBranch} conflicts=${conflictedFiles.length}`
      );
      return { action: 'continue', reason: 'dirty-conflict-hammer', job: nextJob, jobPath };
    }
  }
  const lifecycleStop = lifecycleStopDecision(lifecycle, {
    repo: job?.repo,
    prNumber: job?.prNumber,
    site: 'consume',
    job,
  });
  if (!lifecycleStop) {
    return { action: 'continue', reason: 'pr-open' };
  }
  if (lifecycleStop.logMessage) {
    log.log?.(lifecycleStop.logMessage);
  }

  const nowIso = now();
  const remediationWorker = {
    ...(job?.remediationWorker || {}),
    state: lifecycleStop.workerState,
    preSpawnLifecycleCheckAt: nowIso,
  };
  if (lifecycleStop.stopCode === 'operator-merged-pr' && lifecycle?.mergedAt) {
    remediationWorker.prMergedAt = lifecycle.mergedAt;
  }
  if (lifecycleStop.stopCode === 'operator-closed-pr' && lifecycle?.closedAt) {
    remediationWorker.prClosedAt = lifecycle.closedAt;
  }
  const stopped = (lifecycleStop.stopCode === 'stale-drift' || lifecycleStop.stopCode === 'stale-review-head')
    ? markFollowUpJobStopped({
        rootDir,
        jobPath,
        stoppedAt: nowIso,
        stopCode: lifecycleStop.stopCode,
        stopReason: lifecycleStop.stopReason,
        sourceStatus: 'in_progress',
        remediationWorker: {
          ...(job?.remediationWorker || {}),
          state: lifecycleStop.workerState,
          reconciledAt: nowIso,
          preSpawnLifecycleCheckAt: nowIso,
        },
      })
    : stopConsumedJobWithCommentImpl
      ? await stopConsumedJobWithCommentImpl({
          rootDir,
          job,
          jobPath,
          stoppedAt: nowIso,
          stopCode: lifecycleStop.stopCode,
          stopReason: lifecycleStop.stopReason,
          sourceStatus: 'in_progress',
          remediationWorker,
          postCommentImpl,
          now,
          log,
        })
      : markFollowUpJobStopped({
          rootDir,
          jobPath,
          stoppedAt: nowIso,
          stopCode: lifecycleStop.stopCode,
          stopReason: lifecycleStop.stopReason,
          sourceStatus: 'in_progress',
          remediationWorker,
        });
  log.log?.(
    `[follow-up-remediation ${nowIso}] pre-spawn-lifecycle-stop jobId=${job?.jobId} ` +
    `stopCode=${lifecycleStop.stopCode}`
  );
  return { action: 'stopped', job: stopped.job, jobPath: stopped.jobPath, reason: lifecycleStop.actionReason };
}

export {
  IN_PROGRESS_STUCK_THRESHOLD_MS_ENV,
  DEFAULT_IN_PROGRESS_STUCK_THRESHOLD_MS,
  STALE_HEARTBEAT_STOP_CODE,
  applyPreSpawnLifecycleGate,
  attemptDirtyMerge,
  buildDirtyConflictHammerPrompt,
  emitHeartbeatsForActiveJobs,
  pushDirtyMergeWithRetry,
  resolveDirtyConflictSpecContext,
  resolveInProgressStuckThresholdMs,
  resolveLastObservedAtMs,
  sweepStuckInProgressClaims,
};

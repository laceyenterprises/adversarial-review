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
//   1. Heartbeat: the daemon touches `lastHeartbeatAt` only when an
//      alive worker also advances one of its durable artifacts
//      (`codex-worker.log`, `codex-last-message.md`, or
//      `remediation-reply.json`). The workers themselves are external
//      CLIs (codex / claude) so they cannot self-heartbeat; artifact
//      progress is the closest durable no-output watchdog signal.
//      Newly-spawned jobs are seeded with `lastHeartbeatAt = spawnedAt`
//      by `markFollowUpJobSpawned` so the first sweep pass has a
//      baseline.
//   2. Sweep: after the daemon's live-worker heartbeat pass, any
//      in-progress claim whose `lastHeartbeatAt` is
//      older than the stuck threshold (default 10m) is requeued while
//      stale retry budget remains, then stopped with
//      stopCode='stale-heartbeat' only after the owed terminal comment
//      posts. Records with no `lastHeartbeatAt` fall back to file mtime
//      so legacy pre-heartbeat claims still get reclaimed.
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
// worker that is still producing artifacts.

import { existsSync, mkdtempSync, promises as fsPromises, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  computeFollowUpJobStoppedState,
  listFollowUpJobsInDir,
  listInProgressFollowUpJobs,
  markFollowUpJobStopped,
  requeueInProgressFollowUpJobForRetry,
  writeFollowUpJob,
} from './follow-up-jobs.mjs';
import { lifecycleStopDecision, resolveJobPRLifecycleSafe } from './follow-up-lifecycle.mjs';
import { resolveMaxTransientRemediationRetries } from './remediation-admission.mjs';
import { sendWorkerSignal, workerCancelHandle } from './follow-up-worker-cancel.mjs';
import { resolvePRLifecycle } from './review-state.mjs';
import {
  buildRemediationOutcomeCommentBody,
  postRemediationOutcomeComment,
} from './adapters/comms/github-pr-comments/pr-comments.mjs';
import {
  recordInitialCommentDelivery,
} from './adapters/comms/github-pr-comments/comment-delivery.mjs';

const IN_PROGRESS_STUCK_THRESHOLD_MS_ENV = 'ADVERSARIAL_FOLLOW_UP_IN_PROGRESS_STUCK_THRESHOLD_MS';
const DEFAULT_IN_PROGRESS_STUCK_THRESHOLD_MS = 10 * 60 * 1000;
const STALE_HEARTBEAT_STOP_CODE = 'stale-heartbeat';

// FUS-REAP: bound on how many distinct PR-state GitHub reads the
// finished-PR reaper performs per tick. Deduped by repo#pr, so this caps
// *distinct* PRs, not candidates. Kept small so the reaper can never
// dominate a tick's GitHub budget; any PRs beyond the cap are retried on
// the next tick (the pass is idempotent). Overridable for operators
// draining a large finished-PR backlog.
const REAP_MAX_PR_LOOKUPS_ENV = 'ADVERSARIAL_FOLLOW_UP_REAP_MAX_PR_LOOKUPS';
const DEFAULT_REAP_MAX_PR_LOOKUPS = 25;
// Extra safety margin for the merge-authority (AMA closer) part-B path: an
// active AMA closer dispatch for a merged/closed PR is only terminalized
// once it is ALSO this stale (no observation for the window), so the
// reaper can never race a closer that merged the PR seconds ago. 30m
// mirrors AMA_CLOSER_DISPATCHED_LEASE_RECLAIM_AGE_MS; defined locally to
// keep this module decoupled from the merge-authority subsystem.
const REAP_AMA_CLOSER_MIN_STALE_MS_ENV = 'ADVERSARIAL_FOLLOW_UP_REAP_AMA_CLOSER_MIN_STALE_MS';
const DEFAULT_REAP_AMA_CLOSER_MIN_STALE_MS = 30 * 60 * 1000;
// Sentinel cached against a repo#pr key once the per-tick lookup cap is
// hit, so later candidates for that PR are deferred (not re-looked-up).
const REAP_LOOKUP_CAPPED = Symbol('reap-lifecycle-capped');
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

function normalizeWorkerArtifactProgressMs(ms) {
  return Number.isFinite(ms) ? Math.floor(ms) : null;
}

function isoFromMs(ms) {
  const normalizedMs = normalizeWorkerArtifactProgressMs(ms);
  return normalizedMs === null ? null : new Date(normalizedMs).toISOString();
}

function resolveStoredWorkerPath(rootDir, value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  return isAbsolute(trimmed) ? trimmed : resolve(rootDir, trimmed);
}

function workerArtifactCandidates(rootDir, job) {
  const worker = job?.remediationWorker || {};
  return [
    { label: 'remediationWorker.logPath', path: resolveStoredWorkerPath(rootDir, worker.logPath) },
    { label: 'remediationWorker.outputPath', path: resolveStoredWorkerPath(rootDir, worker.outputPath) },
    { label: 'remediationWorker.replyPath', path: resolveStoredWorkerPath(rootDir, worker.replyPath) },
    { label: 'remediationReply.path', path: resolveStoredWorkerPath(rootDir, job?.remediationReply?.path) },
  ].filter((candidate) => candidate.path);
}

function resolveWorkerArtifactProgressMs(rootDir, job) {
  let newest = null;
  for (const candidate of workerArtifactCandidates(rootDir, job)) {
    try {
      const st = statSync(candidate.path);
      if (!st.isFile() || st.size <= 0) continue;
      if (newest === null || st.mtimeMs > newest.sourceMs) {
        newest = { sourceMs: st.mtimeMs, source: candidate.label };
      }
    } catch {
      // Missing artifacts are normal while a worker is starting up.
    }
  }
  return newest || { sourceMs: null, source: 'unavailable' };
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
  const artifactProgressMs = parseTimestampMs(job?.lastWorkerArtifactProgressAt);
  if (artifactProgressMs !== null) {
    return { sourceMs: artifactProgressMs, source: 'lastWorkerArtifactProgressAt' };
  }
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

async function signalStaleClaimWorker({
  job,
  requestedAt,
  signal = 'SIGTERM',
  sendWorkerSignalImpl = sendWorkerSignal,
  processKill = process.kill,
  execFileImpl,
} = {}) {
  const handle = workerCancelHandle(job);
  if (!handle.processGroupId && !handle.processId) {
    return {
      requestedAt,
      signal,
      signalled: false,
      skipped: true,
      target: null,
      error: 'missing-worker-process-handle',
    };
  }
  try {
    const result = await sendWorkerSignalImpl({
      processGroupId: handle.processGroupId,
      processId: handle.processId,
      spawnedAt: handle.spawnedAt,
      signal,
      processKill,
      execFileImpl,
    });
    const alreadyDead = isAlreadyDeadSignalResult(result);
    return {
      requestedAt,
      signal,
      signalled: Boolean(result?.signalled),
      skipped: alreadyDead,
      target: result?.target || null,
      error: result?.error || null,
      identity: result?.identity || null,
    };
  } catch (err) {
    const alreadyDead = isAlreadyDeadSignalError(err);
    return {
      requestedAt,
      signal,
      signalled: false,
      skipped: alreadyDead,
      target: null,
      error: err?.message || String(err),
    };
  }
}

function isAlreadyDeadSignalResult(result) {
  if (result?.signalled) return false;
  return isAlreadyDeadSignalText(result?.error);
}

function isAlreadyDeadSignalError(err) {
  return err?.code === 'ESRCH' || isAlreadyDeadSignalText(err?.message || String(err));
}

function isAlreadyDeadSignalText(value) {
  const text = String(value || '').toLowerCase();
  return text.includes('esrch') || text.includes('no such process') || text.includes('process-group-not-found');
}

function staleRetryWorkerClass(job) {
  const workerClass = String(job?.remediationWorker?.model || job?.claimedBy?.workerType || 'codex').trim();
  if (workerClass === 'codex-remediation') return 'codex';
  if (workerClass === 'claude-code-remediation') return 'claude-code';
  return workerClass || 'codex';
}

function buildStaleTerminalCommentDelivery({
  job,
}) {
  const workerClass = staleRetryWorkerClass(job);
  const body = buildRemediationOutcomeCommentBody({
    workerClass,
    action: 'stopped',
    job,
  });
  return {
    body,
    workerClass,
  };
}

async function stopStaleClaimWithComment({
  rootDir,
  job,
  jobPath,
  stoppedAt,
  stopReason,
  remediationWorker,
  postCommentImpl,
  recordInitialCommentDeliveryImpl,
  log,
}) {
  const stoppedJob = computeFollowUpJobStoppedState({
    currentJob: job,
    stoppedAt,
    stopCode: STALE_HEARTBEAT_STOP_CODE,
    stopReason,
    sourceStatus: 'in_progress',
    remediationWorker,
  });
  if (stoppedJob?.commentDelivery?.posted) {
    return markFollowUpJobStopped({
      rootDir,
      jobPath,
      stoppedAt,
      stopCode: STALE_HEARTBEAT_STOP_CODE,
      stopReason,
      sourceStatus: 'in_progress',
      remediationWorker,
      commentDelivery: stoppedJob.commentDelivery,
    });
  }

  const { body, workerClass } = buildStaleTerminalCommentDelivery({
    job: stoppedJob,
  });
  let commentDelivery = null;
  try {
    commentDelivery = await recordInitialCommentDeliveryImpl({
      rootDir,
      jobPath,
      body,
      repo: job?.repo,
      prNumber: job?.prNumber,
      workerClass,
      revisionRef: job?.revisionRef || null,
      round: job?.remediationPlan?.currentRound || null,
      kind: 'remediation-reply',
      postCommentImpl: (args) => postCommentImpl({ rootDir, ...args, log }),
      postCommentArgs: {
        repo: job?.repo,
        prNumber: job?.prNumber,
        workerClass,
        body,
        log,
      },
      now: () => stoppedAt,
      log,
    });
  } catch (err) {
    log.warn?.(
      `[follow-up-tick ${stoppedAt}] stale-claim-terminal-comment-failed ` +
      `jobId=${job?.jobId || basename(jobPath)} reason=${STALE_HEARTBEAT_STOP_CODE} ` +
      `error=${err?.message || String(err)}`
    );
    return null;
  }

  if (!commentDelivery?.posted) {
    log.warn?.(
      `[follow-up-tick ${stoppedAt}] stale-claim-terminal-comment-deferred ` +
      `jobId=${job?.jobId || basename(jobPath)} reason=${STALE_HEARTBEAT_STOP_CODE} ` +
      `deliveryReason=${commentDelivery?.reason || 'unknown'}`
    );
    return null;
  }

  return markFollowUpJobStopped({
    rootDir,
    jobPath,
    stoppedAt,
    stopCode: STALE_HEARTBEAT_STOP_CODE,
    stopReason,
    sourceStatus: 'in_progress',
    remediationWorker,
    commentDelivery,
  });
}

async function sweepStuckInProgressClaims({
  rootDir,
  nowMs = Date.now(),
  thresholdMs = resolveInProgressStuckThresholdMs(),
  log = console,
  sendWorkerSignalImpl = sendWorkerSignal,
  processKill = process.kill,
  execFileImpl,
  maxTransientRetries = resolveMaxTransientRemediationRetries(),
  postCommentImpl = postRemediationOutcomeComment,
  recordInitialCommentDeliveryImpl = recordInitialCommentDelivery,
} = {}) {
  let scanned = 0;
  let reclaimed = 0;
  let requeued = 0;
  let terminalStopped = 0;
  let skipped = 0;
  let signalled = 0;
  let signalFailed = 0;
  let signalSkipped = 0;
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
    const staleReclaimSignal = await signalStaleClaimWorker({
      job,
      requestedAt: reclaimedAtIso,
      sendWorkerSignalImpl,
      processKill,
      execFileImpl,
    });
    if (staleReclaimSignal.signalled) {
      signalled += 1;
    } else if (staleReclaimSignal.skipped) {
      signalSkipped += 1;
    } else {
      signalFailed += 1;
      log.warn?.(
        `[follow-up-tick ${reclaimedAtIso}] stale-claim-signal-failed jobId=${jobId} ageMs=${ageMs} ` +
        `source=${source} reason=${STALE_HEARTBEAT_STOP_CODE} error=${staleReclaimSignal.error || 'unknown'}`
      );
      continue;
    }

    const staleWorker = {
      ...(job?.remediationWorker || {}),
      state: 'reclaimed-stale-heartbeat',
      reclaimedAt: reclaimedAtIso,
      reclaimReason: STALE_HEARTBEAT_STOP_CODE,
      reclaimAgeMs: ageMs,
      reclaimSource: source,
      staleReclaimSignal,
    };
    const priorTransientRetries = Number(job?.remediationPlan?.transientRetries || 0);
    const nextTransientRetry = priorTransientRetries + 1;
    const normalizedMaxTransientRetries = Number.isFinite(Number(maxTransientRetries))
      ? Math.max(0, Number(maxTransientRetries))
      : 0;
    if (nextTransientRetry <= normalizedMaxTransientRetries) {
      const retryAfter = new Date(nowMs + 60_000).toISOString();
      requeueInProgressFollowUpJobForRetry({
        rootDir,
        jobPath,
        requeuedAt: reclaimedAtIso,
        retryReason:
          `${reasonText} Requeueing stale remediator claim ` +
          `(retry ${nextTransientRetry}/${normalizedMaxTransientRetries}).`,
        remediationWorker: null,
        allowDirectWorkerRetry: true,
        retryAfterOverride: retryAfter,
        retryMetadata: {
          code: STALE_HEARTBEAT_STOP_CODE,
          recoverable: true,
          reclaimAgeMs: ageMs,
          reclaimSource: source,
          retry: nextTransientRetry,
          maxRetries: normalizedMaxTransientRetries,
          staleReclaimSignal,
        },
      });
      requeued += 1;
      reclaimed += 1;
      log.log?.(
        `[follow-up-tick ${reclaimedAtIso}] stale-claim-requeued jobId=${jobId} ageMs=${ageMs} ` +
        `source=${source} retry=${nextTransientRetry}/${normalizedMaxTransientRetries} ` +
        `retryAfter=${retryAfter} signalled=${staleReclaimSignal.signalled}`
      );
      continue;
    }

    const terminalStopReason =
      `${reasonText} Exhausted stale heartbeat retry budget ` +
      `(${priorTransientRetries}/${normalizedMaxTransientRetries}).`;
    const stopped = await stopStaleClaimWithComment({
      rootDir,
      job,
      jobPath,
      stoppedAt: reclaimedAtIso,
      stopReason: terminalStopReason,
      remediationWorker: staleWorker,
      postCommentImpl,
      recordInitialCommentDeliveryImpl,
      log,
    });
    if (!stopped) {
      skipped += 1;
      continue;
    }
    terminalStopped += 1;
    reclaimed += 1;
    log.log?.(
      `[follow-up-tick ${reclaimedAtIso}] stale-claim-reclaimed jobId=${jobId} ageMs=${ageMs} ` +
      `source=${source} reason=${STALE_HEARTBEAT_STOP_CODE} signalled=${staleReclaimSignal.signalled}`
    );
  }

  return {
    scanned,
    reclaimed,
    requeued,
    terminalStopped,
    skipped,
    thresholdMs,
    signalled,
    signalFailed,
    signalSkipped,
  };
}

// Emit a heartbeat (`lastHeartbeatAt = now`) on every in-progress job
// whose worker process is still alive and whose artifacts have advanced
// since the last observed worker progress. Called once per tick from
// the daemon. Skips entries with no PID handle (HQ-dispatched jobs
// whose liveness is tracked by HQ, not by the daemon). Errors on
// individual records are swallowed so one bad JSON can't stop the rest.
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
    const progress = resolveWorkerArtifactProgressMs(rootDir, job);
    const progressMs = normalizeWorkerArtifactProgressMs(progress.sourceMs);
    const lastProgressMs =
      parseTimestampMs(job?.lastWorkerArtifactProgressAt)
      ?? parseTimestampMs(worker.spawnedAt)
      ?? parseTimestampMs(job?.claimedAt)
      ?? 0;
    if (progressMs === null || progressMs <= lastProgressMs) {
      skipped += 1;
      continue;
    }
    try {
      writeFollowUpJob(jobPath, {
        ...job,
        lastHeartbeatAt: heartbeatAt,
        lastWorkerArtifactProgressAt: isoFromMs(progressMs),
        lastWorkerArtifactProgressSource: progress.source,
      });
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

function resolveReapMaxPrLookups(env = process.env) {
  const raw = env?.[REAP_MAX_PR_LOOKUPS_ENV];
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_REAP_MAX_PR_LOOKUPS;
  }
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_REAP_MAX_PR_LOOKUPS;
  }
  return parsed;
}

function resolveReapAmaCloserMinStaleMs(env = process.env) {
  const raw = env?.[REAP_AMA_CLOSER_MIN_STALE_MS_ENV];
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_REAP_AMA_CLOSER_MIN_STALE_MS;
  }
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_REAP_AMA_CLOSER_MIN_STALE_MS;
  }
  return parsed;
}

// Stable repo#pr key for a reap candidate, or null when there is no
// resolvable PR target. Computed locally (rather than importing the
// consume-loop helper) to avoid a cycle with follow-up-remediation.mjs.
function reapRepoPrKey(repo, prNumber) {
  const normalizedRepo = typeof repo === 'string' ? repo.trim() : '';
  const normalizedPr = Number(prNumber);
  if (!normalizedRepo || !Number.isInteger(normalizedPr) || normalizedPr <= 0) return null;
  return `${normalizedRepo}#${normalizedPr}`;
}

// Age (ms) of an AMA closer dispatch record's most recent observation.
// Missing timestamps => treated as infinitely stale (reap-eligible),
// consistent with the AMA closer's own dispatching-staleness fallback.
// `parseTimestampMs` here is the module-local helper defined above (see the
// top of this file), NOT an import — this module deliberately owns its own
// tolerant ISO/epoch parser so the sweep never depends on a util module.
function amaCloserDispatchStaleMs(record, nowMs) {
  const candidates = [
    record?.lastObservedAt,
    record?.dispatchedAt,
    record?.lastAttemptedAt,
    record?.createdAt,
  ];
  for (const value of candidates) {
    const parsed = parseTimestampMs(value);
    if (parsed !== null) return nowMs - parsed;
  }
  return Number.POSITIVE_INFINITY;
}

// FUS-REAP: per-tick reaper for follow-up work whose target PR is already
// terminal (merged or closed). Sibling of sweepStuckInProgressClaims; the
// daemon runs it just before consume so the queue and the reservation set
// the consume loop reads are already clear of moot work.
//
// Three classes are reaped, each via the owning subsystem's own move /
// mutation primitive (no new state dir, no raw file moves):
//
//   (A) pending + failed follow-up jobs for a merged/closed PR ->
//       archived to the canonical terminal stopped/ record via
//       markFollowUpJobStopped with the lifecycle stop code
//       (operator-merged-pr / operator-closed-pr) and a
//       `reaped: pr <n> is <state>` reason. `failed` is included because
//       the consume loop never revisits it.
//
//   (B1) orphaned in-progress follow-up claims (dead, non-HQ worker) for a
//       merged/closed PR -> released to the same terminal record, so their
//       repoPrKey drops out of the consume loop's blockedRepoPrKeys on the
//       next tick instead of waiting for the slower stale-heartbeat sweep.
//
//   (B2) orphaned AMA closer dispatch records for a merged/closed PR.
//       On current main, buildFollowUpClaimReservations feeds
//       blockedRepoPrKeys from in-progress jobs PLUS
//       listActiveAmaCloserDispatches, whose active/terminal status is
//       derived from the ledger-refreshed `lastObservedStatus`. A closer
//       worker that died (keychain-headless OAuth) without a terminal
//       ledger status leaves a `dispatched`/non-terminal record that
//       blocks its repoPrKey forever (there is no age escape for the
//       `dispatched` state in isActiveAmaCloserDispatchRecord). This is the
//       mechanism behind the live deferredSamePR wedge when activeAtStart=0.
//       When both AMA impls are injected, such a record is terminalized to
//       the closer's own vocabulary (merged -> succeeded, closed ->
//       failed-without-merge) via updateAmaCloserDispatchRecord, but only
//       once it is ALSO stale past the safety window, so a closer that
//       merged the PR seconds ago is never raced. The AMA primitives are
//       injected (not imported) to keep this module decoupled from the
//       merge-authority subsystem and hermetically testable.
//
// Fail-closed contract:
//   * A candidate is reaped ONLY when a *live* gh read (source==='live')
//     reports the PR merged or closed. null/mirror/errored/rate-limited,
//     or an OPEN PR, leaves it untouched.
//   * An in-progress liveness-probe error is treated as "alive" (never
//     release a claim we cannot prove is dead).
//   * AMA closer dispatches also require staleness past the safety window.
//   * Distinct PR lookups are capped per tick; PRs beyond the cap are
//     deferred to the next tick, never reaped without a state read.
//   * Idempotent: reaped work leaves pending/failed/in-progress and AMA
//     records become terminal, so a second pass re-scans nothing.
//   * Never merges, never kills a worker, never touches a git working tree.
async function reapFinishedPrFollowUpJobs({
  rootDir,
  now = () => new Date().toISOString(),
  resolvePRLifecycleImpl = resolvePRLifecycle,
  execFileImpl,
  isWorkerAlive = null,
  listActiveAmaCloserDispatchesImpl = null,
  updateAmaCloserDispatchRecordImpl = null,
  maxPrLookups = resolveReapMaxPrLookups(),
  amaCloserMinStaleMs = resolveReapAmaCloserMinStaleMs(),
  log = console,
} = {}) {
  const nowIso = now();
  const nowMs = parseTimestampMs(nowIso) ?? Date.now();
  const lifecycleByKey = new Map();
  let liveLookups = 0;
  let lookupCapHit = false;

  const counters = {
    scanned: 0,
    reaped: 0,
    released: 0,
    amaScanned: 0,
    amaReleased: 0,
    skippedOpen: 0,
    skippedUnreadable: 0,
    skippedAliveWorker: 0,
    skippedFreshAmaDispatch: 0,
    skippedNoTarget: 0,
    skippedCapped: 0,
    prLookups: 0,
    lookupCapHit: false,
    reapedPrs: [],
    releasedPrs: [],
    amaReleasedPrs: [],
  };

  // Resolve (and memoize) the lifecycle for a candidate's PR. Only a
  // successful live read is cached as a usable lifecycle; anything else
  // caches null (treated as unreadable). Returns a { skip } marker or
  // { lifecycle }.
  async function resolveLifecycleFor({ repo, prNumber, job = null }) {
    const key = reapRepoPrKey(repo, prNumber);
    if (!key) return { skip: 'no-target' };
    if (lifecycleByKey.has(key)) {
      const cached = lifecycleByKey.get(key);
      if (cached === REAP_LOOKUP_CAPPED) return { skip: 'capped' };
      return { lifecycle: cached };
    }
    if (liveLookups >= maxPrLookups) {
      lookupCapHit = true;
      lifecycleByKey.set(key, REAP_LOOKUP_CAPPED);
      return { skip: 'capped' };
    }
    liveLookups += 1;
    const lifecycle = await resolveJobPRLifecycleSafe({
      rootDir,
      job: job || { repo, prNumber },
      resolvePRLifecycleImpl,
      execFileImpl,
      log,
    });
    // Fail closed: a definitive terminal decision requires a live GitHub
    // read. A mirror hit could be stale (a closed PR may have reopened),
    // and null means we learned nothing.
    const definitive = lifecycle && lifecycle.source === 'live' ? lifecycle : null;
    lifecycleByKey.set(key, definitive);
    return { lifecycle: definitive };
  }

  // Returns the terminal lifecycle stop ({operator-merged-pr|operator-
  // closed-pr}) for a candidate, or null when it must be left untouched
  // (recording the skip reason). Shared by all three reap classes.
  async function resolveTerminalStopFor(candidate, { onSkip }) {
    const resolved = await resolveLifecycleFor(candidate);
    if (resolved.skip === 'no-target') { onSkip('skippedNoTarget'); return null; }
    if (resolved.skip === 'capped') { onSkip('skippedCapped'); return null; }
    const lifecycle = resolved.lifecycle;
    if (!lifecycle || lifecycle.source !== 'live') { onSkip('skippedUnreadable'); return null; }
    if (lifecycle.prState !== 'merged' && lifecycle.prState !== 'closed') {
      onSkip('skippedOpen');
      return null;
    }
    const lifecycleStop = lifecycleStopDecision(lifecycle, {
      repo: candidate.repo,
      prNumber: candidate.prNumber,
      site: 'consume',
      job: candidate.job || null,
    });
    if (
      !lifecycleStop
      || (lifecycleStop.stopCode !== 'operator-merged-pr'
        && lifecycleStop.stopCode !== 'operator-closed-pr')
    ) {
      // Defensive: unreachable for merged/closed. Fail closed.
      onSkip('skippedOpen');
      return null;
    }
    return { lifecycle, lifecycleStop };
  }

  // ---- (A) pending + failed follow-up jobs, (B1) in-progress orphans ----
  const jobCandidates = [];
  for (const dirKey of ['pending', 'failed']) {
    for (const { job, jobPath } of listFollowUpJobsInDir(rootDir, dirKey)) {
      jobCandidates.push({ kind: 'queue', fromStatus: dirKey, repo: job?.repo, prNumber: job?.prNumber, job, jobPath });
    }
  }
  // In-progress orphans are only considered when the caller provides a
  // liveness probe — without it we cannot prove a worker is dead, so we
  // must not touch in-progress claims at all.
  if (typeof isWorkerAlive === 'function') {
    for (const { job, jobPath } of listInProgressFollowUpJobs(rootDir)) {
      jobCandidates.push({ kind: 'in-progress', fromStatus: 'in_progress', repo: job?.repo, prNumber: job?.prNumber, job, jobPath });
    }
  }

  for (const candidate of jobCandidates) {
    counters.scanned += 1;
    const { job, jobPath, fromStatus, kind } = candidate;

    if (kind === 'in-progress') {
      const worker = job?.remediationWorker || {};
      // HQ-dispatched liveness is HQ's concern; never guess it here.
      if (worker.dispatchMode === 'hq') { counters.skippedAliveWorker += 1; continue; }
      const processId = Number(worker.processId);
      if (Number.isInteger(processId) && processId > 0) {
        let alive = true;
        try {
          alive = Boolean(isWorkerAlive(processId));
        } catch (err) {
          alive = true; // Fail closed: unreadable probe => assume alive.
          log.warn?.(
            `[follow-up-tick ${nowIso}] reap-liveness-failed jobId=${job?.jobId || basename(jobPath)}: ${err?.message || err}`
          );
        }
        if (alive) { counters.skippedAliveWorker += 1; continue; }
      }
      // No PID / dead PID => eligible orphan, subject to the PR-state gate.
    }

    const terminal = await resolveTerminalStopFor(candidate, {
      onSkip: (key) => { counters[key] += 1; },
    });
    if (!terminal) continue;
    const { lifecycle, lifecycleStop } = terminal;

    const prStateUpper = lifecycle.prState.toUpperCase();
    // `.stopReason` (the full operator-facing explanation), NOT `.actionReason`
    // (the short machine code, e.g. 'pr-merged'). lifecycleStopDecision returns
    // both; the durable stopped record wants the prose, and the machine code is
    // already recorded separately as remediationWorker.reapReason /
    // remediationPlan.stop.code below.
    const stopReason = `reaped: pr ${job.prNumber} is ${prStateUpper}; ${lifecycleStop.stopReason}`;
    const remediationWorker = {
      ...(job?.remediationWorker || {}),
      state: lifecycleStop.workerState,
      reapedAt: nowIso,
      reapReason: lifecycleStop.stopCode,
      reapedFromStatus: fromStatus,
      prState: lifecycle.prState,
    };
    if (lifecycleStop.stopCode === 'operator-merged-pr' && lifecycle.mergedAt) {
      remediationWorker.prMergedAt = lifecycle.mergedAt;
    }
    if (lifecycleStop.stopCode === 'operator-closed-pr' && lifecycle.closedAt) {
      remediationWorker.prClosedAt = lifecycle.closedAt;
    }

    markFollowUpJobStopped({
      rootDir,
      jobPath,
      stoppedAt: nowIso,
      stopCode: lifecycleStop.stopCode,
      stopReason,
      sourceStatus: fromStatus,
      remediationWorker,
    });

    const record = { repo: job.repo, prNumber: job.prNumber, prState: lifecycle.prState, fromStatus };
    if (kind === 'in-progress') { counters.released += 1; counters.releasedPrs.push(record); }
    else { counters.reaped += 1; counters.reapedPrs.push(record); }
    log.log?.(
      `[follow-up-tick ${nowIso}] reaped-finished-pr jobId=${job?.jobId || basename(jobPath)} ` +
      `pr=${job.repo}#${job.prNumber} state=${prStateUpper} from=${fromStatus} ` +
      `stopCode=${lifecycleStop.stopCode}`
    );
  }

  // ---- (B2) orphaned AMA closer dispatch reservations ----
  const amaEnabled = typeof listActiveAmaCloserDispatchesImpl === 'function'
    && typeof updateAmaCloserDispatchRecordImpl === 'function';
  if (amaEnabled) {
    let amaDispatches = [];
    try {
      amaDispatches = listActiveAmaCloserDispatchesImpl(rootDir, { now: nowIso, log }) || [];
    } catch (err) {
      log.warn?.(`[follow-up-tick ${nowIso}] reap-ama-list-failed: ${err?.message || err}`);
      amaDispatches = [];
    }
    for (const amaRecord of amaDispatches) {
      counters.amaScanned += 1;
      const candidate = { kind: 'ama-dispatch', repo: amaRecord?.repo, prNumber: amaRecord?.prNumber, amaRecord };
      const terminal = await resolveTerminalStopFor(candidate, {
        onSkip: (key) => { counters[key] += 1; },
      });
      if (!terminal) continue;
      const { lifecycle, lifecycleStop } = terminal;

      // Safety margin: only terminalize a merge-authority dispatch once it
      // is also stale past the window, so a closer that merged the PR
      // seconds ago is never raced.
      const staleMs = amaCloserDispatchStaleMs(amaRecord, nowMs);
      if (staleMs < amaCloserMinStaleMs) {
        counters.skippedFreshAmaDispatch += 1;
        continue;
      }

      const prStateUpper = lifecycle.prState.toUpperCase();
      const terminalStatus = lifecycle.prState === 'merged' ? 'succeeded' : 'failed-without-merge';
      try {
        updateAmaCloserDispatchRecordImpl(
          rootDir,
          { repo: amaRecord.repo, prNumber: amaRecord.prNumber, headSha: amaRecord.headSha },
          (current) => {
            const base = current || amaRecord;
            if (!base) return null;
            return {
              ...base,
              lastObservedStatus: terminalStatus,
              lastObservedAt: nowIso,
              reapedByFollowUpReaper: true,
              reapedFromPrState: lifecycle.prState,
              reapReason: lifecycleStop.stopCode,
              reapedAt: nowIso,
            };
          }
        );
      } catch (err) {
        log.warn?.(
          `[follow-up-tick ${nowIso}] reap-ama-update-failed pr=${amaRecord.repo}#${amaRecord.prNumber}: ${err?.message || err}`
        );
        continue;
      }
      counters.amaReleased += 1;
      counters.amaReleasedPrs.push({
        repo: amaRecord.repo,
        prNumber: amaRecord.prNumber,
        prState: lifecycle.prState,
        terminalStatus,
      });
      log.log?.(
        `[follow-up-tick ${nowIso}] reaped-ama-closer-dispatch pr=${amaRecord.repo}#${amaRecord.prNumber} ` +
        `state=${prStateUpper} terminalStatus=${terminalStatus} stopCode=${lifecycleStop.stopCode}`
      );
    }
  }

  counters.prLookups = liveLookups;
  counters.lookupCapHit = lookupCapHit;
  return counters;
}

export {
  IN_PROGRESS_STUCK_THRESHOLD_MS_ENV,
  DEFAULT_IN_PROGRESS_STUCK_THRESHOLD_MS,
  STALE_HEARTBEAT_STOP_CODE,
  REAP_MAX_PR_LOOKUPS_ENV,
  DEFAULT_REAP_MAX_PR_LOOKUPS,
  REAP_AMA_CLOSER_MIN_STALE_MS_ENV,
  DEFAULT_REAP_AMA_CLOSER_MIN_STALE_MS,
  applyPreSpawnLifecycleGate,
  reapFinishedPrFollowUpJobs,
  resolveReapMaxPrLookups,
  resolveReapAmaCloserMinStaleMs,
  attemptDirtyMerge,
  buildDirtyConflictHammerPrompt,
  emitHeartbeatsForActiveJobs,
  pushDirtyMergeWithRetry,
  resolveDirtyConflictSpecContext,
  resolveInProgressStuckThresholdMs,
  resolveLastObservedAtMs,
  normalizeWorkerArtifactProgressMs,
  resolveWorkerArtifactProgressMs,
  sweepStuckInProgressClaims,
};

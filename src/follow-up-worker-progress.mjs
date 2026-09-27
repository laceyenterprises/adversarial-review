// Read durable worker activity without importing the remediation queue or
// lifecycle gate. Both the watcher and the follow-up daemon use these probes.
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { readClaudeTranscriptTokenUsage, readCodexTranscriptTokenUsage } from './reviewer-pass-tokens.mjs';

function storedPath(rootDir, value) {
  const path = String(value || '').trim();
  if (!path) return null;
  return isAbsolute(path) ? path : resolve(rootDir, path);
}

function resolveWorkerArtifactProgressMs(rootDir, job) {
  const worker = job?.remediationWorker || {};
  const candidates = [
    ['remediationWorker.logPath', worker.logPath],
    ['remediationWorker.outputPath', worker.outputPath],
    ['remediationWorker.replyPath', worker.replyPath],
    ['remediationReply.path', job?.remediationReply?.path],
    ['remediationWorker.transcriptPath', worker.transcriptPath],
    ['remediationWorker.sessionEventsPath', worker.sessionEventsPath],
  ];
  let newest = { sourceMs: null, source: 'unavailable' };
  for (const [label, value] of candidates) {
    const path = storedPath(rootDir, value);
    if (!path) continue;
    try {
      const stat = statSync(path);
      if (stat.isFile() && stat.size > 0 && (newest.sourceMs === null || stat.mtimeMs > newest.sourceMs)) {
        newest = { sourceMs: stat.mtimeMs, source: label };
      }
    } catch {
      // A worker may not have written an artifact yet.
    }
  }
  return newest;
}

function resolveWorkerSessionProgressMs(rootDir, job) {
  const worker = job?.remediationWorker || {};
  const workspacePath = storedPath(rootDir, worker.workspaceDir || job?.workspaceDir);
  if (!workspacePath) return { sourceMs: null, source: 'unavailable' };
  const startedAt = worker.spawnedAt || job?.claimedAt || null;
  const model = String(worker.model || '').toLowerCase();
  const defaultRoots = existsSync(join(rootDir, 'config.yaml'));
  const roots = model.includes('claude')
    ? [
      ...(process.env.CLAUDE_SESSION_ROOTS || '').split(':'),
      process.env.CLAUDE_SESSION_ROOT,
      process.env.CLAUDE_PROJECTS_ROOT,
      defaultRoots ? join(homedir(), '.claude', 'projects') : null,
    ]
    : [
      ...(process.env.CODEX_SESSION_ROOTS || '').split(':'),
      process.env.CODEX_SESSION_ROOT,
      defaultRoots ? join(homedir(), '.codex', 'sessions') : null,
    ];
  try {
    const usage = model.includes('claude')
      ? readClaudeTranscriptTokenUsage({ workspacePath, startedAt, sessionRoots: roots, rootDir })
      : readCodexTranscriptTokenUsage({ workspacePath, startedAt, sessionRoots: roots, rootDir });
    if (!usage?.transcriptPath) return { sourceMs: null, source: 'unavailable' };
    const stat = statSync(usage.transcriptPath);
    return stat.isFile() && stat.size > 0
      ? { sourceMs: stat.mtimeMs, source: 'worker-session-transcript' }
      : { sourceMs: null, source: 'unavailable' };
  } catch {
    return { sourceMs: null, source: 'unavailable' };
  }
}

function readWorkerCpuPercent(job) {
  const pid = Number(job?.remediationWorker?.processId);
  if (!Number.isInteger(pid) || pid <= 0) return 0;
  try {
    const value = execFileSync('ps', ['-p', String(pid), '-o', '%cpu='], { encoding: 'utf8', timeout: 2000 });
    return Number.parseFloat(value.trim()) || 0;
  } catch {
    return 0;
  }
}

export { readWorkerCpuPercent, resolveWorkerArtifactProgressMs, resolveWorkerSessionProgressMs };

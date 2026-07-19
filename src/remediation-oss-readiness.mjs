// OSS-readiness remediation subsystem.
//
// Extracted from follow-up-remediation.mjs (ARC-19). This is a self-contained
// leaf: the mechanical "run the oss-readiness --apply script, gate it, and
// commit the fix" pipeline behind the single entry point
// `applyOssReadinessRemediation`, plus the pure classification/resolution
// helpers it depends on. It imports only node: builtins and MUST NOT import
// ./follow-up-remediation.mjs (that would create a cycle — the monolith imports
// this module, not the other way around).
//
// The push-and-rollback path (pushOssReadinessRemediationCommit /
// resolveOssReadinessRemediationPushTarget) intentionally stays in the monolith:
// it depends on the shared, non-OSS git helpers runWorkspaceGitWithTransientRetry
// and withGhGitCredentialEnv, which are used across the monolith and do not
// belong in an OSS-readiness leaf.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Behavior-preserving default for the injected `workerTrailerClass` parameter.
// The canonical constant REMEDIATION_WORKER_TRAILER_CLASS lives in
// follow-up-remediation.mjs (shared with the prompt/dispatch paths). The real
// remediation call site passes workerTrailerClass explicitly
// (remediationWorkerTrailerClass(workerClass)); this literal only backs direct
// callers that omit it.
const DEFAULT_REMEDIATION_WORKER_TRAILER_CLASS = 'codex-remediation';

const OSS_READINESS_AUDIT_CHECK_NAME = 'oss-readiness-audit';
const OSS_READINESS_BASELINE_PATH = 'scripts/oss-readiness-category-baseline.json';
const OSS_READINESS_APPLY_SCRIPT_ENV = 'OSS_READINESS_APPLY_SCRIPT';
const OSS_READINESS_SCRIPT_TIMEOUT_MS = 60 * 1000;
const OSS_READINESS_APPLY_SCRIPT_CANDIDATES = [
  ['agent-os', 'scripts', 'audit-oss-readiness-hardcodes.py'],
  ['..', 'agent-os', 'scripts', 'audit-oss-readiness-hardcodes.py'],
  ['..', '..', 'agent-os', 'scripts', 'audit-oss-readiness-hardcodes.py'],
];

function collectOssReadinessEvidenceStrings(value, depth = 0) {
  if (value === null || value === undefined || depth > 8) return [];
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectOssReadinessEvidenceStrings(entry, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => [
      String(key),
      ...collectOssReadinessEvidenceStrings(entry, depth + 1),
    ]);
  }
  return [];
}

function jobHasOssReadinessAuditFailure(job) {
  const structuredHaystack = [
    job?.ciFailures,
    job?.statusCheckRollup,
    job?.checkRuns,
    job?.checks,
    job?.workflowFailures,
    job?.failingChecks,
    job?.gateFailures,
  ].flatMap((entry) => collectOssReadinessEvidenceStrings(entry));
  if (structuredHaystack.some((entry) => String(entry || '').includes(OSS_READINESS_AUDIT_CHECK_NAME))) {
    return true;
  }

  const failureLinePattern = new RegExp(
    `\\b${OSS_READINESS_AUDIT_CHECK_NAME}\\b[^\\n]*(?:fail(?:ed|ure|ing)?|red|unsuccessful)|(?:fail(?:ed|ure|ing)?|red|unsuccessful)[^\\n]*\\b${OSS_READINESS_AUDIT_CHECK_NAME}\\b`,
    'i'
  );
  return [
    job?.ciFailureSummary,
    job?.reviewSummary,
    job?.reviewBody,
  ].some((entry) => failureLinePattern.test(String(entry || '')));
}

function resolveOssReadinessApplyScript({ rootDir = ROOT, env = process.env } = {}) {
  const override = typeof env?.[OSS_READINESS_APPLY_SCRIPT_ENV] === 'string'
    ? env[OSS_READINESS_APPLY_SCRIPT_ENV].trim()
    : '';
  if (override) {
    return isAbsolute(override) ? override : resolve(rootDir, override);
  }

  const hqRoot = typeof env?.HQ_ROOT === 'string' && env.HQ_ROOT.trim()
    ? env.HQ_ROOT.trim()
    : null;
  const candidates = [
    ...(hqRoot ? [join(hqRoot, 'agent-os', 'scripts', 'audit-oss-readiness-hardcodes.py')] : []),
    ...OSS_READINESS_APPLY_SCRIPT_CANDIDATES.map((parts) => resolve(rootDir, ...parts)),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

function ossReadinessNeedsOperatorMessage(result) {
  const text = [
    result?.stdout,
    result?.stderr,
    result?.error,
  ].filter(Boolean).join('\n');
  if (
    /\bratchet\s+baseline\s+bump(?:\s+is)?\s+(?:required|needed)\b/i.test(text)
    || /\bbaseline\s+bump(?:\s+is)?\s+(?:required|needed)\b/i.test(text)
    || /\brequires?\s+(?:a\s+)?(?:ratchet\s+)?baseline\s+bump\b/i.test(text)
  ) {
    return 'oss-readiness --apply reported that a ratchet baseline bump is required; operator approval is required.';
  }
  return null;
}

async function collectOssReadinessWorkspaceDiff({ workspaceDir, execFileImpl = execFileAsync } = {}) {
  const { stdout: status } = await execFileImpl(
    'git',
    ['-C', workspaceDir, 'status', '--porcelain', '-z', '--untracked-files=all'],
    { maxBuffer: 2 * 1024 * 1024 }
  );
  const records = String(status || '').split('\0').filter(Boolean);
  const changedFiles = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record.length < 4) continue;
    const statusCode = record.slice(0, 2);
    const pathText = record.slice(3);
    if (pathText) changedFiles.push(pathText);
    if (statusCode[0] === 'R' || statusCode[1] === 'R' || statusCode[0] === 'C' || statusCode[1] === 'C') {
      i += 1;
    }
  }
  await execFileImpl('git', ['-C', workspaceDir, 'add', '--intent-to-add', '--all'], {
    maxBuffer: 2 * 1024 * 1024,
  });
  const { stdout: diff } = await execFileImpl('git', ['-C', workspaceDir, 'diff', 'HEAD', '--'], {
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    changedFiles,
    diff: String(diff || ''),
  };
}

async function resetOssReadinessWorkspace({ workspaceDir, execFileImpl = execFileAsync } = {}) {
  await execFileImpl('git', ['-C', workspaceDir, 'reset', '--hard'], {
    maxBuffer: 2 * 1024 * 1024,
  });
  await execFileImpl('git', ['-C', workspaceDir, 'clean', '-fd'], {
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function rollbackOssReadinessLocalCommit({
  workspaceDir,
  commitSha,
  execFileImpl = execFileAsync,
} = {}) {
  const evidence = {
    attempted: true,
    ok: false,
    commitSha: commitSha || null,
  };
  try {
    const { stdout: headOut } = await execFileImpl('git', ['-C', workspaceDir, 'rev-parse', 'HEAD'], {
      maxBuffer: 1 * 1024 * 1024,
    });
    const headSha = String(headOut || '').trim();
    evidence.headBeforeRollback = headSha || null;
    if (commitSha && headSha && headSha !== commitSha) {
      return {
        ...evidence,
        attempted: false,
        reason: 'head-mismatch',
      };
    }
    await execFileImpl('git', ['-C', workspaceDir, 'reset', '--hard', 'HEAD~1'], {
      maxBuffer: 2 * 1024 * 1024,
    });
    await execFileImpl('git', ['-C', workspaceDir, 'clean', '-fd'], {
      maxBuffer: 2 * 1024 * 1024,
    });
    return {
      ...evidence,
      ok: true,
    };
  } catch (err) {
    return {
      ...evidence,
      error: err?.message || String(err),
    };
  }
}

async function runOssReadinessAuditGate({ workspaceDir, scriptPath, execFileImpl = execFileAsync } = {}) {
  try {
    const result = await execFileImpl(scriptPath, [], {
      cwd: workspaceDir,
      maxBuffer: 20 * 1024 * 1024,
      timeout: OSS_READINESS_SCRIPT_TIMEOUT_MS,
    });
    return {
      ok: true,
      stdout: String(result?.stdout || ''),
      stderr: String(result?.stderr || ''),
    };
  } catch (err) {
    return {
      ok: false,
      stdout: String(err?.stdout || ''),
      stderr: String(err?.stderr || ''),
      error: err?.message || String(err),
    };
  }
}

async function applyOssReadinessRemediation({
  rootDir = ROOT,
  job,
  workspaceDir,
  workerTrailerClass = DEFAULT_REMEDIATION_WORKER_TRAILER_CLASS,
  env = process.env,
  execFileImpl = execFileAsync,
  now = () => new Date().toISOString(),
} = {}) {
  if (!jobHasOssReadinessAuditFailure(job)) {
    return { attempted: false, reason: 'no-oss-readiness-audit-failure' };
  }
  if (!workspaceDir || typeof workspaceDir !== 'string') {
    throw new Error('workspaceDir is required for oss-readiness --apply remediation');
  }

  const scriptPath = resolveOssReadinessApplyScript({ rootDir, env });
  const startedAt = now();
  let applyResult;
  try {
    try {
      applyResult = await execFileImpl(scriptPath, ['--apply'], {
        cwd: workspaceDir,
        maxBuffer: 20 * 1024 * 1024,
        timeout: OSS_READINESS_SCRIPT_TIMEOUT_MS,
      });
    } catch (err) {
      const failed = {
        attempted: true,
        ok: false,
        scriptPath,
        startedAt,
        finishedAt: now(),
        stdout: String(err?.stdout || ''),
        stderr: String(err?.stderr || ''),
        error: err?.message || String(err),
      };
      const needsOperator = ossReadinessNeedsOperatorMessage(failed);
      const out = new Error(needsOperator || `oss-readiness --apply failed: ${failed.error}`);
      out.code = needsOperator ? 'oss-readiness-baseline-operator-required' : 'oss-readiness-apply-failed';
      out.isOssReadinessApplyError = true;
      out.ossReadinessApply = { ...failed, needsOperatorApproval: Boolean(needsOperator) };
      throw out;
    }

    const diff = await collectOssReadinessWorkspaceDiff({ workspaceDir, execFileImpl });
    if (diff.changedFiles.includes(OSS_READINESS_BASELINE_PATH)) {
      const out = new Error('oss-readiness --apply attempted to modify scripts/oss-readiness-category-baseline.json; operator approval is required for ratchet baseline changes.');
      out.code = 'oss-readiness-baseline-modified';
      out.isOssReadinessApplyError = true;
      out.ossReadinessApply = {
        attempted: true,
        ok: false,
        scriptPath,
        startedAt,
        finishedAt: now(),
        stdout: String(applyResult?.stdout || ''),
        stderr: String(applyResult?.stderr || ''),
        changedFiles: diff.changedFiles,
        diff: diff.diff,
        needsOperatorApproval: true,
      };
      throw out;
    }

    const gate = await runOssReadinessAuditGate({ workspaceDir, scriptPath, execFileImpl });
    const evidence = {
      attempted: true,
      ok: gate.ok,
      scriptPath,
      startedAt,
      finishedAt: now(),
      stdout: String(applyResult?.stdout || ''),
      stderr: String(applyResult?.stderr || ''),
      changedFiles: diff.changedFiles,
      diff: diff.diff,
      gate,
    };
    if (!gate.ok) {
      const needsOperator = ossReadinessNeedsOperatorMessage(gate);
      const out = new Error(needsOperator || 'oss-readiness --apply completed but oss-readiness-audit still fails.');
      out.code = needsOperator ? 'oss-readiness-baseline-operator-required' : 'oss-readiness-apply-unresolved';
      out.isOssReadinessApplyError = true;
      out.ossReadinessApply = { ...evidence, needsOperatorApproval: Boolean(needsOperator) };
      throw out;
    }

    if (diff.changedFiles.length > 0) {
      await execFileImpl('git', ['-C', workspaceDir, 'add', '--all'], {
        maxBuffer: 2 * 1024 * 1024,
      });
      await execFileImpl('git', ['-C', workspaceDir, 'commit', '-m', 'Apply oss-readiness remediation'], {
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...env,
          WORKER_CLASS: workerTrailerClass,
          WORKER_JOB_ID: job?.jobId || '',
          WORKER_RUN_AT: now(),
        },
      });
      const { stdout: commitSha } = await execFileImpl('git', ['-C', workspaceDir, 'rev-parse', 'HEAD'], {
        maxBuffer: 1 * 1024 * 1024,
      });
      evidence.commitSha = String(commitSha || '').trim() || null;
    } else {
      evidence.commitSha = null;
    }

    return evidence;
  } catch (err) {
    try {
      await resetOssReadinessWorkspace({ workspaceDir, execFileImpl });
      err.ossReadinessWorkspaceReset = true;
      if (err.ossReadinessApply && typeof err.ossReadinessApply === 'object') {
        err.ossReadinessApply.ossReadinessWorkspaceReset = true;
      }
    } catch (resetErr) {
      err.ossReadinessWorkspaceReset = false;
      err.ossReadinessWorkspaceResetError = resetErr?.message || String(resetErr);
      if (err.ossReadinessApply && typeof err.ossReadinessApply === 'object') {
        err.ossReadinessApply.ossReadinessWorkspaceReset = false;
        err.ossReadinessApply.ossReadinessWorkspaceResetError = err.ossReadinessWorkspaceResetError;
      }
    }
    throw err;
  }
}

export {
  OSS_READINESS_APPLY_SCRIPT_ENV,
  OSS_READINESS_AUDIT_CHECK_NAME,
  applyOssReadinessRemediation,
  jobHasOssReadinessAuditFailure,
  resolveOssReadinessApplyScript,
  rollbackOssReadinessLocalCommit,
};

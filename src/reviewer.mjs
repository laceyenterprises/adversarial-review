/**
 * LAC-12 + LAC-13: Reviewer Agent + Linear Integration
 *
 * One-shot: fetch PR diff → adversarial review → post GitHub comment → update Linear.
 *
 * Called by watcher.mjs as a child process:
 *   node src/reviewer.mjs '<JSON args>'
 *
 * Args JSON shape:
 *   { repo, prNumber, reviewerModel, botTokenEnv, linearTicketId, reviewerSessionUuid }
 *
 * ── Auth Policy (NON-NEGOTIABLE) ────────────────────────────────────────────
 * Claude reviews MUST use OAuth (claude CLI), never ANTHROPIC_API_KEY.
 * Codex reviews MUST use OAuth (codex CLI), never OPENAI_API_KEY.
 * If OAuth credentials are missing or expired → STOP and alert Paul via Clio.
 * API key fallback is intentionally NOT implemented here. On Darwin,
 * Claude is launched via `launchctl asuser`, so the wrapped command also
 * explicitly unsets API-key env vars inside the target process.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  createFollowUpJob,
  resolveRoundBudgetForJob,
  summarizePRRemediationLedger,
} from './follow-up-jobs.mjs';
import {
  buildObviousDocsGuidance,
  extractLinkedRepoDocs,
  fetchLinkedSpecContents,
  parseGitHubBlobPath,
} from './prompt-context.mjs';
import { resolveProgressTimeoutMs, resolveReviewerTimeoutMs } from './reviewer-timeout.mjs';
import { spawnCapturedProcessGroup } from './process-group-spawn.mjs';
import { looksLikeRuntimeJunk, sanitizeCodexReviewPayload } from './kernel/verdict.mjs';
import { loadStagePrompt, pickReviewerStage } from './kernel/prompt-stage.mjs';
import { createLinearTriageAdapter } from './adapters/operator/linear-triage/index.mjs';

const execFileAsync = promisify(execFile);

async function spawnWithInput(command, args, {
  env,
  cwd,
  input = '',
  timeout = 0,
  progressTimeout = resolveProgressTimeoutMs(env),
  killGraceMs,
  maxBuffer = 10 * 1024 * 1024,
  signal,
} = {}) {
  return spawnCapturedProcessGroup(command, args, {
    env,
    cwd,
    input,
    timeout,
    progressTimeout,
    killGraceMs,
    maxBuffer,
    signal,
  });
}

async function spawnCaptured(command, args, {
  env,
  cwd,
  timeout = 0,
  progressTimeout = resolveProgressTimeoutMs(env),
  killGraceMs,
  maxBuffer = 10 * 1024 * 1024,
  signal,
} = {}) {
  return spawnWithInput(command, args, {
    env,
    cwd,
    input: '',
    timeout,
    progressTimeout,
    killGraceMs,
    maxBuffer,
    signal,
  });
}

// ── CLI paths ────────────────────────────────────────────────────────────────

// Claude Code CLI — runs as the current user.
// Must NOT have ANTHROPIC_API_KEY in env when validating or invoking,
// otherwise the CLI may report API-key auth instead of its native login state.
const CLAUDE_CLI = '/opt/homebrew/bin/claude';
const LAUNCHCTL = '/bin/launchctl';
const ENV_BIN = '/usr/bin/env';
const CLAUDE_STRIPPED_ENV_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];

// ACPX-local Codex adapter path. The reviewer keeps wrapper-owned completion
// semantics: ACPX/Codex does the work, and the outer wrapper owns parsing /
// posting / downstream side effects. Today the handoff is ACPX stdout capture;
// explicit file-artifact handoff remains a valid future refinement.
const ACPX_CLI = '/Users/airlock/.openclaw/tools/acpx/node_modules/.bin/acpx';

// Raw Codex CLI is still used only for login-status probing.
const CODEX_CLI = '/Users/placey/.local/share/fnm/node-versions/v24.14.0/installation/bin/codex';

// OPENAI_API_KEY is stripped from env so Codex cannot fall back to API-key auth.

function resolveClaudeAuthProbeTimeoutMs(env = process.env) {
  const parsed = Number.parseInt(env.CLAUDE_AUTH_PROBE_TIMEOUT_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
}

// ── OAuth credential checks ──────────────────────────────────────────────────

/**
 * Verify Claude auth is available through the CLI's native login state.
 *
 * IMPORTANT: strip ANTHROPIC_API_KEY from env before probing, otherwise
 * `claude auth status` may report API-key mode and mask the real login state.
 */
async function assertClaudeOAuth() {
  if (!existsSync(CLAUDE_CLI)) {
    throw new OAuthError('claude', `claude CLI not found at ${CLAUDE_CLI}`);
  }

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  let stdout = '';
  let stderr = '';
  try {
    ({ stdout, stderr } = await spawnClaude(
      ['auth', 'status'],
      { env, timeout: resolveClaudeAuthProbeTimeoutMs(env) }
    ));
  } catch (err) {
    if (err?.isLaunchctlSessionError) {
      throw err;
    }
    stdout = err.stdout || '';
    stderr = err.stderr || '';
    const msg = `${err.message || ''}\n${stdout}\n${stderr}`.toLowerCase();
    if (msg.includes('"loggedin": false') || msg.includes('not logged in') || msg.includes('login required') || msg.includes('unauthorized')) {
      throw new OAuthError('claude', `Claude CLI reports not logged in: ${(stdout || stderr || err.message).trim()}`);
    }
    throw new OAuthError('claude', `Claude auth probe failed: ${(stdout || stderr || err.message).trim()}`);
  }

  const text = `${stdout || ''}\n${stderr || ''}`.toLowerCase();
  if (text.includes('"loggedin": false') || text.includes('not logged in') || text.includes('login required')) {
    throw new OAuthError('claude', `Claude CLI reports not logged in: ${(stdout || stderr).trim()}`);
  }
}

async function spawnClaude(args, options = {}) {
  const {
    execFileImpl = execFileAsync,
    platform = process.platform,
    uid = typeof process.getuid === 'function' ? process.getuid() : null,
    ...execOptions
  } = options;

  if (platform === 'darwin') {
    if (!Number.isInteger(uid) || uid <= 0) {
      throw new Error('Cannot resolve a non-root user uid for launchctl asuser');
    }

    try {
      const command = LAUNCHCTL;
      const commandArgs = [
        'asuser',
        String(uid),
        ENV_BIN,
        ...CLAUDE_STRIPPED_ENV_VARS.flatMap((name) => ['-u', name]),
        CLAUDE_CLI,
        ...args,
      ];
      if (execFileImpl === execFileAsync) {
        return await spawnCapturedProcessGroup(command, commandArgs, execOptions);
      }
      return await execFileImpl(command, commandArgs, execOptions);
    } catch (err) {
      const details = formatChildProcessFailureDetails(err);
      if (!isClaudeLoggedOutStatus(details) && isLaunchctlSessionFailure(details)) {
        throw new LaunchctlSessionError(details.trim(), { cause: err, stdout: err?.stdout, stderr: err?.stderr });
      }
      throw err;
    }
  }

  if (execFileImpl === execFileAsync) {
    return spawnCapturedProcessGroup(CLAUDE_CLI, args, execOptions);
  }
  return execFileImpl(CLAUDE_CLI, args, execOptions);
}

function resolveCodexAuthPath() {
  // Codex OAuth credentials are stored under the placey user (who owns Codex),
  // not necessarily under the current process HOME. CODEX_AUTH_PATH env var
  // allows explicit override; otherwise default to placey's home.
  return process.env.CODEX_AUTH_PATH || '/Users/placey/.codex/auth.json';
}

/**
 * Verify the intended Codex auth.json exists, is readable, and is OAuth/chatgpt mode.
 * This reads the file directly rather than trusting CLI commands that may be unavailable.
 */
function assertCodexAuthReadable() {
  const authPath = resolveCodexAuthPath();
  if (!existsSync(authPath)) {
    throw new OAuthError('codex', `OAuth auth.json missing: ${authPath}`);
  }

  let raw;
  try {
    raw = readFileSync(authPath, 'utf8');
  } catch (err) {
    throw new OAuthError('codex', `cannot read ${authPath}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new OAuthError('codex', `invalid auth.json at ${authPath}: ${err.message}`);
  }

  if ((parsed?.auth_mode || '').toLowerCase() !== 'chatgpt') {
    throw new OAuthError('codex', `Codex auth file is not OAuth/chatgpt mode (found: ${parsed?.auth_mode}): ${authPath}`);
  }

  if (!parsed?.tokens?.access_token || !parsed?.tokens?.refresh_token) {
    throw new OAuthError('codex', `Codex auth.json missing required OAuth tokens: ${authPath}`);
  }

  if (!parsed?.tokens?.access_token || !parsed?.tokens?.refresh_token) {
    throw new OAuthError('codex', `Codex auth file missing OAuth tokens: ${authPath}`);
  }

  return authPath;
}

async function assertCodexOAuth() {
  if (!existsSync(CODEX_CLI)) {
    throw new OAuthError('codex', `codex CLI not found at ${CODEX_CLI}`);
  }

  // Verify auth.json is readable and contains valid OAuth tokens.
  // This is more reliable than CLI probes, which may not support `login status`.
  assertCodexAuthReadable();
}

/**
 * Custom error class for OAuth failures — triggers Clio alert in main().
 */
class OAuthError extends Error {
  constructor(model, reason) {
    super(`[OAuth] ${model} credentials unavailable: ${reason}`);
    this.model = model;
    this.isOAuthError = true;
  }
}

class LaunchctlSessionError extends Error {
  constructor(reason, { cause, stdout = '', stderr = '' } = {}) {
    super(`Claude launchctl session bootstrap failed: ${reason}`);
    this.name = 'LaunchctlSessionError';
    this.cause = cause;
    this.stdout = stdout;
    this.stderr = stderr;
    this.isLaunchctlSessionError = true;
  }
}

// ── Utility functions ────────────────────────────────────────────────────────

function stripCodexRuntimeNoise(text) {
  const lines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n');

  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    return !(
      /^warning:\s+proceeding, even though we could not update path:/i.test(trimmed) ||
      /^reading prompt from stdin/i.test(trimmed) ||
      /^reading additional input from stdin/i.test(trimmed) ||
      /^openai codex v/i.test(trimmed) ||
      /^model:/i.test(trimmed) ||
      /^cwd:/i.test(trimmed) ||
      /^approval:/i.test(trimmed) ||
      /^sandbox:/i.test(trimmed) ||
      /^reasoning:/i.test(trimmed)
    );
  });

  return filtered.join('\n').trim();
}

function previewText(text, limit = 200) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return '<empty>';
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

// LAC-545: forensic preservation of codex outputs that the sanitizer
// rejects. Persists into `data/codex-review-rejected/` with a stable
// `<owner>__<repo>__pr-<N>__<iso>.md` name. The directory is gitignored
// so the forensic snapshots don't accumulate into the repo. Capped at
// 50 KB per file so a runaway codex output can't fill the disk.
const REJECTED_CODEX_OUTPUT_CAP_BYTES = 50 * 1024;

function persistRejectedCodexOutput({ repo, prNumber, rejectionReason, rawReviewText }) {
  // Resolve the persistence directory relative to this module so the
  // path is stable whether the watcher is running from a worktree or
  // from the deploy checkout.
  const rootDir = join(
    fileURLToPath(import.meta.url),
    '..',
    '..',
    'data',
    'codex-review-rejected'
  );
  mkdirSync(rootDir, { recursive: true });
  const safeRepo = String(repo || 'unknown')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .slice(0, 80);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `${safeRepo}__pr-${prNumber}__${ts}.md`;
  const filePath = join(rootDir, fileName);
  const header = [
    `<!-- LAC-545 forensic dump of codex output that sanitizeCodexReviewPayload rejected -->`,
    `<!-- repo: ${repo} -->`,
    `<!-- prNumber: ${prNumber} -->`,
    `<!-- rejectedAt: ${new Date().toISOString()} -->`,
    `<!-- rejectionReason: ${String(rejectionReason || '').slice(0, 400)} -->`,
    `<!-- rawLengthBytes: ${Buffer.byteLength(String(rawReviewText || ''), 'utf8')} -->`,
    '',
  ].join('\n');
  const truncated = String(rawReviewText || '').slice(0, REJECTED_CODEX_OUTPUT_CAP_BYTES);
  const truncationNotice = String(rawReviewText || '').length > REJECTED_CODEX_OUTPUT_CAP_BYTES
    ? `\n\n<!-- truncated to ${REJECTED_CODEX_OUTPUT_CAP_BYTES} bytes -->\n`
    : '';
  writeFileSync(filePath, `${header}${truncated}${truncationNotice}`, { encoding: 'utf8', mode: 0o600 });
  console.error(`[reviewer] persisted rejected codex output: ${filePath}`);
  return filePath;
}

function formatChildProcessFailureDetails(err) {
  return [
    err?.message || '',
    `code=${err?.code ?? '<none>'} exitCode=${err?.exitCode ?? '<none>'} signal=${err?.signal ?? '<none>'} killed=${err?.killed === true}`,
    err?.stdout ? `stdout:\n${err.stdout}` : '',
    err?.stderr ? `stderr:\n${err.stderr}` : '',
  ].filter(Boolean).join('\n');
}

function isLaunchctlSessionFailure(text) {
  return /(launchctl|bootstrap failed|could not find domain|input\/output error|not privileged to set domain|gui\/\d+)/i.test(String(text ?? ''));
}

function isClaudeLoggedOutStatus(text) {
  return /"loggedin"\s*:\s*false|"authmethod"\s*:\s*"none"/i.test(String(text ?? ''));
}

// ── Adversarial prompt (NON-NEGOTIABLE) ──────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const REVIEWER_PROMPT_SET = 'code-pr';
const ADVERSARIAL_PROMPT = loadStagePrompt({
  rootDir: ROOT,
  promptSet: REVIEWER_PROMPT_SET,
  actor: 'reviewer',
  stage: 'first',
});

const ADVERSARIAL_PROMPT_FINAL_ROUND = loadStagePrompt({
  rootDir: ROOT,
  promptSet: REVIEWER_PROMPT_SET,
  actor: 'reviewer',
  stage: 'last',
});
const ADVERSARIAL_PROMPT_FINAL_ROUND_ADDENDUM = readFileSync(
  join(ROOT, 'prompts', REVIEWER_PROMPT_SET, 'reviewer.last.addendum.md'),
  'utf8',
).trim();

function buildReviewerPromptPrefix({
  isFinalRound = false,
  stage,
  reviewAttemptNumber,
  completedRemediationRounds,
  maxRemediationRounds,
} = {}) {
  const inferredCompletedRemediationRounds = completedRemediationRounds ?? (
    Number.isFinite(Number(reviewAttemptNumber)) ? Number(reviewAttemptNumber) - 1 : undefined
  );
  const selectedStage = stage || (
    isFinalRound
      ? 'last'
      : (reviewAttemptNumber !== undefined || completedRemediationRounds !== undefined || maxRemediationRounds !== undefined)
        ? pickReviewerStage({
            reviewAttemptNumber,
            completedRemediationRounds: inferredCompletedRemediationRounds,
            maxRemediationRounds,
          })
        : 'first'
  );

  return loadStagePrompt({
    rootDir: ROOT,
    promptSet: REVIEWER_PROMPT_SET,
    actor: 'reviewer',
    stage: selectedStage,
  });
}

// Compute whether the current review attempt is the final one allowed
// under the bounded remediation cap. Convention:
//   reviewAttemptNumber=1 = initial review, no remediation done yet
//   reviewAttemptNumber=N = N-1 remediation rounds completed
// So when reviewAttemptNumber > maxRemediationRounds, the reviewer is
// looking at the work after the last remediation cycle and there are
// no more rounds left to fix anything blocked here. That is the
// "lenient threshold" round.
function isFinalReviewRound({ reviewAttemptNumber, maxRemediationRounds }) {
  const attempt = Number(reviewAttemptNumber);
  const cap = Number(maxRemediationRounds);
  if (!Number.isFinite(attempt) || attempt <= 0) return false;
  if (!Number.isFinite(cap) || cap <= 0) return false;
  return attempt > cap;
}

function parseDiffFiles(diffText) {
  const diff = String(diffText ?? '').replace(/\r\n/g, '\n');
  const matches = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)];
  return matches.map((match, index) => {
    const oldPath = match[1];
    const newPath = match[2];
    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? diff.length) : diff.length;
    return {
      oldPath,
      newPath,
      path: newPath === '/dev/null' ? oldPath : newPath,
      patch: diff.slice(start, end),
    };
  });
}

function deriveSpecTouchProject(path) {
  const normalizedPath = String(path ?? '');
  let match = normalizedPath.match(/^(?:projects|modules|tools)\/([^/]+)\/SPEC\.md$/);
  if (match) return match[1];
  match = normalizedPath.match(/^docs\/(?:SPEC|RUNBOOK)-(.+?)\.md$/);
  if (match) return match[1];
  return null;
}

function specTouchMatchesProject(path, project) {
  if (!path || !project) return false;
  const normalizedPath = String(path);
  const normalizedProject = String(project);
  return (
    normalizedPath === `projects/${normalizedProject}/SPEC.md` ||
    normalizedPath === `modules/${normalizedProject}/SPEC.md` ||
    normalizedPath === `tools/${normalizedProject}/SPEC.md` ||
    normalizedPath === `docs/SPEC-${normalizedProject}.md` ||
    normalizedPath.startsWith(`docs/SPEC-${normalizedProject}-`) ||
    normalizedPath === `docs/RUNBOOK-${normalizedProject}.md` ||
    normalizedPath.startsWith(`docs/RUNBOOK-${normalizedProject}-`)
  );
}

function describeTrackedContractChange({ path, patch }) {
  if (/^platform\/session-ledger\/src\/.*\.py$/.test(path)) {
    const signatureMatch = patch.match(/^[+-]def\s+([A-Za-z][A-Za-z0-9_]*)\s*\(/m);
    if (signatureMatch) {
      return {
        project: 'session-ledger',
        thing: `public Python signature \`${signatureMatch[1]}(...)\` in \`${path}\``,
      };
    }
  }

  if (/^modules\/([^/]+)\/(?:lib\/python|lib|server)\/.*\.py$/.test(path)) {
    const project = path.match(/^modules\/([^/]+)\//)?.[1];
    const signatureMatch = patch.match(/^[+-]def\s+([A-Za-z][A-Za-z0-9_]*)\s*\(/m);
    if (project && signatureMatch) {
      return {
        project,
        thing: `public Python signature \`${signatureMatch[1]}(...)\` in \`${path}\``,
      };
    }
  }

  if (/^platform\/session-ledger\/src\/session_ledger\/migrations\/.+\.sql$/.test(path)) {
    return {
      project: 'session-ledger',
      thing: `SQL migration \`${path}\``,
    };
  }

  if (/worker_events/i.test(path)) {
    return {
      project: path.match(/^modules\/([^/]+)\//)?.[1] || 'worker-pool',
      thing: `worker_events payload shape in \`${path}\``,
    };
  }

  if (/^modules\/worker-pool\/bin\/hq(?:-[^/]+)?$/.test(path)) {
    return {
      project: 'worker-pool',
      thing: `CLI contract in \`${path}\``,
    };
  }

  return null;
}

function detectSpecTouchViolations(diffText) {
  const files = parseDiffFiles(diffText);
  const touchedSpecProjects = new Set(
    files
      .map((file) => deriveSpecTouchProject(file.path))
      .filter(Boolean)
  );

  const violations = [];
  for (const file of files) {
    const contract = describeTrackedContractChange(file);
    if (!contract) continue;

    const publicSignatureNames = [...file.patch.matchAll(/^[+-]def\s+([A-Za-z][A-Za-z0-9_]*)\s*\(/gm)].map((match) => match[1]);
    if (publicSignatureNames.length > 0 && publicSignatureNames.every((name) => name.startsWith('_'))) {
      continue;
    }

    const specTouched =
      touchedSpecProjects.has(contract.project) ||
      files.some((candidate) => specTouchMatchesProject(candidate.path, contract.project));
    if (specTouched) continue;

    violations.push({
      project: contract.project,
      thing: contract.thing,
      message: `Contract changed without spec update. The diff modifies ${contract.thing} but no canonical spec doc for \`${contract.project}\` was touched. Update the corresponding SPEC/RUNBOOK entry or revert the contract change.`,
    });
  }

  return violations;
}

// ── Critical-issue detection ─────────────────────────────────────────────────

const CRITICAL_WORDS = ['critical', 'vulnerability', 'security', 'injection'];

function isCritical(reviewText) {
  const lower = reviewText.toLowerCase();
  return CRITICAL_WORDS.some((w) => lower.includes(w));
}

function shouldQueueFollowUpForReview(reviewText) {
  return Boolean(reviewText);
}

function queueFollowUpForPostedReview({
  rootDir = ROOT,
  repo,
  prNumber,
  reviewerModel,
  builderTag = null,
  linearTicketId = null,
  reviewText,
  reviewPostedAt = new Date().toISOString(),
  critical = false,
  summarizePRRemediationLedgerImpl = summarizePRRemediationLedger,
  createFollowUpJobImpl = createFollowUpJob,
}) {
  if (!shouldQueueFollowUpForReview(reviewText)) {
    return { queued: false, reason: 'empty-review-body' };
  }

  const priorLedger = summarizePRRemediationLedgerImpl(rootDir, { repo, prNumber });
  const tierResolution = resolveRoundBudgetForJob({ linearTicketId }, {
    rootDir,
    preferPersisted: false,
  });
  const latestMaxRounds = Number(priorLedger.latestMaxRounds);
  const elevatedPriorCap = Number.isInteger(latestMaxRounds) && latestMaxRounds > tierResolution.roundBudget
    ? latestMaxRounds
    : null;

  const { jobPath } = createFollowUpJobImpl({
    rootDir,
    repo,
    prNumber,
    reviewerModel,
    builderTag: builderTag || null,
    linearTicketId,
    reviewBody: reviewText,
    reviewPostedAt,
    critical,
    riskClass: tierResolution.riskClass,
    priorCompletedRounds: priorLedger.completedRoundsForPR,
    ...(elevatedPriorCap ? { maxRemediationRounds: elevatedPriorCap } : {}),
  });
  return { queued: true, jobPath };
}

// ── PR diff fetch ────────────────────────────────────────────────────────────

async function fetchPRDiff(repo, prNumber) {
  const { stdout } = await execFileAsync(
    'gh',
    ['pr', 'diff', String(prNumber), '--repo', repo],
    { maxBuffer: 10 * 1024 * 1024 }
  );
  return stdout;
}

async function fetchPRContext(repo, prNumber) {
  const { stdout } = await execFileAsync(
    'gh',
    ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'body,comments,headRefOid'],
    { maxBuffer: 10 * 1024 * 1024 }
  );
  return JSON.parse(stdout);
}

// ── AI review via CLI (OAuth only) ──────────────────────────────────────────

/**
 * Run adversarial review using Claude Code CLI (OAuth).
 * ANTHROPIC_API_KEY is explicitly removed from the env so the CLI
 * uses its native OAuth path only. Preflight auth validation is aligned with
 * the broker/Keychain path used by the live stack.
 */
async function reviewWithClaude(diff, extraContext = '', { promptStage = 'first' } = {}) {
  await assertClaudeOAuth();

  const promptPrefix = buildReviewerPromptPrefix({ stage: promptStage });
  const prompt = `${promptPrefix}${extraContext}\n\n---\n\nHere is the PR diff to review:\n\n\`\`\`diff\n${diff}\`\`\``;

  // Strip API key from env — Claude CLI falls back to OAuth when it's absent
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  let stdout, stderr;
  try {
    ({ stdout, stderr } = await spawnClaude(
      ['--print', '--permission-mode', 'bypassPermissions', prompt],
      {
        env,
        timeout: resolveReviewerTimeoutMs(env),
        maxBuffer: 10 * 1024 * 1024,
      }
    ));
  } catch (err) {
    if (err?.isLaunchctlSessionError) {
      throw err;
    }
    // Detect OAuth expiry in error output
    const msg = (err.message || '') + (err.stderr || '');
    if (msg.includes('401') || msg.includes('Unauthorized') || msg.includes('oauth') || msg.includes('login')) {
      throw new OAuthError('claude', `CLI returned auth error: ${msg.substring(0, 200)}`);
    }
    throw err;
  }

  if (!stdout?.trim()) {
    const hint = stderr?.trim() ? ` stderr: ${stderr.substring(0, 200)}` : '';
    throw new Error(`Claude CLI returned empty output.${hint}`);
  }

  return stdout.trim();
}

/**
 * Run adversarial review using Codex CLI (OAuth).
 * OPENAI_API_KEY is explicitly removed from the env so Codex
 * uses its stored OAuth credentials only.
 *
 * Note: ACPX session bootstrap is currently broken in this environment
 * (see runbooks/INCIDENT-2026-04-21-ACPX-codex-exec-regression.md).
 * Using native Codex CLI instead, which is stable and produces quality reviews.
 */
async function reviewWithCodex(diff, extraContext = '', { promptStage = 'first' } = {}) {
  console.error('[reviewWithCodex] asserting OAuth...');
  await assertCodexOAuth();
  console.error('[reviewWithCodex] OAuth OK');

  if (!existsSync(CODEX_CLI)) {
    throw new Error(`Codex CLI not found at ${CODEX_CLI}`);
  }

  const promptPrefix = buildReviewerPromptPrefix({ stage: promptStage });
  const prompt = `${promptPrefix}${extraContext}\n\n---\n\nHere is the PR diff to review:\n\n\`\`\`diff\n${diff}\`\`\``;
  const authPath = resolveCodexAuthPath();
  const outputPath = join(tmpdir(), `codex-review-${process.pid}-${Date.now()}.md`);

  const env = {
    ...process.env,
    PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    CODEX_AUTH_PATH: authPath,
    HOME: process.env.HOME || '/Users/placey',
  };
  delete env.OPENAI_API_KEY;

  let stdout = '';
  let stderr = '';
  try {
    console.error('[reviewWithCodex] invoking native Codex CLI');
    const result = await spawnCaptured(
      CODEX_CLI,
      [
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '--ephemeral',
        '--output-last-message',
        outputPath,
        '--',
        prompt,
      ],
      {
        env,
        cwd: process.cwd(),
        timeout: resolveReviewerTimeoutMs(env),
        maxBuffer: 10 * 1024 * 1024,
      }
    );
    stdout = result.stdout || '';
    stderr = result.stderr || '';
  } catch (err) {
    stdout = err.stdout || '';
    stderr = err.stderr || '';
    const msg = `${err.message || ''}\n${stdout}\n${stderr}`;
    if (/401|unauthorized|oauth|login required|not logged in/i.test(msg)) {
      throw new OAuthError('codex', `CLI returned auth error: ${msg.substring(0, 200)}`);
    }
    throw new Error(`Native Codex exec failed: ${msg.substring(0, 800)}`);
  }

  let fileOutput = '';
  const outputFileExists = existsSync(outputPath);
  try {
    if (outputFileExists) {
      fileOutput = readFileSync(outputPath, 'utf8');
    }
  } finally {
    try { unlinkSync(outputPath); } catch {}
  }

  console.error(`[reviewWithCodex] native Codex returned stdout length=${stdout.length}; stderr length=${stderr.length}; file exists=${outputFileExists}; file length=${fileOutput.length}`);
  console.error(`[reviewWithCodex] stdout preview: ${previewText(stdout)}`);
  console.error(`[reviewWithCodex] stderr preview: ${previewText(stderr)}`);
  console.error(`[reviewWithCodex] file preview: ${previewText(fileOutput)}`);

  const cleanedStdout = stripCodexRuntimeNoise(stdout);
  const cleanedStderr = stripCodexRuntimeNoise(stderr);
  const cleanedFile = stripCodexRuntimeNoise(fileOutput);
  const combined = normalizeWhitespace(cleanedFile || cleanedStdout || cleanedStderr || '');

  if (looksLikeRuntimeJunk(stdout) && !combined) {
    throw new Error(`Native Codex returned runtime/status junk instead of a review: ${stdout.substring(0, 400)}`);
  }

  if (!combined) {
    const hint = stderr?.trim() ? ` stderr: ${stderr.substring(0, 200)}` : '';
    throw new Error(`Native Codex returned empty output.${hint}`);
  }

  return combined;
}

// ── GitHub review posting ────────────────────────────────────────────────────

async function postGitHubReview(repo, prNumber, reviewBody, botTokenEnv) {
  const token = process.env[botTokenEnv];
  if (!token) {
    throw new Error(`Missing env var: ${botTokenEnv}`);
  }

  await execFileAsync(
    'gh',
    ['pr', 'review', String(prNumber), '--repo', repo, '--comment', '--body', reviewBody],
    {
      env: { ...process.env, GH_TOKEN: token },
      maxBuffer: 5 * 1024 * 1024,
    }
  );
}

// ── Clio alert (OAuth failure) ───────────────────────────────────────────────

/**
 * Alert Paul via Clio when OAuth credentials are unavailable.
 * Uses the OpenClaw wake hook to deliver a Telegram message.
 */
async function alertClioOAuthFailure(model, repo, prNumber, reason) {
  const msg = `🔐 Adversarial reviewer STOPPED — ${model} OAuth credentials unavailable.\n\nRepo: ${repo} PR #${prNumber}\nReason: ${reason}\n\nAction needed: re-authenticate ${model} (run the CLI and log in). PR review is paused until credentials are restored.`;

  console.error(`[reviewer] ALERT: ${msg}`);

  // Try to wake Clio via the OpenClaw hook
  try {
    await execFileAsync(
      'curl',
      [
        '-s', '-X', 'POST',
        'http://127.0.0.1:8787/hooks/wake',
        '-H', 'Content-Type: application/json',
        '-d', JSON.stringify({ message: msg }),
      ],
      { timeout: 10_000 }
    );
    console.log('[reviewer] Clio alert sent via wake hook');
  } catch (err) {
    console.error('[reviewer] Failed to send Clio alert:', err.message);
    // Alert is best-effort — the error is already in watcher logs
  }
}

// ── Linear integration (LAC-13) ──────────────────────────────────────────────

const linearTriage = createLinearTriageAdapter({
  logger: console,
  criticalWords: CRITICAL_WORDS,
});

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const rawArgs = process.argv[2];
  if (!rawArgs) {
    console.error('[reviewer] Usage: node src/reviewer.mjs \'<JSON args>\'');
    process.exit(1);
  }

  let args;
  try {
    args = JSON.parse(rawArgs);
  } catch {
    console.error('[reviewer] Invalid JSON args:', rawArgs);
    process.exit(1);
  }

  const {
    repo,
    prNumber,
    reviewerModel,
    botTokenEnv,
    linearTicketId,
    builderTag,
    reviewAttemptNumber,
    completedRemediationRounds,
    maxRemediationRounds,
    reviewerSessionUuid,
  } = args;

  if (!repo || !prNumber || !reviewerModel || !botTokenEnv) {
    console.error('[reviewer] Missing required fields in args:', args);
    process.exit(1);
  }

  // The reviewer treats the final allowed review pass as a lenient
  // verdict round (only blocking on data corruption / secret leakage /
  // security regression / broken external contract). Computed from the
  // (1-indexed) attempt number and the remediation cap, both passed by
  // the watcher. Backward-compat: if either is missing (old watcher
  // calling new reviewer), default to non-final-round behavior so we
  // don't accidentally downgrade reviews on older deployments.
  const reviewerCompletedRemediationRounds = completedRemediationRounds ?? (
    Number.isFinite(Number(reviewAttemptNumber)) ? Number(reviewAttemptNumber) - 1 : undefined
  );
  const reviewerPromptStage = (
    reviewAttemptNumber === undefined &&
    completedRemediationRounds === undefined &&
    maxRemediationRounds === undefined
  )
    ? 'first'
    : pickReviewerStage({
        reviewAttemptNumber,
        completedRemediationRounds: reviewerCompletedRemediationRounds,
        maxRemediationRounds,
      });
  const isFinalRound = reviewerPromptStage === 'last';

  console.log(
    `[reviewer] Starting review: ${repo}#${prNumber} model=${reviewerModel}` +
    ` (OAuth-only mode; prompt stage=${reviewerPromptStage}${isFinalRound ? `; FINAL round attempt ${reviewAttemptNumber} of ${1 + Number(maxRemediationRounds || 0)} — lenient verdict threshold active` : ''})`
  );
  console.error(`[reviewer] DEBUG: args=${JSON.stringify(args)}`);

  // 1. Fetch diff
  let diff;
  try {
    console.error(`[reviewer] DEBUG: fetching diff for ${repo}#${prNumber}...`);
    diff = await fetchPRDiff(repo, prNumber);
    console.error(`[reviewer] DEBUG: fetched diff (${diff.length} bytes)`);
  } catch (err) {
    console.error(`[reviewer] Failed to fetch diff for ${repo}#${prNumber}:`, err.message);
    process.exit(1);
  }

  if (!diff.trim()) {
    console.log(`[reviewer] Empty diff for ${repo}#${prNumber} — nothing to review`);
    process.exit(0);
  }

  let extraContext = buildObviousDocsGuidance();
  try {
    const linkedContext = await fetchLinkedSpecContents(repo, prNumber, {
      fetchPRContextImpl: fetchPRContext,
      execFileImpl: execFileAsync,
    });
    if (linkedContext) {
      extraContext = `${linkedContext}${buildObviousDocsGuidance({ repoRootRelative: true, includeSelfContainedHint: true })}`;
      console.error(`[reviewer] DEBUG: fetched linked PR context (${linkedContext.length} bytes)`);
    } else {
      console.error('[reviewer] DEBUG: no linked PR context found; using obvious-docs fallback guidance');
    }
  } catch (err) {
    console.error(`[reviewer] WARN: failed to fetch linked PR context: ${err.message}`);
  }

  // 2. Run adversarial review (OAuth only — no API key fallback)
  const effectiveModel = reviewerModel;

  let reviewText;
  let rawReviewText;
  try {
    console.error(`[reviewer] DEBUG: starting ${effectiveModel} review...`);
    if (effectiveModel === 'claude') {
      rawReviewText = await reviewWithClaude(diff, extraContext, { promptStage: reviewerPromptStage });
      reviewText = rawReviewText;
    } else {
      rawReviewText = await reviewWithCodex(diff, extraContext, { promptStage: reviewerPromptStage });
      console.error(`[reviewer] DEBUG: raw Codex review length=${rawReviewText.length}; preview=${previewText(rawReviewText)}`);
      try {
        reviewText = sanitizeCodexReviewPayload(rawReviewText);
      } catch (sanitizeErr) {
        console.error(`[reviewer] SANITIZE FAILED: ${sanitizeErr.message}`);
        console.error(`[reviewer] SANITIZE INPUT PREVIEW: ${previewText(rawReviewText, 400)}`);
        // LAC-545: forensic preservation. Persist the rejected raw codex
        // output so a future fix to the sanitizer / prompt / codex CLI
        // can be diagnosed without re-triggering the failure. Before
        // this, every rejection was lost — the codex output file was
        // unlinked inside reviewWithCodex and the watcher's classifier
        // silenced the stderr. Truncate to 50 KB to bound disk usage.
        try {
          persistRejectedCodexOutput({
            repo,
            prNumber,
            rejectionReason: sanitizeErr.message,
            rawReviewText,
          });
        } catch (persistErr) {
          console.error(`[reviewer] WARN: failed to persist rejected codex output: ${persistErr.message}`);
        }
        throw sanitizeErr;
      }
    }
    console.error(`[reviewer] DEBUG: review completed (${reviewText.length} bytes)`);
  } catch (err) {
    if (err.isOAuthError) {
      // OAuth failure — stop work and alert Paul
      await alertClioOAuthFailure(reviewerModel, repo, prNumber, err.message);
      console.error(`[reviewer] Stopped: OAuth credentials unavailable for ${reviewerModel}`);
      process.exit(2); // exit code 2 = auth failure (distinct from other errors)
    }
    console.error(`[reviewer] AI review failed for ${repo}#${prNumber}:`, err.message);
    console.error(`[reviewer] ERROR STACK: ${err.stack}`);
    process.exit(1);
  }

  console.log(`[reviewer] Review generated (${reviewText.length} chars)`);

  // 3. Post to GitHub
  const header =
    effectiveModel === 'claude'
      ? '## Adversarial Review — Claude (claude-reviewer-lacey)\n\n'
      : '## Adversarial Review — Codex (codex-reviewer-lacey)\n\n';
  const fullComment = header + reviewText;

  try {
    console.error(`[reviewer] DEBUG: posting GitHub review body length=${fullComment.length}; preview=${previewText(fullComment, 300)}`);
    await postGitHubReview(repo, prNumber, fullComment, botTokenEnv);
    console.log(`[reviewer] Review posted to ${repo}#${prNumber}`);
  } catch (err) {
    console.error(`[reviewer] GITHUB POST FAILED for ${repo}#${prNumber}:`, err.message);
    process.exit(1);
  }

  const critical = isCritical(reviewText);
  const reviewPostedAt = new Date().toISOString();
  try {
    const queued = queueFollowUpForPostedReview({
      rootDir: ROOT,
      repo,
      prNumber,
      reviewerModel: effectiveModel,
      builderTag,
      linearTicketId,
      reviewText,
      reviewPostedAt,
      critical,
    });
    if (queued.queued) {
      console.log(`[reviewer] Follow-up handoff queued at ${queued.jobPath}`);
    } else {
      console.error(`[reviewer] Follow-up handoff skipped for ${repo}#${prNumber}: ${queued.reason}`);
    }
  } catch (err) {
    console.error(`[reviewer] Failed to queue follow-up handoff for ${repo}#${prNumber}:`, err.message);
  }

  // 4. Update Linear (LAC-13)
  try {
    console.error(`[reviewer] DEBUG: updating Linear ticket ${linearTicketId || '<none>'}; critical=${critical}`);
    await linearTriage.recordReviewCompleted({
      domainId: 'code-pr',
      subjectExternalId: `${repo}#${prNumber}`,
      revisionRef: null,
      linearTicketId,
    }, {
      critical,
      reviewSummary: reviewText,
    });
  } catch (err) {
    console.error(`[reviewer] LINEAR UPDATE FAILED for ${linearTicketId}:`, err.message);
    // Non-fatal — review was posted, just log and continue
  }

  if (critical) {
    console.log(`[reviewer] CRITICAL issues detected in ${repo}#${prNumber} — Paul flagged in Linear`);
  }

  console.log(`[reviewer] Done: ${repo}#${prNumber}`);
}

const __test__ = {
  LAUNCHCTL,
  ENV_BIN,
  CLAUDE_STRIPPED_ENV_VARS,
  spawnClaude,
  shouldQueueFollowUpForReview,
  queueFollowUpForPostedReview,
  isLaunchctlSessionFailure,
  isClaudeLoggedOutStatus,
  resolveClaudeAuthProbeTimeoutMs,
  resolveProgressTimeoutMs,
  resolveReviewerTimeoutMs,
  spawnCaptured,
};

export {
  CLAUDE_CLI,
  CODEX_CLI,
  sanitizeCodexReviewPayload,
  buildReviewerPromptPrefix,
  spawnCaptured,
  resolveReviewerTimeoutMs,
  isFinalReviewRound,
  detectSpecTouchViolations,
  ADVERSARIAL_PROMPT,
  ADVERSARIAL_PROMPT_FINAL_ROUND_ADDENDUM,
  __test__,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[reviewer] Unhandled error:', err);
    process.exit(1);
  });
}

import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  claimNextFollowUpJob,
  getFollowUpJobDir,
  markFollowUpJobFailed,
  markFollowUpJobSpawned,
} from './follow-up-jobs.mjs';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FOLLOW_UP_PROMPT_PATH = join(ROOT, 'prompts', 'follow-up-remediation.md');
const CODEX_CLI = '/Users/placey/.local/share/fnm/node-versions/v24.14.0/installation/bin/codex';

class OAuthError extends Error {
  constructor(model, reason) {
    super(`[OAuth] ${model} credentials unavailable: ${reason}`);
    this.model = model;
    this.isOAuthError = true;
  }
}

function resolveCodexAuthPath() {
  return process.env.CODEX_AUTH_PATH || '/Users/placey/.codex/auth.json';
}

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
    throw new OAuthError('codex', `Codex auth file missing OAuth tokens: ${authPath}`);
  }

  return authPath;
}

async function assertCodexOAuth() {
  if (!existsSync(CODEX_CLI)) {
    throw new OAuthError('codex', `codex CLI not found at ${CODEX_CLI}`);
  }

  return assertCodexAuthReadable();
}

function loadFollowUpPromptTemplate(rootDir = ROOT) {
  return readFileSync(join(rootDir, 'prompts', 'follow-up-remediation.md'), 'utf8').trim();
}

function buildRemediationPrompt(job, { template = loadFollowUpPromptTemplate(ROOT) } = {}) {
  const criticality = job.critical ? 'critical' : 'non-critical';
  const ticketLabel = job.linearTicketId || 'None provided';

  return `${template}

## Job Metadata
- Job ID: ${job.jobId}
- Repo: ${job.repo}
- PR Number: ${job.prNumber}
- Linear Ticket: ${ticketLabel}
- Reviewer Model: ${job.reviewerModel}
- Review Criticality: ${criticality}
- Queue Triggered At: ${job.createdAt}

## Review Summary
${job.reviewSummary}

## Full Adversarial Review
${job.reviewBody}

## Required Operating Rules
- Work on the PR branch that is already checked out in this repository clone.
- Address the review findings directly in code, tests, or docs as needed.
- Run the smallest relevant validation before finishing.
- Commit the remediation changes and push the PR branch.
- Do not open a new PR; this job is for an existing PR follow-up.
- Use OAuth-backed Codex only; do not rely on API key fallbacks.
- In your final message, report validation run and files changed.
`.trim();
}

async function prepareWorkspaceForJob({
  rootDir = ROOT,
  job,
  execFileImpl = execFileAsync,
}) {
  const workspaceDir = join(getFollowUpJobDir(rootDir, 'workspaces'), job.jobId);
  mkdirSync(getFollowUpJobDir(rootDir, 'workspaces'), { recursive: true });

  if (!existsSync(join(workspaceDir, '.git'))) {
    await execFileImpl('gh', ['repo', 'clone', job.repo, workspaceDir], {
      maxBuffer: 10 * 1024 * 1024,
    });
  }

  await execFileImpl('gh', ['pr', 'checkout', String(job.prNumber)], {
    cwd: workspaceDir,
    maxBuffer: 10 * 1024 * 1024,
  });

  return { workspaceDir };
}

function spawnCodexRemediationWorker({
  workspaceDir,
  promptPath,
  outputPath,
  logPath,
  spawnImpl = spawn,
}) {
  const authPath = resolveCodexAuthPath();
  const env = {
    ...process.env,
    PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    CODEX_AUTH_PATH: authPath,
    HOME: process.env.HOME || '/Users/placey',
  };
  delete env.OPENAI_API_KEY;

  const promptFd = openSync(promptPath, 'r');
  const stdoutFd = openSync(logPath, 'a');
  const stderrFd = openSync(logPath, 'a');

  try {
    const child = spawnImpl(
      CODEX_CLI,
      [
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '--ephemeral',
        '--output-last-message',
        outputPath,
        '-',
      ],
      {
        cwd: workspaceDir,
        detached: true,
        env,
        stdio: [promptFd, stdoutFd, stderrFd],
      }
    );

    if (typeof child.unref === 'function') {
      child.unref();
    }

    return {
      model: 'codex',
      processId: child.pid,
      workspaceDir,
      promptPath,
      outputPath,
      logPath,
      command: [
        CODEX_CLI,
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '--ephemeral',
        '--output-last-message',
        outputPath,
        '-',
      ],
    };
  } finally {
    closeSync(promptFd);
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
}

async function consumeNextFollowUpJob({
  rootDir = ROOT,
  execFileImpl = execFileAsync,
  spawnImpl = spawn,
  now = () => new Date().toISOString(),
  promptTemplate = loadFollowUpPromptTemplate(rootDir),
} = {}) {
  await assertCodexOAuth();

  const claimed = claimNextFollowUpJob({
    rootDir,
    claimedAt: now(),
  });

  if (!claimed) {
    return { consumed: false, reason: 'no-pending-jobs' };
  }

  try {
    const { workspaceDir } = await prepareWorkspaceForJob({
      rootDir,
      job: claimed.job,
      execFileImpl,
    });

    const artifactDir = join(workspaceDir, '.adversarial-follow-up');
    mkdirSync(artifactDir, { recursive: true });

    const promptPath = join(artifactDir, 'prompt.md');
    const outputPath = join(artifactDir, 'codex-last-message.md');
    const logPath = join(artifactDir, 'codex-worker.log');
    const prompt = buildRemediationPrompt(claimed.job, { template: promptTemplate });
    writeFileSync(promptPath, `${prompt}\n`, 'utf8');

    const worker = spawnCodexRemediationWorker({
      workspaceDir,
      promptPath,
      outputPath,
      logPath,
      spawnImpl,
    });

    const updated = markFollowUpJobSpawned({
      jobPath: claimed.jobPath,
      spawnedAt: now(),
      worker: {
        ...worker,
        workspaceDir: relative(rootDir, worker.workspaceDir),
        promptPath: relative(rootDir, worker.promptPath),
        outputPath: relative(rootDir, worker.outputPath),
        logPath: relative(rootDir, worker.logPath),
      },
    });

    return {
      consumed: true,
      job: updated.job,
      jobPath: updated.jobPath,
    };
  } catch (err) {
    const failed = markFollowUpJobFailed({
      rootDir,
      jobPath: claimed.jobPath,
      error: err,
      failedAt: now(),
    });
    err.followUpJobPath = failed.jobPath;
    throw err;
  }
}

async function main() {
  try {
    const result = await consumeNextFollowUpJob();
    if (!result.consumed) {
      console.log('[follow-up-remediation] No pending follow-up jobs to consume.');
      return;
    }

    console.log(
      `[follow-up-remediation] Spawned Codex remediation worker pid=${result.job.remediationWorker.processId} for ${result.job.repo}#${result.job.prNumber}`
    );
    console.log(`[follow-up-remediation] Queue record: ${result.jobPath}`);
  } catch (err) {
    if (err.isOAuthError) {
      console.error(`[follow-up-remediation] Stopped: ${err.message}`);
      process.exit(2);
    }

    console.error('[follow-up-remediation] Failed to consume follow-up job:', err.message);
    if (err.followUpJobPath) {
      console.error(`[follow-up-remediation] Failed job record moved to ${err.followUpJobPath}`);
    }
    process.exit(1);
  }
}

export {
  CODEX_CLI,
  FOLLOW_UP_PROMPT_PATH,
  OAuthError,
  assertCodexOAuth,
  buildRemediationPrompt,
  consumeNextFollowUpJob,
  loadFollowUpPromptTemplate,
  prepareWorkspaceForJob,
  resolveCodexAuthPath,
  spawnCodexRemediationWorker,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

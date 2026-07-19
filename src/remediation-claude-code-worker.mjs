// Claude Code remediation worker.
//
// Extracted from follow-up-remediation.mjs (ARC-19). Self-contained leaf for
// the claude-code remediation worker spawn path: resolve the claude CLI,
// prepare a scrubbed OAuth-only startup env, and spawn the detached worker.
// Cross-model rule: the BUILDER fixes their own code, so a `[claude-code]` PR
// (reviewed by Codex) is remediated by Claude Code, mirroring
// spawnCodexRemediationWorker.
//
// MUST NOT import ./follow-up-remediation.mjs — the monolith imports this
// module, not the other way around.
//
// The OAuth pre-flight (`assertClaudeCodeOAuth`) stays in the monolith: it
// shares the per-process `__oauthPreflightCache` with the codex/gemini
// pre-flights, which are anchored there.

import { closeSync, openSync } from 'node:fs';
import { scrubOAuthFallbackEnv } from './secret-source/env.mjs';
import { requireWorkerReplyContext } from './remediation-reply-paths.mjs';
import { spawnDetachedCli } from './adapters/reviewer-runtime/cli-direct/process.mjs';

// Behavior-preserving private copies of the PATH primitives. The canonical
// DEFAULT_PATH_PREFIX / buildInheritedPath live in follow-up-remediation.mjs
// (shared with the codex/gemini startup-env paths, which stay in the
// monolith). Copied verbatim here so this leaf stays acyclic.
const DEFAULT_PATH_PREFIX = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

function buildInheritedPath(currentPath = process.env.PATH || '') {
  const segments = [...DEFAULT_PATH_PREFIX, ...String(currentPath).split(':').filter(Boolean)];
  return [...new Set(segments)].join(':');
}

function resolveClaudeCodeCliPath() {
  return process.env.CLAUDE_CODE_CLI_PATH || process.env.CLAUDE_CLI || 'claude';
}

function prepareClaudeCodeRemediationStartupEnv() {
  // Strip provider API credentials before spawning so the worker can't
  // silently route through a metered API key when its OAuth state is
  // expected to be the billing path. Mirror of the worker-pool's
  // claude-code adapter ENV_CLEAR list, applied as JS-side env hygiene
  // (since this spawn doesn't go through that adapter).
  const { env, stripped } = scrubOAuthFallbackEnv(process.env);
  // ANTHROPIC_AUTH_TOKEN, when set, can be the OAuth bearer the worker
  // is supposed to use. NOT stripped — see worker-pool/lib/adapters/
  // claude-code.sh for the same rationale.
  env.PATH = buildInheritedPath(env.PATH || '');

  const startupEvidence = {
    stage: 'pre-side-effect-gate',
    requestedContract: {
      authMode: 'local-oauth',
      forbiddenFallbacks: ['api-key', 'anthropic-api-key', 'bedrock', 'vertex'],
    },
    resolvedStartup: {
      resolvedAuthMode: 'local-oauth',
      strippedEnv: stripped,
      preservedForOAuth: env.ANTHROPIC_AUTH_TOKEN ? ['ANTHROPIC_AUTH_TOKEN'] : [],
    },
    policyViolations: [],
  };

  return { env, startupEvidence };
}

function spawnClaudeCodeRemediationWorker({
  workspaceDir,
  promptPath,
  outputPath,
  logPath,
  replyPath = null,
  hqRoot,
  launchRequestId,
  jobId = null,
  workerClass = 'claude-code-remediation',
  spawnImpl,
  now = () => new Date().toISOString(),
}) {
  const claudeCli = resolveClaudeCodeCliPath();
  const { env: baseEnv, startupEvidence } = prepareClaudeCodeRemediationStartupEnv();
  const replyContext = requireWorkerReplyContext({ replyPath, hqRoot, launchRequestId });

  // Same worker-provenance env as the Codex spawn. The commit-msg hook
  // installed in the workspace reads these and stamps trailers.
  const env = {
    ...baseEnv,
    WORKER_CLASS: workerClass,
    WORKER_RUN_AT: now(),
    ADV_REPLY_DIR: replyContext.replyDir,
    REMEDIATION_REPLY_PATH: replyContext.replyPath,
  };
  if (replyContext.hqRoot) env.HQ_ROOT = replyContext.hqRoot;
  else delete env.HQ_ROOT;
  if (replyContext.launchRequestId) env.LRQ_ID = replyContext.launchRequestId;
  else delete env.LRQ_ID;
  delete env.WORKER_JOB_ID;
  if (jobId) env.WORKER_JOB_ID = jobId;
  else delete env.WORKER_JOB_ID;

  // Claude Code in --print mode reads the prompt from stdin and writes the
  // final assistant message to stdout. We capture stdout directly to
  // outputPath (the equivalent of codex's --output-last-message), and
  // route stderr to the worker log.
  //
  // --dangerously-skip-permissions is required for unattended remediation:
  // `--permission-mode acceptEdits` auto-approves *file edits* but still
  // gates shell commands (git add / commit / push, test runners, etc.) on
  // an interactive permission prompt. In --print mode there is no human
  // to answer, so without this flag the worker can edit but cannot
  // actually commit or push the remediation. Codex's matching flag is
  // --dangerously-bypass-approvals-and-sandbox, used in the parallel
  // spawnCodexRemediationWorker call. The per-job workspace is itself
  // the sandbox boundary — nothing in it can leak into the operator's
  // primary checkout.
  const promptFd = openSync(promptPath, 'r');
  const stdoutFd = openSync(outputPath, 'w');
  const stderrFd = openSync(logPath, 'a');

  try {
    const child = spawnDetachedCli(
      claudeCli,
      ['--print', '--permission-mode', 'acceptEdits', '--dangerously-skip-permissions'],
      {
        cwd: workspaceDir,
        env,
        stdio: [promptFd, stdoutFd, stderrFd],
        spawnImpl,
        now,
      }
    );

    return {
      model: 'claude-code',
      processId: child.pid,
      processGroupId: child.pid,
      spawnedAt: child.spawnedAt || now(),
      workspaceDir,
      promptPath,
      outputPath,
      logPath,
      startupEvidence,
      command: [claudeCli, '--print', '--permission-mode', 'acceptEdits', '--dangerously-skip-permissions'],
    };
  } finally {
    closeSync(promptFd);
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
}

export {
  resolveClaudeCodeCliPath,
  prepareClaudeCodeRemediationStartupEnv,
  spawnClaudeCodeRemediationWorker,
};

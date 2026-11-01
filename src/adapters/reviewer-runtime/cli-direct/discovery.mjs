import { resolveReviewCliPathAsync } from '../../../review-cli-resolver.mjs';
import { prepareServiceCodexHome } from '../../../codex-service-home.mjs';
import { ensureWorkerRegistryReady, resolveRemediationModel } from '../../agent-runtime/local/remediation.mjs';
import { loadAwareTimeoutMs } from '../../../load-aware-timeout.mjs';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

class CliDirectPreflightError extends Error {
  constructor(message, {
    failureClass = 'oauth-broken',
    layer = null,
    command = null,
    cause = null,
    stdout = '',
    stderr = '',
  } = {}) {
    super(message);
    this.name = 'CliDirectPreflightError';
    this.failureClass = failureClass;
    this.layer = layer;
    this.command = command;
    this.cause = cause;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

async function resolveCliBinary({ binaryName, env = process.env } = {}) {
  try {
    return await resolveReviewCliPathAsync(binaryName, env);
  } catch (cause) {
    throw new CliDirectPreflightError(cause.message, {
      layer: `${binaryName}-path`, cause,
    });
  }
}

async function resolveGeminiCliBinary({ env = process.env } = {}) {
  return resolveCliBinary({ binaryName: 'gemini', env });
}

function resolveGeminiOAuthCredsPath(env = process.env) {
  if (env?.GEMINI_OAUTH_CREDS_PATH) return env.GEMINI_OAUTH_CREDS_PATH;
  const geminiHome = env?.GEMINI_HOME || join(env?.HOME || homedir(), '.gemini');
  return join(geminiHome, 'oauth_creds.json');
}

async function assertGeminiOAuthReadable(env = process.env) {
  const credsPath = resolveGeminiOAuthCredsPath(env);
  let raw;
  try {
    await access(credsPath, constants.R_OK);
    raw = await readFile(credsPath, 'utf8');
  } catch (err) {
    throw new CliDirectPreflightError(
      `Gemini OAuth credentials unavailable at ${credsPath}: ${err.message}`,
      { layer: 'gemini-oauth', command: `read ${credsPath}`, cause: err },
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CliDirectPreflightError(
      `Gemini OAuth credentials are invalid JSON at ${credsPath}: ${err.message}`,
      { layer: 'gemini-oauth', command: `parse ${credsPath}`, cause: err },
    );
  }
  if (!parsed?.access_token) {
    throw new CliDirectPreflightError(
      `Gemini OAuth credentials at ${credsPath} do not contain access_token`,
      { layer: 'gemini-oauth', command: `parse ${credsPath}` },
    );
  }
  return credsPath;
}

function formatProbeFailure({ label, command, args, err }) {
  const detail = [
    err?.message || '',
    err?.stdout ? `stdout: ${err.stdout}` : '',
    err?.stderr ? `stderr: ${err.stderr}` : '',
  ].filter(Boolean).join('\n').trim();
  return `${label} failed (${[command, ...args].join(' ')}): ${detail || 'unknown error'}`;
}

async function runProbe(command, args, {
  env = process.env,
  cwd = process.cwd(),
  timeout = loadAwareTimeoutMs(30_000),
  execFileImpl = execFileAsync,
  layer,
  label,
} = {}) {
  try {
    return await execFileImpl(command, args, {
      env,
      cwd,
      timeout,
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    throw new CliDirectPreflightError(
      formatProbeFailure({ label, command, args, err }),
      {
        layer,
        command: [command, ...args].join(' '),
        cause: err,
        stdout: err?.stdout || '',
        stderr: err?.stderr || '',
      },
    );
  }
}

async function probeClaudeCli({
  env = process.env,
  cwd = process.cwd(),
  timeout = loadAwareTimeoutMs(30_000),
  execFileImpl = execFileAsync,
} = {}) {
  const claudeCli = await resolveCliBinary({ binaryName: 'claude', envVar: 'CLAUDE_CLI', env });
  await runProbe(claudeCli, ['--version'], {
    env,
    cwd,
    timeout,
    execFileImpl,
    layer: 'claude-cli',
    label: 'Claude CLI OAuth/preflight probe',
  });
  return { claudeCli };
}

function codexCliAuthFallbackAllowed(err) {
  const text = `${err?.message || ''}\n${err?.stdout || ''}\n${err?.stderr || ''}`.toLowerCase();
  return /unexpected argument 'list'|unrecognized subcommand|invalid subcommand|usage: codex/.test(text);
}

function validateCodexMcpListOutput(stdout = '', stderr = '') {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  if (/oauth.*(expired|invalid|failed)|not logged in|login required|unauthorized/.test(text)) {
    throw new CliDirectPreflightError(
      `Codex MCP-server OAuth state is broken: ${String(stdout || stderr).trim()}`,
      { layer: 'codex-mcp-oauth', command: 'codex mcp list' },
    );
  }
}

async function probeCodexCli({
  env = process.env,
  cwd = process.cwd(),
  timeout = loadAwareTimeoutMs(30_000),
  execFileImpl = execFileAsync,
  requireMcpOAuth = false,
  execFileSyncImpl,
  ensureWorkerRegistryReadyImpl = ensureWorkerRegistryReady,
} = {}) {
  const codexCli = await resolveCliBinary({ binaryName: 'codex', envVar: 'CODEX_CLI', env });
  await ensureWorkerRegistryReadyImpl({ env });
  const model = resolveRemediationModel('codex-reviewer', { env });
  // Preserve the base home's OAuth lookup before redirecting config/session state.
  const authPath = env.CODEX_AUTH_PATH || join(env.CODEX_HOME || join(env.HOME || homedir(), '.codex'), 'auth.json');
  const home = prepareServiceCodexHome({ env: { ...env, CODEX_AUTH_PATH: authPath }, workspaceDir: cwd,
    model: model.resolvedModel, effort: model.resolvedReasoningLevel, codexCli, execFileSyncImpl });
  env = home.env;
  const probe = (command, args, options) => {
    console.info(`[codex-service] CODEX_HOME=${home.codexHome} config_sha256=${home.configDigest} model_catalog_json=${home.catalogPath || 'server'} probe=${args.join(' ')}`);
    return runProbe(command, args, options);
  };
  try {
    await probe(codexCli, ['--version'], {
      env,
      cwd,
      timeout,
      execFileImpl,
      layer: 'codex-cli-version',
      label: 'Codex CLI version probe',
    });

    try {
      await probe(codexCli, ['sessions', 'list'], {
        env,
        cwd,
        timeout,
        execFileImpl,
        layer: 'codex-cli-oauth',
        label: 'Codex CLI OAuth session probe',
      });
    } catch (err) {
      if (!codexCliAuthFallbackAllowed(err)) throw err;
      await probe(codexCli, ['login', 'status'], {
        env,
        cwd,
        timeout,
        execFileImpl,
        layer: 'codex-cli-oauth',
        label: 'Codex CLI OAuth login-status probe',
      });
    }

    if (requireMcpOAuth) {
      const mcpList = await probe(codexCli, ['mcp', 'list'], {
        env,
        cwd,
        timeout,
        execFileImpl,
        layer: 'codex-mcp-oauth',
        label: 'Codex MCP-server OAuth probe',
      });
      validateCodexMcpListOutput(mcpList?.stdout || '', mcpList?.stderr || '');
    }
    return { codexCli };
  } finally {
    home.cleanup();
  }
}

async function probeGeminiCli({
  env = process.env,
  cwd = process.cwd(),
  timeout = loadAwareTimeoutMs(30_000),
  execFileImpl = execFileAsync,
} = {}) {
  const geminiCli = await resolveGeminiCliBinary({ env });
  await runProbe(geminiCli, ['--version'], {
    env,
    cwd,
    timeout,
    execFileImpl,
    layer: 'gemini-cli-version',
    label: 'Gemini CLI version probe',
  });
  const geminiOAuthCredsPath = await assertGeminiOAuthReadable(env);
  return { geminiCli, geminiOAuthCredsPath };
}

async function probeReviewerCliOAuth({
  model,
  env = process.env,
  cwd = process.cwd(),
  timeout = loadAwareTimeoutMs(30_000),
  execFileImpl = execFileAsync,
  requireMcpOAuth = false,
} = {}) {
  const normalized = String(model || '').toLowerCase();
  if (normalized.includes('codex')) {
    return probeCodexCli({ env, cwd, timeout, execFileImpl, requireMcpOAuth });
  }
  if (normalized.includes('gemini')) {
    return probeGeminiCli({ env, cwd, timeout, execFileImpl });
  }
  return probeClaudeCli({ env, cwd, timeout, execFileImpl });
}

export {
  CliDirectPreflightError,
  probeClaudeCli,
  probeCodexCli,
  probeGeminiCli,
  probeReviewerCliOAuth,
  resolveCliBinary,
  resolveGeminiOAuthCredsPath,
  validateCodexMcpListOutput,
};

import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

const INSTALL_HINTS = Object.freeze({
  claude: 'Install Claude Code CLI: https://docs.anthropic.com/en/docs/claude-code/setup',
  codex: 'Install Codex CLI: https://developers.openai.com/codex/cli',
});

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

async function isExecutable(candidate) {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(binaryName, pathValue = process.env.PATH || '') {
  for (const dir of String(pathValue || '').split(':').filter(Boolean)) {
    const candidate = join(dir, binaryName);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

async function resolveCliBinary({
  binaryName,
  envVar,
  env = process.env,
} = {}) {
  const override = String(env?.[envVar] || '').trim();
  if (override) return override;
  const fromPath = await findOnPath(binaryName, env?.PATH || '');
  if (fromPath) return fromPath;
  throw new CliDirectPreflightError(
    `${binaryName} CLI not found. Set ${envVar} to the CLI path or put ${binaryName} on PATH. ${INSTALL_HINTS[binaryName] || ''}`.trim(),
    { layer: `${binaryName}-path`, command: `which ${binaryName}` },
  );
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
  timeout = 30_000,
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
  timeout = 30_000,
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
  timeout = 30_000,
  execFileImpl = execFileAsync,
} = {}) {
  const codexCli = await resolveCliBinary({ binaryName: 'codex', envVar: 'CODEX_CLI', env });
  await runProbe(codexCli, ['--version'], {
    env,
    cwd,
    timeout,
    execFileImpl,
    layer: 'codex-cli-version',
    label: 'Codex CLI version probe',
  });

  try {
    await runProbe(codexCli, ['sessions', 'list'], {
      env,
      cwd,
      timeout,
      execFileImpl,
      layer: 'codex-cli-oauth',
      label: 'Codex CLI OAuth session probe',
    });
  } catch (err) {
    if (!codexCliAuthFallbackAllowed(err)) throw err;
    await runProbe(codexCli, ['login', 'status'], {
      env,
      cwd,
      timeout,
      execFileImpl,
      layer: 'codex-cli-oauth',
      label: 'Codex CLI OAuth login-status probe',
    });
  }

  const mcpList = await runProbe(codexCli, ['mcp', 'list'], {
    env,
    cwd,
    timeout,
    execFileImpl,
    layer: 'codex-mcp-oauth',
    label: 'Codex MCP-server OAuth probe',
  });
  validateCodexMcpListOutput(mcpList?.stdout || '', mcpList?.stderr || '');
  return { codexCli };
}

async function probeReviewerCliOAuth({
  model,
  env = process.env,
  cwd = process.cwd(),
  timeout = 30_000,
  execFileImpl = execFileAsync,
} = {}) {
  const normalized = String(model || '').toLowerCase();
  if (normalized.includes('codex')) {
    return probeCodexCli({ env, cwd, timeout, execFileImpl });
  }
  return probeClaudeCli({ env, cwd, timeout, execFileImpl });
}

export {
  CliDirectPreflightError,
  findOnPath,
  probeClaudeCli,
  probeCodexCli,
  probeReviewerCliOAuth,
  resolveCliBinary,
  validateCodexMcpListOutput,
};

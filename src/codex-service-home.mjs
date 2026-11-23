import { createHash, randomUUID } from 'node:crypto';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveHomePath } from './account-home.mjs';
import { basename, dirname, join, resolve } from 'node:path';
import { PER_WORKER_PLACEHOLDER_REFRESH_TOKEN } from './codex-per-worker-auth.mjs';
import { scrubOAuthFallbackEnv } from './secret-source/env.mjs';

const template = readFileSync(new URL('./codex-service-config.toml', import.meta.url), 'utf8');
const reviewerTemplate = `${template}\n[features.code_mode]\nenabled = true\n`;
const directTemplate = template.replace('[features]\n', '[features]\ncode_mode_only = false\nstandalone_web_search = false\n')
  + '\n[features.code_mode]\nenabled = false\n';

function directWebSearch(modelInfo) {
  const { tool_mode, supports_search_tool, use_responses_lite, web_search_tool_type, web_search_provider } = modelInfo;
  if ((tool_mode != null && !['direct', 'code_mode', 'code_mode_only'].includes(tool_mode))
    || (supports_search_tool !== undefined && typeof supports_search_tool !== 'boolean')
    || (use_responses_lite !== undefined && typeof use_responses_lite !== 'boolean')
    || (web_search_tool_type !== undefined && !['text', 'text_and_image'].includes(web_search_tool_type))
    || (web_search_provider != null && !['standalone', 'search_mcp'].includes(web_search_provider))) {
    throw new Error('unrecognized direct tool capabilities');
  }
  // Responses Lite selects the standalone web.run function even when the
  // standalone_web_search feature is off. Enable only the regular hosted
  // web_search shape, when the catalog explicitly describes that capability.
  return use_responses_lite === false && web_search_tool_type !== undefined
    && web_search_provider !== 'search_mcp'
    ? 'cached' : 'disabled';
}

function runServiceCodexCommandAsync(command, args, { stdio, ...options }) {
  return new Promise((resolve, reject) => {
    // execFile buffers both output streams; discard catalog stderr after
    // collection. Authentication errors and catalog warnings redact output.
    const child = execFile(command, args, options, (error, stdout, stderr) => {
      if (error) { reject(error); return; }
      resolve({ stdout, stderr: stdio?.[2] === 'ignore' ? '' : stderr });
    });
    // execFile cannot honour stdio: ignore. Deliver EOF explicitly so neither
    // finite probe can wait for interactive input.
    // Early process exit can close stdin before EOF is delivered. execFile's
    // callback owns the command result, including its exit error.
    child.stdin.on('error', () => {});
    child.stdin.end();
  });
}

function runServiceCodexCommand(command, args, options) {
  if (args[0] !== 'login') return execFileSync(command, args, options);
  const result = spawnSync(command, args, options);
  if (result.error) throw serviceLaunchError(result.error) || serviceAuthError();
  if (result.status !== 0) throw serviceAuthError();
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

// The reviewer already uses --ignore-user-config as part of its security
// envelope. Keep it, and apply this same reviewed template through CLI
// overrides as well, so that flag cannot suppress the service tooling pins.
export function serviceCodexConfigArgs() {
  let section = '';
  const args = [];
  for (const raw of reviewerTemplate.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) { section = line.slice(1, -1); continue; }
    const [key, ...value] = line.split('=');
    args.push('--config', `${section ? `${section}.` : ''}${key.trim()}=${value.join('=').trim()}`);
  }
  return args;
}

// Config and credential ownership are separate contracts. In particular an
// explicit broker/per-worker auth path must never select the config directory.
// CODEX_AUTH_PATH is an AR source-selection contract, not a Codex CLI setting.
// Present a private, non-refreshing snapshot at the CLI's supported auth.json
// boundary. Never link to or write back to the broker/per-worker source.
export function prepareServiceCodexHome({ env, workspaceDir, model, effort = null, codexCli,
  preserveToolCapabilities = false, execFileSyncImpl = runServiceCodexCommand, log = console }) {
  const steps = serviceCodexHomeSteps({ env, workspaceDir, model, effort, codexCli, preserveToolCapabilities, log });
  let step = steps.next();
  while (!step.done) {
    let result;
    try {
      const { command, args, options } = step.value;
      result = execFileSyncImpl(command, args, options);
    } catch (error) { step = steps.throw(error); continue; }
    step = steps.next(result);
  }
  return step.value;
}

// Readiness probes share the same credential staging, validation, catalog pins
// and cleanup as execution, while yielding the event loop during CLI commands.
export async function prepareServiceCodexHomeAsync({ execFileImpl = runServiceCodexCommandAsync, ...options }) {
  const steps = serviceCodexHomeSteps(options);
  let step = steps.next();
  while (!step.done) {
    let result;
    try {
      const { command, args, options } = step.value;
      const response = await execFileImpl(command, args, options);
      result = args[0] === 'login'
        ? `${response.stdout || ''}\n${response.stderr || ''}` : response.stdout;
    } catch (error) { step = steps.throw(error); continue; }
    step = steps.next(result);
  }
  return step.value;
}

function* serviceCodexHomeSteps({ env, workspaceDir, model, effort = null, codexCli,
  preserveToolCapabilities = false, log = console }) {
  if (!model) throw new Error('service Codex home requires a resolved model');
  const codexHome = mkdtempSync(join(tmpdir(), 'adversarial-codex-'));
  try {
    const codexAuthOwnerId = randomUUID();
    writeFileSync(join(codexHome, '.service-auth-owner'), codexAuthOwnerId, { mode: 0o600 });
    const authSourcePath = env.CODEX_AUTH_PATH || (env.CODEX_HOME
      ? join(env.CODEX_HOME, 'auth.json') : resolveHomePath(env, '.codex', 'auth.json'));
    const authPath = join(codexHome, 'auth.json');
    try {
      if (!authSourcePath) throw serviceAuthError();
      const source = JSON.parse(readFileSync(authSourcePath, 'utf8'));
      // The deployed CLI also accepts legacy token-bearing files with no
      // auth_mode. Normalize those to explicit ChatGPT auth; never reinterpret
      // an explicit API-key/other mode.
      if ((source.auth_mode != null && source.auth_mode !== 'chatgpt')
        || typeof source.tokens?.access_token !== 'string' || !source.tokens.access_token.trim()) {
        throw new Error('missing ChatGPT OAuth credential');
      }
      // Allowlist the OAuth shape: never carry an embedded API key or unrelated
      // source metadata into the service credential store.
      writeFileSync(authPath, JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          id_token: source.tokens.id_token,
          access_token: source.tokens.access_token,
          refresh_token: PER_WORKER_PLACEHOLDER_REFRESH_TOKEN,
          // Older/alternate stores keep the account id outside tokens.account_id.
          account_id: source.tokens.account_id ?? source.account_id ?? source.tokens.chatgpt_account_id,
        },
        last_refresh: new Date().toISOString(),
      }), { mode: 0o600 });
    } catch {
      throw serviceAuthError();
    }
    const modelConfig = `model = ${JSON.stringify(model)}\n`
      + (effort ? `model_reasoning_effort = ${JSON.stringify(effort)}\n` : '')
      + (preserveToolCapabilities ? reviewerTemplate : directTemplate)
      + `\n[projects.${JSON.stringify(resolve(workspaceDir))}]\ntrust_level = "trusted"\n`;
    let config = preserveToolCapabilities ? modelConfig : `web_search = "disabled"\n${modelConfig}`;
    writeFileSync(join(codexHome, 'config.toml'), config, { mode: 0o600 });
    const nextEnv = { ...scrubOAuthFallbackEnv(env).env, CODEX_HOME: codexHome,
      CODEX_AUTH_PATH: authPath };
    // Use the actual spawn binary and effective store before debug models (which
    // may contact the provider) or exec. Suppress all credential/parser output.
    try {
      const status = yield { command: codexCli, args: ['login', 'status'], options: {
        env: nextEnv, cwd: workspaceDir, encoding: 'utf8', timeout: 30_000,
        maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      } };
      // The default runner captures both stdout and stderr: deployed Codex
      // prints its successful status on stderr.
      if (!/Logged in using ChatGPT\b/i.test(status)) throw serviceAuthError();
    } catch (error) {
      throw serviceLaunchError(error) || serviceAuthError();
    }
    let catalogPath = null;
    let toolConfigArgs = [];
    let stage = 'fetch';
    try {
      // Fetch only through this spawn's binary, isolated config and staged auth.
      // Never read an interactive home's model cache or config.
      const raw = yield { command: codexCli, args: ['debug', 'models'], options: {
        env: nextEnv, cwd: workspaceDir, encoding: 'utf8', timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      } };
      stage = 'parse';
      const catalog = JSON.parse(raw);
      if (!Array.isArray(catalog?.models) || !catalog.models.every(entry => entry && typeof entry.slug === 'string')) {
        throw new Error('invalid model catalog');
      }
      const selected = catalog.models.filter(entry => entry.slug === model);
      if (!selected.length || (!preserveToolCapabilities && selected.length !== 1)) throw new Error('ambiguous model catalog');
      let webSearch;
      if (!preserveToolCapabilities) {
        stage = 'capabilities';
        webSearch = directWebSearch(selected[0]);
        // Keep the direct-tools catalog policy. The direct purpose also pins
        // both Code Mode flags off so metadata removal cannot enable Code Mode.
        for (const entry of catalog.models) {
          delete entry.tool_mode;
          delete entry.supports_search_tool;
        }
      }
      const candidate = join(codexHome, preserveToolCapabilities ? 'model-catalog.json' : 'model-catalog.direct-tools.json');
      stage = 'write-catalog';
      writeFileSync(candidate, `${JSON.stringify(catalog)}\n`, { mode: 0o600 });
      const catalogValue = JSON.stringify(candidate);
      const pinnedConfig = `model_catalog_json = ${catalogValue}\n${preserveToolCapabilities
        ? modelConfig : `web_search = "${webSearch}"\n${modelConfig}`}`;
      stage = 'pin-config';
      // Publish the config last and atomically: a failed pin must leave a
      // readable base config with no reference to an incomplete catalog.
      const configTemp = join(codexHome, 'config.toml.tmp');
      writeFileSync(configTemp, pinnedConfig, { mode: 0o600 });
      renameSync(configTemp, join(codexHome, 'config.toml'));
      config = pinnedConfig;
      catalogPath = candidate;
      if (!preserveToolCapabilities) {
        // CLI pins also outrank workspace config layers during exec.
        toolConfigArgs = ['--config', `model_catalog_json=${catalogValue}`, '--config', `web_search="${webSearch}"`,
          '--config', 'features.code_mode.enabled=false', '--config', 'features.code_mode_only=false',
          '--config', 'features.standalone_web_search=false'];
      }
    } catch {
      // Only stable stages are diagnostic. Subprocess output and exceptions
      // may contain provider details. The server catalog can force a tool mode.
      if (!preserveToolCapabilities) {
        const error = new Error(`Codex direct-tools catalog could not be pinned (stage=${stage})`);
        error.code = 'codex-direct-tools-catalog-unavailable';
        throw error;
      }
      log.warn?.(`[codex-service] model catalog not pinned; using server catalog stage=${stage}`);
    }
    const configDigest = createHash('sha256').update(config).digest('hex');
    log.info?.(`[codex-service] CODEX_HOME=${codexHome} config_sha256=${configDigest} model_catalog_json=${catalogPath || 'server'}`);
    return { env: nextEnv, codexHome, configDigest, catalogPath, toolConfigArgs, authSourcePath, authPath, codexAuthOwnerId,
      cleanupAuth: () => cleanupServiceCodexAuth({ codexHome, codexAuthOwnerId }),
      cleanup: () => rmSync(codexHome, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(codexHome, { recursive: true, force: true });
    throw error;
  }
}

// A persisted worker may be reconciled by a new daemon. Require the original
// service's ownership receipt; legacy jobs and another worker's home are no-ops.
export function cleanupServiceCodexAuth(worker = {}) {
  const codexHome = worker?.codexHome;
  const codexAuthOwnerId = worker?.codexAuthOwnerId;
  if (!codexHome || !codexAuthOwnerId) return false;
  try {
    const ownedHome = realpathSync(codexHome);
    if (!basename(ownedHome).startsWith('adversarial-codex-')
      || readFileSync(join(ownedHome, '.service-auth-owner'), 'utf8') !== codexAuthOwnerId) return false;
    rmSync(join(ownedHome, 'auth.json'), { force: true });
    return true;
  } catch { return false; }
}

function serviceAuthError() {
  const error = new Error('Codex service OAuth unavailable at effective CLI credential store (pre-side-effect)');
  error.name = 'OAuthError';
  error.isOAuthError = true;
  error.model = 'codex';
  error.failureClass = 'oauth-broken';
  return error;
}

function serviceLaunchError(cause) {
  if (!['ENOENT', 'EACCES'].includes(cause?.code)) return null;
  const error = new Error(`Codex service CLI could not launch (${cause.code})`);
  error.name = 'CodexLaunchError';
  error.code = cause.code;
  error.failureClass = 'infrastructure';
  return error;
}

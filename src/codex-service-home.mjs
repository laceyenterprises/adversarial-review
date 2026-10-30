import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const template = readFileSync(new URL('./codex-service-config.toml', import.meta.url), 'utf8');

// The reviewer already uses --ignore-user-config as part of its security
// envelope. Keep it, and apply this same reviewed template through CLI
// overrides as well, so that flag cannot suppress the service tooling pins.
export function serviceCodexConfigArgs() {
  let section = '';
  const args = [];
  for (const raw of template.split('\n')) {
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
// This function does not read, copy, or change any credentials or source config.
export function prepareServiceCodexHome({ env, workspaceDir, model, effort = null, codexCli,
  execFileSyncImpl = execFileSync, log = console }) {
  if (!model) throw new Error('service Codex home requires a resolved model');
  const codexHome = mkdtempSync(join(tmpdir(), 'adversarial-codex-'));
  try {
    let config = `model = ${JSON.stringify(model)}\n`
      + (effort ? `model_reasoning_effort = ${JSON.stringify(effort)}\n` : '')
      + template
      + `\n[projects.${JSON.stringify(resolve(workspaceDir))}]\ntrust_level = "trusted"\n`;
    writeFileSync(join(codexHome, 'config.toml'), config, { mode: 0o600 });
    const nextEnv = { ...env, CODEX_HOME: codexHome };
    let catalogPath = null;
    let stage = 'fetch';
    try {
      // Fetch only through this spawn's binary, isolated config and staged auth.
      // Never read an interactive home's model cache or config.
      const raw = execFileSyncImpl(codexCli, ['debug', 'models'], {
        env: nextEnv, cwd: workspaceDir, encoding: 'utf8', timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      });
      stage = 'parse';
      const catalog = JSON.parse(raw);
      if (!Array.isArray(catalog?.models) || !catalog.models.length
        || !catalog.models.every(entry => entry && typeof entry.slug === 'string')
        || !catalog.models.some(entry => entry.slug === model)) {
        throw new Error('catalog must contain model entries including the selected model');
      }
      for (const entry of catalog.models) {
        delete entry.tool_mode;
        // Omitted search support defaults to false. Preserve all other model
        // metadata, including experimental_supported_tools (direct MCP tools).
        delete entry.supports_search_tool;
      }
      const candidate = join(codexHome, 'model-catalog.direct-tools.json');
      stage = 'write-catalog';
      writeFileSync(candidate, `${JSON.stringify(catalog)}\n`, { mode: 0o600 });
      const pinnedConfig = `model_catalog_json = ${JSON.stringify(candidate)}\n${config}`;
      stage = 'pin-config';
      // Publish the config last and atomically: a failed pin must leave a
      // readable base config with no reference to an incomplete catalog.
      const configTemp = join(codexHome, 'config.toml.tmp');
      writeFileSync(configTemp, pinnedConfig, { mode: 0o600 });
      renameSync(configTemp, join(codexHome, 'config.toml'));
      config = pinnedConfig;
      catalogPath = candidate;
    } catch (error) {
      // Do not include CLI output: it may contain credential/provider details.
      log.warn?.(`[codex-service] direct-tools catalog not pinned; using server catalog stage=${stage} error=${error.code || error.name}`);
    }
    const configDigest = createHash('sha256').update(config).digest('hex');
    log.info?.(`[codex-service] CODEX_HOME=${codexHome} config_sha256=${configDigest} model_catalog_json=${catalogPath || 'server'}`);
    return { env: nextEnv, codexHome, configDigest, catalogPath,
      cleanup: () => rmSync(codexHome, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(codexHome, { recursive: true, force: true });
    throw error;
  }
}

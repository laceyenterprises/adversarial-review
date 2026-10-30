import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
export function prepareServiceCodexHome({ env, workspaceDir, model, effort = null, log = console }) {
  if (!model) throw new Error('service Codex home requires a resolved model');
  const codexHome = mkdtempSync(join(tmpdir(), 'adversarial-codex-'));
  try {
    const config = `model = ${JSON.stringify(model)}\n`
      + (effort ? `model_reasoning_effort = ${JSON.stringify(effort)}\n` : '')
      + template
      + `\n[projects.${JSON.stringify(resolve(workspaceDir))}]\ntrust_level = "trusted"\n`;
    writeFileSync(join(codexHome, 'config.toml'), config, { mode: 0o600 });
    const configDigest = createHash('sha256').update(config).digest('hex');
    const nextEnv = { ...env, CODEX_HOME: codexHome };
    log.info?.(`[codex-service] CODEX_HOME=${codexHome} config_sha256=${configDigest}`);
    return { env: nextEnv, codexHome, configDigest,
      cleanup: () => rmSync(codexHome, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(codexHome, { recursive: true, force: true });
    throw error;
  }
}

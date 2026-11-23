// ONS-07 — profile selection and layer-file reading for the cascade.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { AgentOSConfigError } from './config-base.mjs';
import { parseYaml } from './config-checks.mjs';

export function loadLayerFile(path) {
  if (!path || !existsSync(path)) return { doc: null, rawText: '' };
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new AgentOSConfigError(
      `could not read ${path}: ${err.message || err}`,
      { source: path },
    );
  }
  const doc = parseYaml(text, path);
  return { doc, rawText: text };
}

// Returns the Layer-4 sibling path for `path`, or null if `path` doesn't end
// in `.yaml`/`.yml`. Non-YAML extensions (e.g. operator points
// AGENT_OS_CONFIG_PATH at `/etc/agent-os/config` or `…/config.conf`) used to
// silently fall back to `${name}.local`, producing oddly-named siblings that
// the YAML parser would happily try to load. Refusing makes the rule legible:
// pick a `.yaml` / `.yml` path or the loader doesn't synthesize a sibling.
export function localSibling(path) {
  if (!path) return null;
  const dir = dirname(path);
  const name = basename(path);
  if (name.endsWith('.yaml')) {
    return join(dir, `${name.slice(0, -'.yaml'.length)}.local.yaml`);
  }
  if (name.endsWith('.yml')) {
    return join(dir, `${name.slice(0, -'.yml'.length)}.local.yml`);
  }
  return null;
}

// PROFILENODE-01: profile overlay. Mirrors the platform loaders' ANY-02
// contract. Resolution order: explicit `profile:` key, env AGENT_OS_PROFILE,
// `reference-host` when the overlay file exists next to the top file, else
// `core`. Only the `reference-host` profile has an overlay file.
export const PROFILE_ENV = 'AGENT_OS_PROFILE';

export const DEFAULT_PROFILE = 'core';

export const OVERLAY_PROFILE = 'reference-host';

// `<stem>.profile.<profile>.yaml` beside the top file (`config.yaml` ->
// `config.profile.reference-host.yaml`); null for non-YAML top paths, like
// localSibling.
export function profileOverlaySibling(path, profile = OVERLAY_PROFILE) {
  if (!path) return null;
  const dir = dirname(path);
  const name = basename(path);
  if (name.endsWith('.yaml')) {
    return join(dir, `${name.slice(0, -'.yaml'.length)}.profile.${profile}.yaml`);
  }
  if (name.endsWith('.yml')) {
    return join(dir, `${name.slice(0, -'.yml'.length)}.profile.${profile}.yml`);
  }
  return null;
}

export function nonBlankString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function resolveProfile({ explicit, env, overlayExists }) {
  const fromKey = nonBlankString(explicit);
  if (fromKey) return { profile: fromKey, source: 'explicit' };
  const fromEnv = nonBlankString(env?.[PROFILE_ENV]);
  if (fromEnv) return { profile: fromEnv, source: 'env' };
  if (overlayExists) return { profile: OVERLAY_PROFILE, source: 'overlay-present' };
  return { profile: DEFAULT_PROFILE, source: 'default' };
}

// -------- AgentOSConfig (public class) -------------------------------------

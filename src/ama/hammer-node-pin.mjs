import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { resolveDeployCheckout } from '../deploy-root.mjs';

export const NODE_PIN_UNAVAILABLE = 'node-pin-unavailable';

function readOptional(path) {
  try { return readFileSync(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function declaredPin(root) {
  const manifest = readOptional(join(root, 'runtime/node/manifest.json'));
  if (manifest !== null) return { range: semver.valid(JSON.parse(manifest)?.version), managed: true };
  const nvmrc = readOptional(join(root, '.nvmrc'));
  if (nvmrc !== null) {
    const version = nvmrc.split('#', 1)[0].trim();
    return { range: /^v?\d+(?:\.\d+){0,2}$/.test(version) ? semver.validRange(version) : null };
  }
  const pkg = readOptional(join(root, 'package.json'));
  if (pkg === null) return null;
  const range = semver.validRange(JSON.parse(pkg)?.engines?.node);
  return { range: range === '*' ? null : range };
}

function probe(command, args, env) {
  try {
    return execFileSync(command, args, { env, cwd: '/', encoding: 'utf8', timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

function managedNode(root, env) {
  // The target supplies version data only. Run the resolver from the trusted deployment.
  try {
    const deploy = resolveDeployCheckout(env, { sourceRoots: [fileURLToPath(new URL('../../', import.meta.url))] });
    if (!deploy) return '';
    const resolver = join(deploy, 'scripts/lib/resolve-node-runtime.sh');
    const target = realpathSync(root);
    const script = realpathSync(resolver);
    if (script === target || script.startsWith(target + sep)) return '';
    // Discover the managed installation independently of the launch's override.
    return probe('/bin/bash', [resolver], { ...env, AGENT_OS_NODE_BIN: '' });
  } catch { return ''; }
}

function matchingNode(candidates, range, env) {
  for (const node of new Set(candidates)) {
    if (!node || !isAbsolute(node) || basename(node) !== 'node') continue;
    const version = semver.valid(probe(node, ['--version'], env));
    if (version && semver.satisfies(version, range)) return { node, version };
  }
}

export function resolveValidationNode(root, env = process.env, execPath = process.execPath) {
  let pin;
  try { pin = declaredPin(root); }
  catch { return { reason: NODE_PIN_UNAVAILABLE, detail: 'cannot read the target Node declaration' }; }
  if (!pin && !/\/(?:agent-os|adversarial-review)$/.test(env.HAM_REPO || '')) return {};
  if (pin?.range) {
    const pathNodes = (env.PATH || '').split(delimiter).filter(isAbsolute).map(dir => join(dir, 'node'));
    const candidates = [env.HAM_NODE_BIN, execPath, env.AGENT_OS_NODE_BIN, ...pathNodes];
    if (pin.managed) candidates.unshift(managedNode(root, env));
    const match = matchingNode(candidates, pin.range, env)
      ?? (!pin.managed && matchingNode([managedNode(root, env)], pin.range, env));
    if (match) return match;
  }
  return { reason: NODE_PIN_UNAVAILABLE, detail: pin?.range
    ? `no installed Node matches ${pin.range}` : 'the target has no supported Node declaration' };
}

export function validationNodeEnvironment(env, node) {
  if (!node) return env;
  const bin = dirname(node);
  const path = (env.PATH || '').split(delimiter).filter(entry => entry && entry !== bin);
  return { ...env, HAM_NODE_BIN: node, PATH: [bin, ...path].join(delimiter) };
}

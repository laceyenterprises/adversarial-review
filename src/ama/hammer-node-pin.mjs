import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { resolveDeployCheckout } from '../deploy-root.mjs';
import { loadAwareTimeoutSeconds } from '../load-aware-timeout.mjs';
import { loadConfigCached } from '../config-loader.mjs';

export const NODE_PIN_UNAVAILABLE = 'node-pin-unavailable';
export const NODE_PIN_UNDECLARED = 'node-pin-undeclared';
// Dedicated validator statuses preserve classification without a writable receipt.
export const NODE_PIN_UNAVAILABLE_EXIT = 80;
export const NODE_PIN_UNDECLARED_EXIT = 81;

export function strictNodePinRepository(env = process.env) {
  const owner = loadConfigCached({ env }).get('github.org').trim().toLowerCase();
  return new Set([`${owner}/agent-os`, `${owner}/adversarial-review`])
    .has((env.HAM_REPO || '').trim().toLowerCase());
}

function readOptional(path) {
  try { return readFileSync(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function declaredPin(root) {
  const manifest = readOptional(join(root, 'runtime/node/manifest.json'));
  if (manifest !== null) {
    const range = semver.valid(JSON.parse(manifest)?.version);
    if (range) return range;
  }
  const nvmrc = readOptional(join(root, '.nvmrc'));
  if (nvmrc !== null) {
    const version = nvmrc.split('#', 1)[0].trim();
    const range = /^v?\d+(?:\.\d+){0,2}$/.test(version) && semver.validRange(version);
    if (range) return range;
  }
  const pkg = readOptional(join(root, 'package.json'));
  if (pkg === null) return null;
  const range = semver.validRange(JSON.parse(pkg)?.engines?.node);
  return range && range !== '*' ? range : null;
}

function probe(command, args, env) {
  try {
    return execFileSync(command, args, { env, cwd: '/', encoding: 'utf8',
      timeout: loadAwareTimeoutSeconds(2) * 1000,
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

function matchingNode(node, range, env) {
  if (!node || !isAbsolute(node) || basename(node) !== 'node') return;
  const version = semver.valid(probe(node, ['--version'], env));
  if (version && semver.satisfies(version, range)) return { node, version };
}

export function resolveValidationNode(root, env = process.env, execPath = process.execPath) {
  let range, strict;
  if (env.HAM_CONTROLLER_RECORD && !/^[\w.-]+\/[\w.-]+$/.test(env.HAM_REPO || '')) {
    return { reason: NODE_PIN_UNAVAILABLE, detail: 'controller validation requires HAM_REPO owner/name' };
  }
  try { strict = strictNodePinRepository(env); }
  catch { return { reason: NODE_PIN_UNAVAILABLE, detail: 'cannot read the strict repository configuration' }; }
  const failure = (reason, detail) => strict ? { reason, detail }
    : { warning: `${reason}: ${detail}; using the service runtime for an unrelated repository` };
  try { range = declaredPin(root); }
  catch (error) { return failure(error instanceof SyntaxError ? NODE_PIN_UNDECLARED : NODE_PIN_UNAVAILABLE,
    'cannot read the target Node declaration'); }
  if (!range && !strict) return {};
  if (!range) return { reason: NODE_PIN_UNDECLARED, detail: 'the target has no supported Node declaration' };
  const candidates = new Set([env.HAM_NODE_BIN, execPath, env.AGENT_OS_NODE_BIN]);
  for (const node of candidates) {
    const match = matchingNode(node, range, env);
    if (match) return match;
  }
  const managed = managedNode(root, env);
  const match = candidates.has(managed) ? undefined : matchingNode(managed, range, env);
  if (match) return match;
  return { ...failure(NODE_PIN_UNAVAILABLE, `no installed Node matches ${range}`), runtimeUnavailable: true };
}

export function validationNodeEnvironment(env, node, scratch) {
  if (!node) return env;
  const bin = join(scratch, 'node-bin');
  mkdirSync(bin, { mode: 0o700 });
  symlinkSync(node, join(bin, 'node'));
  return { ...env, HAM_NODE_BIN: node, PATH: [bin, env.PATH || ''].filter(Boolean).join(delimiter) };
}

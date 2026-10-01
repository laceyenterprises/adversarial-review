import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolveGitHubAdapterBin, buildAdapterEnv } from './github-adapter-client.mjs';

// Explicit registered service identity. Never fall back to gh's ambient token
// or keychain when the adapter/broker cannot be reached.
export function readPipelineGithub(kind, repo, prNumber, {
  env = process.env, rootDir, execFileSyncImpl = execFileSync,
} = {}) {
  const bin = resolveGitHubAdapterBin({ env, rootDir });
  if (!bin) throw new Error('github-adapter-unavailable');
  const role = String(env.WATCHER_GH_BROKER_ROLE || 'merge-agent');
  if (!/^[a-z][a-z0-9-]*$/.test(role)) throw new Error('github-adapter-identity-invalid');
  const prefix = `OAUTH_BROKER_${role.toUpperCase().replaceAll('-', '_')}`;
  const appId = env[`${prefix}_EXPECTED_APP_ID`];
  const installationId = env[`${prefix}_EXPECTED_INSTALLATION_ID`];
  if (!/^\d+$/.test(String(appId || '')) || !/^\d+$/.test(String(installationId || ''))) {
    throw new Error('github-adapter-identity-unconfigured');
  }
  const childEnv = buildAdapterEnv(env);
  for (const key of Object.keys(childEnv)) {
    if (key === 'GH_TOKEN' || key === 'GITHUB_TOKEN' || /^GH_.*_TOKEN$/.test(key)) delete childEnv[key];
  }
  const args = [fileURLToPath(new URL('./adapters/health/github-read.py', import.meta.url)),
    '--adapter-bin', bin, '--kind', kind, '--repo', repo,
    '--role', role, '--provider', env[`${prefix}_PROVIDER`] || `github-app-${role}`,
    '--app-id', String(appId), '--installation-id', String(installationId)];
  if (prNumber !== null) args.push('--number', String(prNumber));
  const python = env.HQ_PYTHON3 || (process.platform === 'darwin' ? 'python3.13' : 'python3');
  try {
    const output = execFileSyncImpl(python, args, {
      encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], env: childEnv,
    });
    const parsed = JSON.parse(output);
    if (kind === 'state') {
      if (!parsed || !['OPEN', 'CLOSED', 'MERGED'].includes(parsed.state)) throw new Error('invalid-state');
    } else {
      if (!Array.isArray(parsed)) throw new Error('invalid-list');
      if (kind === 'list' && (parsed.length >= 100 || parsed.some((row) => (
        !Number.isInteger(row?.number) || row.number <= 0 || typeof row.isDraft !== 'boolean'
        || !['MERGEABLE', 'CONFLICTING', 'UNKNOWN'].includes(row.mergeable)
        || (row.isDraft === false && row.mergeable === 'UNKNOWN')
      )))) throw new Error('incomplete-list');
    }
    if (kind === 'checks' && parsed.some((row) => (
      typeof row?.name !== 'string' || typeof row.state !== 'string' || typeof row.bucket !== 'string'
    ))) throw new Error('invalid-checks');
    return parsed;
  } catch {
    throw new Error('github-adapter-read-inconclusive');
  }
}

export function listPipelineOpenPrs(repo, options) {
  return readPipelineGithub('list', repo, null, options);
}

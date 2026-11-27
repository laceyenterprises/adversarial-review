import { fetchReviewerTokenFromBroker } from '../../src/reviewer-broker-refresh.mjs';
import assert from 'node:assert/strict';

export const fixtureAdapterBin = '/fixture/github-adapter';

// Exercise refresh scheduling through the CLI seam. The adapter's own suite
// covers broker HTTP behavior and verification of identity metadata.
export function tokenFixture(respond) {
  return async (bin, args, options) => {
    assert.ok(Number.isFinite(options.timeout) && options.timeout > 0, 'token subprocess must be bounded');
    assert.equal(bin, fixtureAdapterBin);
    assert.deepEqual(args.slice(0, 2), ['token', '--role']);
    assert.ok(['--repo', '--owner'].includes(args[3]));
    assert.ok(args[4]);
    assert.equal(options.env.GH_TOKEN, undefined);
    assert.equal(options.env.GITHUB_TOKEN, undefined);
    const response = await respond({ role: args[2], repo: args[3] === '--repo' ? args[4] : null,
      owner: args[3] === '--owner' ? args[4] : null, force: args.includes('--force'), ...options });
    return { stdout: JSON.stringify({ ok: true, ...response }) };
  };
}

export function legacyTokenFixture(fetchImpl) {
  return tokenFixture(async ({ role, repo, owner, force, env }) => {
    const url = new URL('/token', env.OAUTH_BROKER_URL || 'http://127.0.0.1:4099');
    url.searchParams.set('provider', `github-app-${role}`);
    if (force) url.searchParams.set('force', '1');
    if (repo) url.searchParams.set('repo', repo);
    else if (owner) url.searchParams.set('owner', owner);
    const response = await fetchImpl(url.toString(), { headers: { Authorization: 'Bearer fixture-broker-secret' } });
    if (!response.ok) throw Object.assign(new Error(`fixture adapter refused token (HTTP ${response.status})`), { code: response.status >= 500 ? 75 : 1 });
    return { provider: `github-app-${role}`, ...await response.json() };
  });
}

export function legacyMint(fetchImpl) {
  return options => fetchReviewerTokenFromBroker({ ...options,
    owner: options.repo ? options.owner : options.owner || 'fixture-org',
    env: { ...options.env, GHA_ADAPTER_BIN: fixtureAdapterBin },
    execFileImpl: legacyTokenFixture(fetchImpl),
  });
}

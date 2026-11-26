import assert from 'node:assert/strict';

export const fixtureAdapterBin = '/fixture/github-adapter';

// Exercise refresh scheduling through the CLI seam. The adapter's own suite
// covers broker HTTP behavior and verification of identity metadata.
export function tokenFixture(respond) {
  return async (bin, args, options) => {
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
    return response.json();
  });
}

export function legacyMint(fetchImpl) {
  return async ({ role, repo, owner, force, env }) => {
    const args = ['token', '--role', role, ...(repo ? ['--repo', repo] : ['--owner', owner || 'fixture-org']),
      ...(force ? ['--force'] : [])];
    const { stdout } = await legacyTokenFixture(fetchImpl)(fixtureAdapterBin, args, { env: {
      OAUTH_BROKER_URL: env?.OAUTH_BROKER_URL, OAUTH_BROKER_URL_FALLBACK: env?.OAUTH_BROKER_URL_FALLBACK,
    } });
    const response = JSON.parse(stdout);
    const expiry = Date.parse(response.expires_at);
    return { token: response.access_token, provider: response.provider, expiresAtMs: Number.isFinite(expiry) ? expiry : null };
  };
}

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('runner uses no-org configuration without an inherited routing preload', () => {
  assert.equal(JSON.parse(readFileSync(new URL('../config.json', import.meta.url))).org, undefined);
  assert.ok(!String(process.env.NODE_OPTIONS).includes('github-owner-routing-off-fixture'));
  const moduleUrl = new URL('../src/github-owner-token.mjs', import.meta.url).href;
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const child = spawnSync(process.execPath, ['--preserve-symlinks', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { githubOwnerTokens, createGithubOwnerTokenSelector } from ${JSON.stringify(moduleUrl)};
    assert.equal(githubOwnerTokens.routedOwner('other-org/x'), null);
    const selector = createGithubOwnerTokenSelector({ readHomeOwner: () => 'home-org',
      mint: async () => ({ token: 'routed-fixture' }) });
    assert.equal(await selector.select({ token: 'home', role: 'merge-agent', target: 'other-org/x' }), 'routed-fixture');
    console.log('fixture configuration and explicit routing both work');
  `], { env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /fixture configuration and explicit routing both work/);
});

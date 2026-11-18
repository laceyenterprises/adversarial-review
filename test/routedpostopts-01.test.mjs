import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createGithubOwnerTokenSelector, githubOwnerTokens, recordGithubToken } from '../src/github-owner-token.mjs';
import { meteredExecFile, meteredExecFileSync } from '../src/metered-gh.mjs';
import { postExactHeadReview } from '../src/reviewer-exact-head-post.mjs';
import { spawnCapturedProcessGroup } from '../src/process-group-spawn.mjs';

// ROUTEDPOSTOPTS-01: the real spawner validator, not a fake exec, must be on
// the path of an owner-routed post. Synthetic owners, tokens and repos only.
const head = 'a'.repeat(40);

function install() {
  const selector = createGithubOwnerTokenSelector({ readHomeOwner: () => 'home-org',
    mint: async ({ role, owner }) => ({ token: `${role}@${owner}-routed`, expiresAtMs: Date.now() + 3600_000 }) });
  Object.assign(githubOwnerTokens, selector);
}

// A stand-in `gh` that records the token it was handed and answers like GitHub.
function fakeGh(t) {
  const dir = mkdtempSync(path.join(process.env.ADVERSARIAL_REVIEW_TEST_TEMP_BASE || tmpdir(), 'routedpostopts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seen = path.join(dir, 'seen-token');
  writeFileSync(path.join(dir, 'gh'), `#!/bin/sh\ncat >/dev/null\nprintf '%s' "$GH_TOKEN" > '${seen}'\nprintf '{"id":1,"commit_id":"${head}"}'\n`);
  chmodSync(path.join(dir, 'gh'), 0o755);
  const env = () => {
    recordGithubToken('home-service', { role: 'merge-agent', owner: null });
    return { PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: 'home-service', GITHUB_TOKEN: 'home-service',
      GHO_API_CALL_LOG_DISABLE: '1', GHO_RATE_LIMIT_SHARED_STATE_PATH: process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH };
  };
  return { env, token: () => readFileSync(seen, 'utf8') };
}

// The real validator, observing what the layer under test hands it.
function recordingSpawner(optionSets) {
  return (command, args, options) => { optionSets.push(options); return spawnCapturedProcessGroup(command, args, options); };
}

for (const [label, repo, expectedToken] of [
  ['owner-routed repo posts through the routed credential', 'other-org/x', 'merge-agent@other-org-routed'],
  ['default-owner repo posts through the home credential', 'home-org/x', 'home-service'],
]) {
  test(`real spawner validator: ${label}`, async (t) => {
    install();
    const gh = fakeGh(t), optionSets = [];
    const result = await postExactHeadReview({ execFileImpl: recordingSpawner(optionSets), repo, prNumber: 1,
      reviewerHeadSha: head, reviewBody: 'Synthetic review', env: gh.env() });
    assert.match(result.stdout, /"commit_id"/);
    assert.equal(gh.token(), expectedToken);
    assert.equal(optionSets.length, 1);
    assert.equal('credentialEnv' in optionSets[0], false, 'the spawner never receives a credential map');
  });
}

test('async and sync routed exec hand the executor no credentialEnv but keep the routed token', async () => {
  install();
  const env = { GH_TOKEN: 'home-service', GITHUB_TOKEN: 'home-service', GHO_API_CALL_LOG_DISABLE: '1',
    GHO_RATE_LIMIT_SHARED_STATE_PATH: process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH };
  recordGithubToken('home-service', { role: 'merge-agent', owner: null });
  const seen = [];
  const exec = async (_command, _args, options) => { seen.push(options); return { stdout: '{}', stderr: '' }; };
  await meteredExecFile(exec, 'gh', ['api', 'repos/other-org/x/pulls/1'], { env });
  // The synchronous selector reads the cache the async call just filled.
  meteredExecFileSync((_command, _args, options) => { seen.push(options); return { stdout: '{}', stderr: '' }; },
    'gh', ['api', 'repos/other-org/x/pulls/1'], { env });
  assert.equal(seen.length, 2);
  for (const options of seen) {
    assert.equal('credentialEnv' in options, false);
    assert.equal(options.env.GH_TOKEN, 'merge-agent@other-org-routed');
  }
});

test('an unknown spawner option still throws', () => {
  assert.throws(() => spawnCapturedProcessGroup(process.execPath, ['-e', ''], { credentialEnv: {} }),
    { name: 'TypeError', message: /Unsupported spawnCapturedProcessGroup options: credentialEnv/ });
  assert.throws(() => spawnCapturedProcessGroup(process.execPath, ['-e', ''], { notAnOption: true }),
    /Unsupported spawnCapturedProcessGroup options: notAnOption/);
});

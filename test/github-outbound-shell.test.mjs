import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const expected = { 'bin/hammer-publish.sh': 3, 'bin/hammer-verify-head.sh': 2, 'bin/hammer-merge.sh': 1, 'templates/hammer-prompt.md': 1 };
test('shell and hammer prompt body writes route through the shared filter bridge', () => {
  const actual = {};
  for (const folder of ['bin', 'templates']) {
    for (const name of readdirSync(join(root, folder))) {
      if (!/\.(?:sh|md)$/.test(name)) continue;
      const path = `${folder}/${name}`;
      const source = readFileSync(join(root, path), 'utf8');
      const writes = [...source.matchAll(/(?:--body(?:-file)?\s+|-f\s+body=)(?:"([^"\n]+)"|'([^'\n]+)'|([^\s\\]+))/g)];
      if (!writes.length) continue;
      actual[path] = writes.length;
      for (const match of writes) {
        assert.ok(!match[0].startsWith('--body-file'), `${path}: materialize and filter file body before posting`);
        const variable = (match[1] || match[2] || match[3]).match(/^\$([A-Z_]+)$/)?.[1];
        assert.ok(variable, `${path}: body must be a filtered variable`);
        if (variable === 'HAM_COMMIT_BODY') {
          assert.match(source, /bin\/merge-commit-body\.mjs/);
          assert.match(readFileSync(join(root, 'bin/merge-commit-body.mjs'), 'utf8'), /message\.text = filterGitHubBody\(/);
        } else {
          assert.match(source, new RegExp(`${variable}=\\$\\(printf[^]*?bin/github-outbound-body\\.mjs`), `${path}: ${variable} skips filter`);
        }
      }
    }
  }
  assert.deepEqual(actual, expected, 'new shell body write must join the shared filter');
});
test('stdin bridge and hammer merge-message output filter synthetic local paths', () => {
  const local = 'file:///Users/example/state/reviewer-snapshots/acme_widgets-0123456789ab/local-sha/src/example.mjs#L2';
  const repo = 'acme/widgets', head = 'a'.repeat(40);
  const expected = `[example](https://github.com/${repo}/blob/${head}/src/example.mjs#L2)`;
  const env = { ...process.env, ADVERSARIAL_REVIEW_STATE_DIR: '/Users/example/state', ADVERSARIAL_REVIEW_WORKSPACE_STATE_DIR: '/Users/example/state', HAM_AMA_TRAILERS: 'Closed-By: hammer', HAM_PR_TITLE: 'Synthetic change' };
  const bridge = spawnSync(process.execPath, [join(root, 'bin/github-outbound-body.mjs'), repo, head, '/home/example/state/service'], { env, input: `[example](${local}) /Users/example/state/jobs/x`, encoding: 'utf8', timeout: 5000 });
  assert.equal(bridge.status, 0, bridge.stderr);
  assert.equal(bridge.stdout, `${expected} <local>/jobs/x`);
  const merge = spawnSync(process.execPath, [join(root, 'bin/merge-commit-body.mjs'), repo, '1', head], { env, input: `[example](${local})`, encoding: 'utf8', timeout: 5000 });
  assert.equal(merge.status, 0, merge.stderr);
  assert.equal(JSON.parse(merge.stdout).text, `${expected}\n\nClosed-By: hammer`);
});

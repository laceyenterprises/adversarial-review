import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { neutralizeClosingKeywords } from '../src/ama/closing-keywords.mjs';

for (const keyword of ['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved']) {
  for (const gap of [' ', ': ', ':\n\n', '\n\n']) {
    test(`${keyword} with ${JSON.stringify(gap)}`, () => {
      const original = `${keyword.toUpperCase()}${gap}#7732`;
      const result = neutralizeClosingKeywords(original, { selfPrNumber: 7, repo: 'o/r' });
      assert.equal(result.text, `${keyword.toUpperCase()}${gap}PR #7732`);
      assert.deepEqual(result.rewrites.map(r => [r.original, r.referencedNumber]), [[original, 7732]]);
    });
  }
}
test('qualified references preserve only the actual self PR', () => {
  const result = neutralizeClosingKeywords('Fix o/r#7; closes other/repo#7; resolved o/r#8; fixes #7', { selfPrNumber: 7, repo: 'O/R' });
  assert.equal(result.text, 'Fix o/r#7; closes PR other/repo#7; resolved PR o/r#8; fixes #7');
  assert.equal(result.rewrites.length, 2);
});
test('ordinary text is unchanged and every adjacency is processed', () => {
  assert.deepEqual(neutralizeClosingKeywords('See #7732. prefix #8; disclosure #9'), { text: 'See #7732. prefix #8; disclosure #9', rewrites: [] });
  assert.equal(neutralizeClosingKeywords('Fix #1; fixes #2').rewrites.length, 2);
});
test('hammer CLI uses the same sanitizer and shell forwards its body and rewrite audit', () => {
  const result = spawnSync(process.execPath, ['bin/merge-commit-body.mjs', 'o/r', '7'], {
    input: 'Fix: #7732\ncloses #7', encoding: 'utf8', env: { ...process.env, HAM_AMA_TRAILERS: 'Closed-By: hammer' },
  });
  assert.equal(result.status, 0, result.stderr);
  const doc = JSON.parse(result.stdout);
  assert.equal(doc.text, 'Fix: PR #7732\ncloses #7\n\nClosed-By: hammer');
  assert.equal(doc.rewrites[0].referencedNumber, 7732);
  const source = readFileSync('bin/hammer-merge.sh', 'utf8');
  assert.match(source, /--body "\$HAM_COMMIT_BODY"/);
  assert.match(source, /closingKeywordRewrites: \$closingKeywordRewrites/);
});

test('hammer shell merge runner receives the neutralized body', () => {
  const source = readFileSync('bin/hammer-merge.sh', 'utf8');
  const snippet = source.slice(source.indexOf('  HAM_COMMIT_BODY_JSON='), source.indexOf('  HAM_MERGE_EXIT=$?'))
    .replaceAll('<<ROOT_DIR>>', process.cwd()).replaceAll('<<REPO>>', 'o/r')
    .replaceAll('<<PR_NUMBER>>', '7').replaceAll('<<PR_URL>>', 'https://github.com/o/r/pull/7')
    .replaceAll('<<MERGE_METHOD>>', 'squash');
  const stub = `gh() { while [ "$#" -gt 0 ]; do if [ "$1" = --body ]; then printf '%s' "$2"; return; fi; shift; done; return 1; }\n`;
  const result = spawnSync('bash', ['-c', stub + snippet], { encoding: 'utf8', env: {
    ...process.env, HAM_NODE_BIN: process.execPath, HAM_AMA_TRAILERS: 'Closed-By: hammer',
    HAM_PROTECTIVE_PREDECESSOR_BODY: 'Fix:\n\n#7732; closes #7',
    HAM_MERGE_STDOUT: '/dev/stdout', HAM_MERGE_STDERR: '/dev/stderr', POST_REMEDIATION_SHA: 'head',
  } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Fix:\n\nPR #7732; closes #7\n\nClosed-By: hammer');
});

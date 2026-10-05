import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeAmaTrailers } from '../src/ama/audit.mjs';
import { composeCloserPrompt } from '../src/ama/dispatch-closer.mjs';
import { buildMergeCommitBody, neutralizeClosingKeywords } from '../src/ama/closing-keywords.mjs';

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

test('hammer shell merge runner receives the neutralized body', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-commit-message-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stdoutPath = join(dir, 'merge.stdout');
  const stderrPath = join(dir, 'merge.stderr');
  const source = readFileSync('bin/hammer-merge.sh', 'utf8');
  const snippet = source.slice(source.indexOf('  ham_commit_message_abort()'), source.indexOf('  HAM_MERGE_EXIT=$?'))
    .replaceAll('<<ROOT_DIR>>', process.cwd()).replaceAll('<<REPO>>', 'o/r')
    .replaceAll('<<PR_NUMBER>>', '7').replaceAll('<<PR_URL>>', 'https://github.com/o/r/pull/7')
    .replaceAll('<<MERGE_METHOD>>', 'squash');
  const stub = `ham_read_protective_predecessor_value() { printf -v "$2" '%s' 'Fix #7732 regression'; }
gh() { while [ "$#" -gt 0 ]; do if [ "$1" = --subject ]; then printf '%s\\n' "$2"; fi; if [ "$1" = --body ]; then printf '%s' "$2"; return; fi; shift; done; return 1; }\n`;
  const result = spawnSync('bash', ['-c', stub + snippet], { encoding: 'utf8', env: {
    ...process.env, HAM_NODE_BIN: process.execPath, HAM_AMA_TRAILERS: 'Closed-By: hammer',
    HAM_PROTECTIVE_PREDECESSOR_BODY: 'Fix:\n\n#7732; closes #7',
    HAM_MERGE_STDOUT: stdoutPath, HAM_MERGE_STDERR: stderrPath, POST_REMEDIATION_SHA: 'head',
  } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(stderrPath, 'utf8'), '');
  assert.equal(readFileSync(stdoutPath, 'utf8'), 'Fix PR #7732 regression (#7)\nFix:\n\nPR #7732; closes #7\n\nClosed-By: hammer');
});

for (const scheme of ['http', 'https']) {
  for (const kind of ['issues', 'pull']) {
    test(`URL ${scheme} ${kind} references and actual self exemption`, () => {
      const url = `${scheme}://github.com/O/R/${kind}/7732`;
      const result = neutralizeClosingKeywords(`Fixes ${url}; closes ${scheme}://github.com/o/r/${kind}/7; resolves ${scheme}://github.com/other/repo/${kind}/7`, { selfPrNumber: 7, repo: 'o/r' });
      assert.equal(result.text, `Fixes PR ${url}; closes ${scheme}://github.com/o/r/${kind}/7; resolves PR ${scheme}://github.com/other/repo/${kind}/7`);
      assert.deepEqual(result.rewrites[0], { original: `Fixes ${url}`, referencedNumber: 7732, referencedRepo: 'O/R', replacement: `Fixes PR ${url}` });
      assert.equal(result.rewrites.length, 2);
    });
  }
}

test('GH references are neutralized conservatively with the same self exemption', () => {
  assert.equal(neutralizeClosingKeywords('Fixed GH-7732; fixes gh-7', { selfPrNumber: 7 }).text, 'Fixed PR GH-7732; fixes gh-7');
});

test('message builder combines title and body audits and neutralizes titles', () => {
  const result = buildMergeCommitBody({ prTitle: 'Fix #7732 regression', prBody: 'Closes https://github.com/o/r/pull/8', selfPrNumber: 7, repo: 'o/r' });
  assert.equal(result.subject, 'Fix PR #7732 regression (#7)');
  assert.equal(result.text, 'Closes PR https://github.com/o/r/pull/8');
  assert.deepEqual(result.rewrites.map(r => r.referencedNumber), [7732, 8]);
  assert.equal(buildMergeCommitBody({ selfPrNumber: 7 }).subject, 'Pull request (#7)');
});

test('hammer fails closed without canonical dispatch trailers', () => {
  const result = spawnSync(process.execPath, ['bin/merge-commit-body.mjs', 'o/r', '7'], { input: 'Fix #7732', encoding: 'utf8', env: { ...process.env, HAM_AMA_TRAILERS: '' } });
  assert.equal(result.status, 78);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /canonical HAM_AMA_TRAILERS is required/);
});

test('dispatched hammer export carries canonical provenance byte for byte', () => {
  const trailers = composeAmaTrailers({ workerClass: 'hammer', reviewerFamily: 'claude', riskClass: 'critical', eligibilityReason: "operator's reason $&", auditRef: 'ama-audit:o/r:pr-7:head-abc' });
  const template = readFileSync('templates/hammer-prompt.md', 'utf8');
  const exportLine = template.split('\n').find(line => line.startsWith('export HAM_AMA_TRAILERS='));
  assert.ok(exportLine);
  const prompt = composeCloserPrompt({ amaTrailers: trailers, templateBody: exportLine });
  const result = spawnSync('bash', ['-c', prompt + `\nprintf '%s' 'Fix #7732' | "$HAM_NODE_BIN" bin/merge-commit-body.mjs o/r 7`], { encoding: 'utf8', env: { ...process.env, HAM_NODE_BIN: process.execPath } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).text, `Fix PR #7732\n\n${trailers}`);
});

for (const failure of ['sanitizer', 'body', 'subject', 'rewrites', 'title']) {
  test(`hammer ${failure} failure records audit and retryable lease abort`, () => {
    const source = readFileSync('bin/hammer-merge.sh', 'utf8');
    const snippet = source.slice(source.indexOf('  ham_commit_message_abort()'), source.indexOf('  HAM_MERGE_EXECUTED_AT='))
      .replaceAll('<<ROOT_DIR>>', process.cwd()).replaceAll('<<REPO>>', 'o/r').replaceAll('<<PR_NUMBER>>', '7').replaceAll('<<PR_URL>>', 'https://github.com/o/r/pull/7');
    const stubs = `ham_append_terminal_audit() { echo "audit:$2"; }
ham_mark_merge_lease_retryable_abort() { echo "retry:$1"; }
ham_release_merge_lease() { echo release; }
ham_read_protective_predecessor_value() { [ "$FAILURE" != title ] || return 1; printf -v "$2" '%s' 'Fix #7732'; }
jq() { case "$FAILURE:$*" in body:*.text*|subject:*.subject*|rewrites:*.rewrites*) return 1;; esac; command jq "$@"; }
run() {
`;
    const result = spawnSync('bash', ['-c', stubs + snippet + '\n}\nrun'], { encoding: 'utf8', env: { ...process.env, FAILURE: failure, HAM_NODE_BIN: process.execPath, HAM_AMA_TRAILERS: failure === 'sanitizer' ? '' : 'Closed-By: hammer', HAM_PROTECTIVE_PREDECESSOR_BODY: 'body' } });
    assert.equal(result.status, 1, result.stderr);
    const reason = { sanitizer: 'commit-body-sanitization-failed', body: 'commit-body-decode-failed', subject: 'commit-subject-decode-failed', rewrites: 'commit-rewrites-decode-failed', title: 'commit-title-read-failed' }[failure];
    assert.equal(result.stdout, `audit:${reason}\nretry:${reason}\nrelease\n`);
  });
}

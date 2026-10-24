import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const read = file => readFileSync(new URL(`../bin/${file}`, import.meta.url), 'utf8');
const run = (source, env = {}) => spawnSync('/bin/bash', ['-uc', source], {
  env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10000,
});

test('asynchronous rebase proof invokes its helper under a root path containing spaces', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer proof root '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'bin'));
  const from = 'a'.repeat(40), head = 'b'.repeat(40), base = 'c'.repeat(40);
  writeFileSync(join(dir, 'bin/hammer-rebase-result.mjs'),
    `import assert from 'node:assert/strict';\nassert.deepEqual(process.argv.slice(2), ${JSON.stringify([from, head, base])});\nconsole.log('{"proof":"fixture"}');\n`);
  const source = read('hammer-verify-head.sh').match(/^ham_settle_rebase_snapshot\(\) \{\n[\s\S]*?^\}/m)?.[0];
  assert.ok(source, 'exercise the production snapshot settlement function');
  const result = run(`
${source.replaceAll('<<ROOT_DIR>>', dir).replaceAll('<<RUN_DIR>>', dir)}
ham_pr() { printf '%s' "$SNAPSHOT"; }
ham_is_full_sha() { [ "\${#1}" -eq 40 ]; }
ham_bounded_git_sync() { [ "$1" = "$EXPECTED_HEAD" ]; }
ham_release_merge_lease() { echo unexpected-release >&2; }
ham_settle_rebase_snapshot "$FROM" "$EXPECTED_BASE" 1 || exit $?
[ "$HAM_REBASE_PUBLISHED_HEAD" = "$EXPECTED_HEAD" ]
[ "$POST_REMEDIATION_SHA" = "$EXPECTED_HEAD" ]
`, { HAM_NODE_BIN: process.execPath, BASE_BRANCH: 'main', FROM: from,
    EXPECTED_HEAD: head, EXPECTED_BASE: base,
    SNAPSHOT: JSON.stringify({ state: 'OPEN', baseRefName: 'main', headRefOid: head }) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'rebase-result-proof.json'), 'utf8')), { proof: 'fixture' });
});

for (const [name, deadline] of [['unset', undefined], ['empty', ''], ['future', '20'], ['expired', '5']]) {
  for (const updateResult of [0, 3]) {
    test(`rebase retry handles ${name} deadline and update result ${updateResult} with lease cleanup`, () => {
      const source = read('hammer-verify-head.sh').match(/^ham_rebase_head\(\) \{\n[\s\S]*?^\}/m)?.[0];
      assert.ok(source, 'exercise the production rebase function');
      const result = run(`
unset HAM_REMOTE_CI_DEADLINE
${deadline === undefined ? '' : `HAM_REMOTE_CI_DEADLINE='${deadline}'`}
POST_REMEDIATION_SHA=fixture-head
HAM_REBASE_ATTEMPTS=0
HAM_REBASE_ATTEMPT_CAP=3
date() { echo 10; }
ham_capture_current_base_sha() { HAM_CAPTURED_BASE_SHA=fixture-base; }
ham_release_merge_lease() { echo release; }
ham_update_branch_with_retries() { echo update; HAM_REBASE_PUBLISHED_HEAD="$POST_REMEDIATION_SHA"; return ${updateResult}; }
ham_settle_rebase_snapshot() { return 40; }
${source.replaceAll(/<<[A-Z_]+>>/g, 'fixture')}
ham_rebase_head --ci-retry
`);
      const expired = name === 'expired';
      const timedOut = expired || updateResult === 3;
      assert.equal(result.status, timedOut ? 20 : 40, result.stdout + result.stderr);
      assert.equal(result.stdout.trim(), expired ? 'release' : timedOut ? 'update\nrelease' : 'update');
      assert.equal(result.stderr, '');
    });
  }

  test(`post-reacquisition rebase deadline handles ${name} values without arithmetic diagnostics`, () => {
    const source = read('hammer-merge.sh');
    const start = source.indexOf('if [ "$HAM_ALREADY_MERGED_VALIDATED_HEAD" -ne 1 ] && ham_base_touches_pr_files validated-head');
    const end = source.indexOf('\nbreak\n', start);
    assert.ok(start >= 0 && end > start, 'exercise the production post-reacquisition branch');
    const result = run(`
unset HAM_REMOTE_CI_DEADLINE
${deadline === undefined ? '' : `HAM_REMOTE_CI_DEADLINE='${deadline}'`}
HAM_ALREADY_MERGED_VALIDATED_HEAD=0
HAM_CI_BASE_RETRY=0
HAM_GATE_JSON=/dev/null
date() { echo 10; }
jq() { echo MERGEABLE; }
ham_base_touches_pr_files() { return 0; }
ham_ci_timeout() { echo timeout; }
ham_rebase_head() { echo rebase; HAM_PHASE_OUTCOME=fixture-stop; return 40; }
ham_append_terminal_audit() { :; }
ham_release_merge_lease() { :; }
exercise() {
${source.slice(start, end)}
}
exercise
`);
    assert.equal(result.status, name === 'expired' ? 20 : 40, result.stdout + result.stderr);
    assert.equal(result.stdout.trim(), name === 'expired' ? 'timeout' : 'rebase');
    assert.doesNotMatch(result.stderr, /integer expression expected|unbound variable/);
  });
}

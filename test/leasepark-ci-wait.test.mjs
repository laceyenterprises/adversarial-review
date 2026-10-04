import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readMergeLeaseAttempts } from '../src/ama/merge-lease.mjs';

const rootDir = resolve(new URL('..', import.meta.url).pathname);
const merge = readFileSync(join(rootDir, 'bin/hammer-merge.sh'), 'utf8');
const verify = readFileSync(join(rootDir, 'bin/hammer-verify-head.sh'), 'utf8');
const head = 'a'.repeat(40);
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const render = source => source.replaceAll('<<ROOT_DIR>>', quote(rootDir))
  .replaceAll('<<REPO>>', 'fixture/repo').replaceAll('<<PR_NUMBER>>', '7702')
  .replaceAll('/tmp/ham-', '"$TEST_ROOT"/ham-');

function runWait(t, { gate, greenAfterSleep = false, launches = 1, overlap = false }) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-wait-refund-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'gate.json'), JSON.stringify({ headMatches: true, state: 'OPEN', ...gate }));
  const helpers = merge.slice(merge.indexOf('ham_required_gate_ok()'), merge.indexOf('ham_merge_error_retryable()'));
  const release = verify.slice(verify.indexOf('ham_mark_merge_lease_retryable_abort()'), verify.indexOf('ham_acquire_merge_lease()'));
  const loop = merge.slice(merge.indexOf('HAM_LOCAL_CI_STATUS=local-battery'), merge.indexOf('\nHAM_MERGE_ATTEMPTS=0'));
  const script = `
HAM_NODE_BIN=${quote(process.execPath)}
TEST_ROOT=${quote(dir)}
BASE_BRANCH=main
POST_REMEDIATION_SHA=${head}
HAM_GATE_JSON="$TEST_ROOT/gate.json"
HAM_MERGE_LEASE_RELEASE_RETRY_CAP=1
HAM_REMOTE_CI_WAIT_SECONDS=1
HAM_REMOTE_CI_POLL_SECONDS=1
HAM_REMOTE_CI_GATE_READ_FAILURE_LIMIT=1
${render(release).replace(' release \\', ' release --root-dir "$TEST_ROOT" \\')}
${helpers}
ham_acquire_merge_lease() {
  "$HAM_NODE_BIN" ${quote(join(rootDir, 'bin/merge-lease.mjs'))} acquire --root-dir "$TEST_ROOT" \\
    --repo fixture/repo --base main --pr 7702 --head "$POST_REMEDIATION_SHA" --owner-pid "$$" --wait 0 > "$TEST_ROOT/acquire.json" || return $?
  HAM_MERGE_LEASE_ID=$(jq -r .leaseId "$TEST_ROOT/acquire.json")
  HAM_MERGE_LEASE_HELD=1
}
ham_refresh_github_gate() { return 0; }
ham_append_terminal_audit() { echo "$*" >> "$TEST_ROOT/audits"; }
ham_base_touches_pr_files() { return ${overlap ? 0 : 1}; }
date() { echo "$FAKE_SECONDS"; }
sleep() {
  FAKE_SECONDS=$((FAKE_SECONDS + 1))
  ${greenAfterSleep ? 'jq \'.ok = true | .checksConclusion = "SUCCESS" | .reasons = []\' "$HAM_GATE_JSON" > "$TEST_ROOT/green.json"; mv "$TEST_ROOT/green.json" "$HAM_GATE_JSON"' : ':'}
}
wait_phase() {
${loop}
}
for launch in $(seq 1 ${launches}); do
  FAKE_SECONDS=0
  ham_acquire_merge_lease || exit $?
  wait_phase
  echo "exit:$?" >> "$TEST_ROOT/audits"
done
`;
  const result = spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return { dir, audit: readFileSync(join(dir, 'audits'), 'utf8'),
    attempts: readMergeLeaseAttempts(dir, { repo: 'fixture/repo', base: 'main' }) };
}

test('six same-head pending CI launches release and refund without gate-cap parking', t => {
  const result = runWait(t, { gate: { ok: false, checksConclusion: 'PENDING', reasons: ['ci-not-green'] }, launches: 6 });
  assert.equal(result.audit.match(/deferred required-checks-pending/g).length, 6);
  assert.equal(result.audit.match(/exit:20/g).length, 6);
  assert.equal(result.attempts[0].attempts, 0);
  assert.equal(result.attempts[0].retryable, 6);
});

test('CI-green reacquisition charges only one net attempt for the launch', t => {
  const result = runWait(t, { gate: { ok: false, checksConclusion: 'PENDING', reasons: ['ci-not-green'] }, greenAfterSleep: true });
  assert.equal(result.audit, 'exit:0\n');
  assert.equal(result.attempts[0].attempts, 1);
  assert.equal(result.attempts[0].retryable, 1);
});

for (const [name, gate] of [
  ['conflict with green CI', { checksConclusion: 'SUCCESS', mergeable: 'CONFLICTING', reasons: ['pr-not-mergeable'] }],
  ['strict BEHIND with green CI', { checksConclusion: 'SUCCESS', mergeStateStatus: 'BEHIND', reasons: ['pr-not-mergeable'] }],
  ['closed PR', { checksConclusion: 'SUCCESS', state: 'CLOSED', reasons: ['pr-not-mergeable'] }],
  ['pending CI plus a label hold', { checksConclusion: 'PENDING', reasons: ['ci-not-green', 'label-do-not-merge'] }],
]) {
  test(`CI timeout retains failure audit for ${name}`, t => {
    const result = runWait(t, { gate: { ok: false, ...gate } });
    assert.match(result.audit, /failed-without-merge github-gate-timeout/);
    assert.doesNotMatch(result.audit, /deferred/);
  });
}

test('base overlap after CI-green reacquire requires revalidation', t => {
  const result = runWait(t, { gate: { ok: false, checksConclusion: 'PENDING', reasons: ['ci-not-green'] }, greenAfterSleep: true, overlap: true });
  assert.match(result.audit, /failed-without-merge base-changed-file-overlap/);
  assert.match(result.audit, /exit:20/);
});

for (const [auditExit, state, outcome] of [[1, 'OPEN', 'parked:merge-lease-timeout'], [65, 'MERGED', 'already-merged'], [65, 'OPEN', null]]) {
  test(`lease timeout preserves provenance and handles audit exit ${auditExit} with PR ${state}`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'lease-timeout-audit-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const stub = join(dir, 'node-stub');
    writeFileSync(stub, `#!/bin/bash
case "$*" in
  *merge-lease.mjs*) echo '{"timedOut":true,"waited_s":1}'; exit 75 ;;
  *ama-audit.mjs*) echo "$*" > "$AUDIT_ARGS"; exit ${auditExit} ;;
esac
`, { mode: 0o755 });
    const acquire = render(verify.slice(verify.indexOf('ham_acquire_merge_lease()'), verify.indexOf('ham_update_branch_conflict()')))
      .replaceAll('<<PR_URL>>', 'fixture-url').replaceAll('<<HQ_ROOT>>', quote(dir))
      .replaceAll('<<REVIEWER>>', 'claude').replaceAll('<<RISK_CLASS>>', 'critical');
    const result = spawnSync('/bin/bash', ['-c', `
HAM_NODE_BIN=${quote(stub)}
TEST_ROOT=${quote(dir)}
POST_REMEDIATION_SHA=${head}
BASE_BRANCH=main
HAM_MERGE_LEASE_WAIT_SECONDS=1
gh() {
  if [[ "$*" == *--jq* ]]; then echo ${state}; else echo '{"statusCheckRollup":[]}'; fi
}
${acquire}
ham_acquire_merge_lease
printf 'exit:%s outcome:%s' "$?" "$HAM_PHASE_OUTCOME"
`], { encoding: 'utf8', timeout: 5000, env: { ...process.env, AUDIT_ARGS: join(dir, 'audit-args') } });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(dir, 'audit-args'), 'utf8'), /--reviewer claude --risk-class critical/);
    if (outcome) assert.equal(result.stdout, `exit:20 outcome:${outcome}`);
    else assert.match(result.stdout, /^exit:1/);
  });
}

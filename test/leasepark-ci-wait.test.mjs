import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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
  .replaceAll('<<PR_URL>>', 'fixture-url').replaceAll('<<REPO>>', 'fixture/repo').replaceAll('<<PR_NUMBER>>', '7702')
  .replaceAll('<<HQ_ROOT>>', quote(rootDir)).replaceAll('<<REVIEWER>>', 'claude').replaceAll('<<RISK_CLASS>>', 'critical')
  .replaceAll('/tmp/ham-', '"$TEST_ROOT"/ham-');

function runWait(t, { gate, greenAfterSleep = false, greenAfterPolls = 1, launches = 1, overlap = false, failAfterGreen = false, fixture = null, staleAbortBeforeAcquire = false }) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-wait-refund-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'gate.json'), JSON.stringify({ headMatches: true, state: 'OPEN', ...gate }));
  const helpers = merge.slice(merge.indexOf('ham_required_gate_ok()'), merge.indexOf('ham_merge_error_retryable()'));
  const release = verify.slice(verify.indexOf('ham_mark_merge_lease_retryable_abort()'), verify.indexOf('ham_acquire_merge_lease()'));
  const loop = merge.slice(merge.indexOf('HAM_LOCAL_CI_STATUS=local-battery'), merge.indexOf('\nHAM_MERGE_ATTEMPTS=0'));
  const acquire = render(verify.slice(verify.indexOf('ham_acquire_merge_lease()'), verify.indexOf('ham_update_branch_conflict()')))
    .replace(' acquire \\', ' acquire --root-dir "$TEST_ROOT" \\');
  const overlapHelper = render(verify.slice(verify.indexOf('ham_base_touches_pr_files()'), verify.indexOf('# Resolve whether')));
  const finalGate = merge.slice(merge.indexOf('  if ! ham_required_gate_ok; then', merge.indexOf('HAM_MERGE_ATTEMPTS=0')), merge.indexOf('\n  HAM_MERGE_CAPABILITY_ENFORCEMENT='));
  writeFileSync(join(dir, 'gh'), `#!/bin/bash
printf '{"headRefOid":"%s","statusCheckRollup":[]}' "$POST_REMEDIATION_SHA"
`, { mode: 0o755 });
  const script = `
export PATH=${quote(dir)}:"$PATH"
HAM_NODE_BIN=${quote(process.execPath)}
TEST_ROOT=${quote(dir)}
BASE_BRANCH=main
export POST_REMEDIATION_SHA=${fixture?.head || head}
HAM_GATE_JSON="$TEST_ROOT/gate.json"
HAM_MERGE_LEASE_RELEASE_RETRY_CAP=1
HAM_REMOTE_CI_WAIT_SECONDS=${greenAfterSleep ? greenAfterPolls + 1 : 1}
HAM_REMOTE_CI_POLL_SECONDS=1
HAM_REMOTE_CI_GATE_READ_FAILURE_LIMIT=1
${render(release).replace(' release \\', ' release --root-dir "$TEST_ROOT" \\')}
${helpers}
${acquire}
gh() { printf '{"headRefOid":"%s","statusCheckRollup":[]}' "$POST_REMEDIATION_SHA"; }
ham_is_full_sha() { [[ "$1" =~ ^[0-9a-fA-F]{40}$ ]]; }
HAM_MERGE_LEASE_WAIT_SECONDS=0
${fixture ? `${overlapHelper}
HAM_VALIDATION_BASE_SHA=${quote(fixture.validationBase)}
ham_bounded_git_sync() { git fetch origin main >/dev/null 2>&1; }` : `ham_base_touches_pr_files() { return ${overlap ? 0 : 1}; }`}
ham_refresh_github_gate() { return 0; }
ham_append_terminal_audit() { echo "$*" >> "$TEST_ROOT/audits"; }
date() { echo "$FAKE_SECONDS"; }
sleep() {
  FAKE_SECONDS=$((FAKE_SECONDS + 1))
  ${greenAfterSleep ? `if [ "$FAKE_SECONDS" -ge ${greenAfterPolls} ]; then jq \'.ok = true | .checksConclusion = "SUCCESS" | .reasons = []\' "$HAM_GATE_JSON" > "$TEST_ROOT/green.json"; mv "$TEST_ROOT/green.json" "$HAM_GATE_JSON"; fi` : ':'}
}
wait_phase() {
${loop}
}
for launch in $(seq 1 ${launches}); do
  FAKE_SECONDS=0
  ${staleAbortBeforeAcquire ? 'HAM_MERGE_LEASE_RETRYABLE_ABORT=1; HAM_MERGE_LEASE_RETRYABLE_ABORT_REASON=old-acquisition' : ':'}
  ham_acquire_merge_lease || exit $?
  ${staleAbortBeforeAcquire ? '[ "$HAM_MERGE_LEASE_RETRYABLE_ABORT" -eq 0 ] && [ -z "$HAM_MERGE_LEASE_RETRYABLE_ABORT_REASON" ] || exit 90' : ':'}
  wait_phase
  phase_status=$?
  ${failAfterGreen ? `jq '.ok = false | .checksConclusion = "FAILURE" | .reasons = ["ci-not-green"]' "$HAM_GATE_JSON" > "$TEST_ROOT/red.json"; mv "$TEST_ROOT/red.json" "$HAM_GATE_JSON"
  final_gate() { ${finalGate}
  }
  final_gate
  phase_status=$?` : 'ham_release_merge_lease'}
  echo "exit:$phase_status" >> "$TEST_ROOT/audits"
done
`;
  const result = spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8', timeout: 20_000, cwd: fixture?.repo });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return { dir, audit: readFileSync(join(dir, 'audits'), 'utf8'),
    attempts: readMergeLeaseAttempts(dir, { repo: 'fixture/repo', base: 'main' }) };
}

test('four same-head pending CI launches retain charges within the gate cap', t => {
  const result = runWait(t, { gate: { ok: false, checksConclusion: 'PENDING', reasons: ['ci-not-green'] }, launches: 4 });
  assert.equal(result.audit.match(/deferred required-checks-pending/g).length, 4);
  assert.equal(result.audit.match(/exit:20/g).length, 4);
  assert.equal(result.attempts[0].attempts, 4);
  assert.equal(result.attempts[0].retryable, 0);
});

test('CI-green reacquisition retains the pending attempt charge', t => {
  const result = runWait(t, { gate: { ok: false, checksConclusion: 'PENDING', reasons: ['ci-not-green'] }, greenAfterSleep: true });
  assert.equal(result.audit, 'exit:0\n');
  assert.equal(result.attempts[0].attempts, 2);
  assert.equal(result.attempts[0].retryable, 0);
});

test('successful acquisition clears refund state inherited from a previous lease', t => {
  const result = runWait(t, { gate: { ok: true, checksConclusion: 'SUCCESS', reasons: [] }, staleAbortBeforeAcquire: true });
  assert.equal(result.audit, 'exit:0\n');
  assert.equal(result.attempts[0].attempts, 1);
  assert.equal(result.attempts[0].retryable, 0);
});

for (const failAfterGreen of [false, true]) {
  test(`multi-poll CI wait charges reacquired attempt on ${failAfterGreen ? 'real gate failure' : 'normal release'}`, t => {
    const result = runWait(t, { gate: { ok: false, checksConclusion: 'PENDING', reasons: ['ci-not-green'] },
      greenAfterSleep: true, greenAfterPolls: 3, failAfterGreen });
    assert.match(result.audit, failAfterGreen ? /failed-without-merge github-gate-not-green\nexit:20/ : /^exit:0\n$/);
    assert.equal(result.attempts[0].attempts, 2);
    assert.equal(result.attempts[0].retryable, 0, 'pending waits retain the pre-wait charge');
  });
}

function rebasedFixture(t, moveAfterRebase = false) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-wait-base-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const remote = join(dir, 'remote');
  mkdirSync(repo);
  mkdirSync(remote);
  const git = (cwd, ...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(remote, 'init', '--bare', '--initial-branch=main');
  git(repo, 'init', '--initial-branch=main');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.test');
  git(repo, 'remote', 'add', 'origin', remote);
  const shared = join(repo, 'shared.txt');
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  writeFileSync(shared, `${lines.join('\n')}\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial base');
  const validationBase = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-b', 'topic');
  lines[0] = 'PR change';
  writeFileSync(shared, `${lines.join('\n')}\n`);
  git(repo, 'commit', '-am', 'PR change');
  git(repo, 'checkout', 'main');
  lines[0] = 'line 0';
  lines[29] = 'base change before rebase';
  writeFileSync(shared, `${lines.join('\n')}\n`);
  git(repo, 'commit', '-am', 'overlapping file before rebase');
  git(repo, 'push', 'origin', 'main');
  git(repo, 'checkout', 'topic');
  git(repo, 'rebase', 'main');
  const head = git(repo, 'rev-parse', 'HEAD');
  if (moveAfterRebase) {
    git(repo, 'checkout', 'main');
    lines[29] = 'base change after rebase';
    writeFileSync(shared, `${lines.join('\n')}\n`);
    git(repo, 'commit', '-am', 'overlapping file after rebase');
    git(repo, 'push', 'origin', 'main');
    git(repo, 'checkout', 'topic');
  }
  return { repo, head, validationBase };
}

for (const validationBase of ['old', '', 'malformed']) {
  test(`rebased head clears real overlap guard after CI wait with ${validationBase || 'missing'} validation base`, t => {
    const fixture = rebasedFixture(t);
    if (validationBase !== 'old') fixture.validationBase = validationBase;
    const result = runWait(t, { gate: { ok: false, checksConclusion: 'PENDING', reasons: ['ci-not-green'] },
      greenAfterSleep: true, greenAfterPolls: 3, fixture });
    assert.equal(result.audit, 'exit:0\n', 'already incorporated base changes permit merge to proceed');
    assert.equal(result.attempts[0].attempts, 2);
    assert.equal(result.attempts[0].retryable, 0);
  });
}

test('real overlap guard blocks base changes after the validated head was rebased', t => {
  const fixture = rebasedFixture(t, true);
  const result = runWait(t, { gate: { ok: false, checksConclusion: 'PENDING', reasons: ['ci-not-green'] },
    greenAfterSleep: true, greenAfterPolls: 3, fixture });
  assert.match(result.audit, /failed-without-merge base-changed-file-overlap\nexit:20/);
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
    writeFileSync(join(dir, 'gh'), `#!/bin/bash
if [[ "$*" == *--jq* ]]; then echo ${state}; else echo '{"statusCheckRollup":[]}'; fi
`, { mode: 0o755 });
    const acquire = render(verify.slice(verify.indexOf('ham_lease_pr_view()'), verify.indexOf('ham_update_branch_conflict()')))
      .replaceAll('<<PR_URL>>', 'fixture-url').replaceAll('<<HQ_ROOT>>', quote(dir))
      .replaceAll('<<REVIEWER>>', 'claude').replaceAll('<<RISK_CLASS>>', 'critical');
    const result = spawnSync('/bin/bash', ['-c', `
export PATH=${quote(dir)}:"$PATH"
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

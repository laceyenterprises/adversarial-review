import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { renderHammerProcedure } from '../src/hammer-procedure.mjs';
import { recordPendingAttestation } from '../src/ama/hammer-pending-attestation.mjs';
import { loadAwareTimeoutMs } from '../src/load-aware-timeout.mjs';

const root = resolve(import.meta.dirname, '..');
const helper = join(root, 'test/fixtures/hammer-self-rebase.mjs');
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const subprocessTimeout = loadAwareTimeoutMs(45_000);

// The synchronous shell fixtures can otherwise starve the test reporter until
// the whole file finishes, tripping a bounded runner's no-output deadline.
test.beforeEach(() => setImmediate());

function fixture(t, scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-self-rebase-'));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const remote = join(dir, 'remote.git'), scratch = join(dir, 'scratch'), bin = join(dir, 'bin');
  mkdirSync(scratch); mkdirSync(bin);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ALLOW_PROTOCOL: 'file', GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    FIXTURE_DIR: dir, SCENARIO: scenario, REAL_NODE: process.execPath, REAL_GIT: realGit,
    FIXTURE_HELPER: helper, PATH: `${bin}:${process.env.PATH}` };
  const git = (args, input) => execFileSync(realGit, args, { cwd: scratch, env, input, encoding: 'utf8', timeout: 10000 }).trim();
  git(['init', '--bare', '--quiet', remote]);
  const surfaceTest = `import { readFileSync } from 'node:fs';\nimport assert from 'node:assert/strict';\nassert.equal(readFileSync('surface.txt', 'utf8'), 'base-new\\nbody\\nhammer-new\\n');\n`;
  const commit = (text, parent, extra = false) => {
    const blob = git(['--git-dir', remote, 'hash-object', '-w', '--stdin'], text);
    const tests = git(['--git-dir', remote, 'hash-object', '-w', '--stdin'], surfaceTest);
    const extraBlob = extra ? git(['--git-dir', remote, 'hash-object', '-w', '--stdin'], 'unrelated base\n') : '';
    const tree = git(['--git-dir', remote, 'mktree'], `100644 blob ${blob}\tsurface.txt\n100644 blob ${tests}\tsurface.test.mjs\n${extra ? `100644 blob ${extraBlob}\tunrelated.txt\n` : ''}`);
    return git(['--git-dir', remote, 'commit-tree', tree, ...(parent ? ['-p', parent] : [])], 'Synthetic change\n');
  };
  const ancestor = commit('base-old\nbody\nhammer-old\n');
  const original = commit('base-old\nbody\nhammer-new\n', ancestor);
  const base = commit('base-new\nbody\nhammer-old\n', ancestor);
  const rebased = commit('base-new\nbody\nhammer-new\n', base);
  const foreign = commit('foreign\n', rebased);
  const disjoint = scenario.startsWith('ci-disjoint') || scenario === 'ci-old-reply';
  const nextBase = commit(disjoint ? 'base-new\nbody\nhammer-old\n' : 'base-new\nadvanced\nhammer-old\n', base, disjoint);
  const nextRebased = commit(disjoint ? 'base-new\nbody\nhammer-new\n' : 'base-new\nadvanced\nhammer-new\n', nextBase, disjoint);
  git(['--git-dir', remote, 'update-ref', 'refs/heads/main', base]);
  git(['--git-dir', remote, 'update-ref', 'refs/heads/topic', scenario === 'no-op' ? rebased : original]);
  git(['init', '--quiet']);
  git(['remote', 'add', 'origin', remote]);
  // Seed only A and its parent. B must be fetched by the production procedure.
  const pack = execFileSync(realGit, ['--git-dir', remote, 'pack-objects', '--stdout', '--revs'], { env, input: (scenario === 'no-op' ? rebased : original) + '\n', timeout: 10000 });
  execFileSync(realGit, ['unpack-objects'], { cwd: scratch, env, input: pack, timeout: 10000 });
  git(['checkout', '--quiet', '--detach', scenario === 'no-op' ? rebased : original]);
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ original, rebased, base, foreign, nextBase, nextRebased, head: scenario === 'no-op' ? rebased : original, behind: true }));
  writeFileSync(join(dir, 'details'), 'Synthetic surface repaired.\n');
  writeFileSync(join(dir, 'terminal-remediation.json'), JSON.stringify({ active: true,
    commit: { sha: rebased }, auditComment: { body: 'synthetic', findings: [
      { title: 'Keep source finding', blocking: true, file: 'surface.txt', addressed: true },
      { title: 'Keep advisory repair', blocking: false, file: 'surface.txt', addressed: true },
    ] } }));
  writeFileSync(join(dir, 'protection.json'), '{}');
  writeFileSync(join(dir, 'clock'), '1700000000');
  const executable = (name, source) => writeFileSync(join(bin, name), source, { mode: 0o755 });
  executable('gh', '#!/bin/sh\nexec "$REAL_NODE" "$FIXTURE_HELPER" gh "$@"\n');
  executable('date', '#!/bin/sh\nif [ "$1" = +%s ]; then cat "$FIXTURE_DIR/clock"; else exec /bin/date "$@"; fi\n');
  executable('sleep', `#!/bin/sh
echo "$1" >> "$FIXTURE_DIR/sleeps"
value=$(cat "$FIXTURE_DIR/clock")
increment="$1"
if [ "$SCENARIO" = ci-pending ]; then increment=300; fi
if [ "$SCENARIO" = ci-shared-deadline ] && [ "$value" -eq 1700000000 ]; then increment=600; fi
echo $((value + increment)) > "$FIXTURE_DIR/clock"
`);
  executable('node-fixture', `#!/bin/bash
case "$1" in
  */metered-gh.mjs) shift 2; exec gh "$@" ;;
  */hammer-pr-read.mjs) shift 3; exec gh pr view "$@" ;;
  */legacy-lane-write.mjs) shift; exec "$REAL_NODE" "$FIXTURE_HELPER" legacy "$@" ;;
  */merge-lease.mjs)
    case "$2" in
      acquire)
        if { [ "$SCENARIO" = ci-lease-deadline ] || [ "$SCENARIO" = ci-disjoint-lease-delay ]; } && [ -f "$FIXTURE_DIR/leases" ]; then echo 1700000900 > "$FIXTURE_DIR/clock"; fi
        touch "$FIXTURE_DIR/lease-held"; echo acquire >> "$FIXTURE_DIR/leases"; echo '{"leaseId":"fixture-lease"}' ;;
      release) rm "$FIXTURE_DIR/lease-held"; echo release >> "$FIXTURE_DIR/leases"; echo '{}' ;;
      status) echo '{"holder":{"leaseId":"fixture-lease","holderPr":42,"pastDeadline":false,"holderPidLive":true,"ageSeconds":1}}' ;;
      needs-revalidation) exec "$REAL_NODE" "$@" ;;
      *) exit 78 ;;
    esac ;;
  --input-type=module)
    if [ -n "\${HAM_RETRY_LEASE_ID:-}" ]; then cat >/dev/null; [ -f "$FIXTURE_DIR/lease-held" ];
    elif [ -n "\${POST_REMEDIATION_SHA:-}" ]; then cat >/dev/null; exec "$REAL_NODE" "$FIXTURE_HELPER" gate;
    else exec "$REAL_NODE" "$@"; fi ;;
  */ama-check.mjs) exec "$REAL_NODE" "$FIXTURE_HELPER" predicate "$@" ;;
  */primary-change-context.mjs) echo '{}' ;;
  */load-aware-timeout.mjs) if [ "$2" = 900 ]; then echo scale >> "$FIXTURE_DIR/wait-scales"; fi; echo "$2" ;;
  */hammer-pushed-attestation.mjs) exec "$REAL_NODE" "$FIXTURE_HELPER" pushed "$@" ;;
  */hammer-head-context.mjs) exec "$REAL_NODE" "$FIXTURE_HELPER" range "$@" ;;
  */ama-audit.mjs|*/merge-action-receipt.mjs|*/watcher-wake.mjs|*/dismiss-withdrawn-reviews.mjs|*/stacked-base-check.mjs) echo '{}' ;;
  *) exec "$REAL_NODE" "$@" ;;
esac
`);
  Object.assign(env, { HAM_NODE_BIN: join(bin, 'node-fixture'), HAM_RUN_DIR: dir, HAM_BASE_HEAD: original,
    HAM_VALIDATION_BASE_SHA: scenario === 'disjoint' ? base : ancestor,
    HAM_AUDIT_DETAILS_FILE: join(dir, 'details'), HAM_AUDIT_REMEDIATED_TOTAL: '2',
    HAM_AUDIT_REMEDIATED_BLOCKING: '1', HAM_AUDIT_REMEDIATED_NON_BLOCKING: '1',
    HAM_DOC_CURRENCY: 'not applicable', HAM_DOC_CURRENCY_REASON: 'synthetic surface only',
    HAM_FAILING_TESTS_FIXED: 'synthetic tests pass', HAMMER_LACEY_GH_TOKEN: 'synthetic-token',
    HAM_AMA_TRAILERS: 'Worker-Class: hammer\nWorker-Ticket: HAMSELFREBASE-01' });
  const values = { ROOT_DIR: root, RUN_DIR: dir, HQ_ROOT: dir, REPO: 'fixture/repo', PR_NUMBER: '42',
    PR_URL: 'https://github.com/fixture/repo/pull/42', REVIEWED_SHA: original,
    TARGET_REMEDIATION_SHA: original, REVIEWER: 'fixture', RISK_CLASS: 'low', HQ_OWNER: 'fixture', MERGE_METHOD: 'squash' };
  for (const phase of ['hammer-verify-head', 'hammer-publish', 'hammer-merge']) {
    let source = renderHammerProcedure(phase, values);
    // Host completion effects are isolated; merge/gate/confirmation shell logic is unchanged.
    source = source.replace('if ! ham_emit_git_merge_signal; then', 'if ! ham_fixture_completion; then')
      .replace('if ! ham_mark_ama_closer_lease_succeeded; then', 'if ! ham_fixture_completion; then');
    writeFileSync(join(dir, `${phase}.sh`), source);
  }
  if (scenario.includes('recovery')) recordPendingAttestation({ hqRoot: dir, repo: 'fixture/repo', prNumber: 42,
    baseHead: original, validatedHead: rebased, identity: { login: 'hammer-worker', databaseId: 77 },
    range: { verified: true, reviewedHead: original, currentHead: rebased, baseSha: original, commits: [rebased] },
    counts: { total: 2, blocking: 1, nonBlocking: 1 } });
  const run = (extraEnv = {}) => spawnSync('/bin/bash', ['-c', `
ham_fixture_completion() { :; }
if [ "$SCENARIO" = dirty ]; then echo dirty >> surface.txt; fi
source "$FIXTURE_DIR/hammer-verify-head.sh"
status=$?
echo "verify=$status outcome=$HAM_PHASE_OUTCOME head=\${HAM_PRODUCED_HEAD:-} revalidate=\${HAM_NEEDS_REVALIDATION:-} held=$HAM_MERGE_LEASE_HELD"
[ "$status" -eq 0 ] || exit "$status"
if [ "$SCENARIO" = ci-disjoint ]; then
  [ "$HAM_REQUIRES_UP_TO_DATE" -eq 0 ] || exit 94
fi
if [ "$HAM_NEEDS_REVALIDATION" = true ]; then
  env -u NODE_TEST_CONTEXT "$REAL_NODE" --test surface.test.mjs || exit 1
  git rev-parse HEAD > "$FIXTURE_DIR/tested-head"
fi
git rev-parse HEAD > "$FIXTURE_DIR/validated-head"
if [ "$SCENARIO" = foreign ]; then
  "$REAL_NODE" -e 'const fs=require("node:fs"),p=process.env.FIXTURE_DIR+"/state.json",s=JSON.parse(fs.readFileSync(p));s.head=s.foreign;fs.writeFileSync(p,JSON.stringify(s))'
fi
source "$FIXTURE_DIR/hammer-publish.sh"
status=$?
echo "publish=$status outcome=$HAM_PHASE_OUTCOME held=$HAM_MERGE_LEASE_HELD"
[ "$status" -eq 0 ] || exit "$status"
printf '{"eligible":true,"trace":{"headMatch":{"current":"%s"},"branchProtection":{"required":false}}}' "$HAM_PRODUCED_HEAD" > "$FIXTURE_DIR/verdict"
HAM_VERDICT_FILE="$FIXTURE_DIR/verdict"
HAM_VERDICT_READY_FILE="$HAM_VERDICT_FILE"
if [ "$SCENARIO" = ci-touching ]; then HAM_REBASE_ATTEMPTS="$HAM_REBASE_ATTEMPT_CAP"; fi
source "$FIXTURE_DIR/hammer-merge.sh"
status=$?
echo "merge=$status outcome=$HAM_PHASE_OUTCOME held=$HAM_MERGE_LEASE_HELD"
exit "$status"
`], { cwd: scratch, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: subprocessTimeout });
  return { dir, scratch, original, rebased, nextBase, nextRebased, run, git };
}

test('LAC-2093: an unregistered dispatched controller cannot acquire or validate a head', t => {
  const f = fixture(t, 'no-op');
  const result = f.run({ HQ_LAUNCH_REQUEST_ID: 'lrq_unregistered', AGENT_OS_WORKER_LRQ_ID: 'lrq_unregistered' });
  assert.equal(result.status, 125, result.stdout + result.stderr);
  assert.match(result.stderr, /hammer-controller:/);
  assert.equal(existsSync(join(f.dir, 'leases')), false);
  assert.equal(existsSync(join(f.dir, 'validated-head')), false);
});

for (const scenario of ['snapshot-failed', 'ci-snapshot-failed', 'snapshot-permanent']) {
  test(`post-rebase snapshot failure releases the lease before returning: ${scenario}`, t => {
    const f = fixture(t, scenario);
    const result = f.run();
    const diagnostics = result.stdout + result.stderr;
    assert.equal(result.signal, null, diagnostics);
    assert.equal(result.status, 1, diagnostics);
    assert.match(diagnostics, new RegExp(`${scenario.startsWith('ci-') ? 'merge' : 'verify'}=1 outcome=pr-refresh-failed .*held=0`));
    assert.equal(existsSync(join(f.dir, 'lease-held')), false);
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'state.json'), 'utf8')).snapshotReads,
      scenario.endsWith('permanent') ? 1 : 3);
    const events = readFileSync(join(f.dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(events.some(e => e.kind === 'pushed-edge' && e.value.pushedHead ===
      (scenario.startsWith('ci-') ? f.nextRebased : f.rebased)), 'provenance survives failed snapshot');
    assert.equal(events.some(e => e.kind === 'gh' && e.value[1] === 'merge'), false);
    assert.equal(f.git(['rev-parse', 'HEAD']), scenario.startsWith('ci-') ? f.rebased : f.original,
      'no scratch sync or further validation after snapshot failure');
  });
}

for (const scenario of ['snapshot-transient', 'ci-snapshot-transient']) {
  test(`post-rebase snapshot retries a transient error and merges: ${scenario}`, t => {
    const f = fixture(t, scenario);
    const result = f.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /outcome=merged/);
    const state = JSON.parse(readFileSync(join(f.dir, 'state.json'), 'utf8'));
    assert.equal(state.snapshotFailures, 1);
    // CI retry performs one additional final PR refresh after snapshot recovery.
    assert.equal(state.snapshotReads, scenario.startsWith('ci-') ? 3 : 2);
    assert.equal(existsSync(join(f.dir, 'lease-held')), false);
  });
}

for (const [scenario, idReads, updates, status] of [
  ['id-transient', 2, 1, 0], ['id-exhausted', 3, 0, 1], ['id-permanent', 1, 0, 1],
]) {
  test(`branch update bounds PR ID resolution retries: ${scenario}`, t => {
    const f = fixture(t, scenario);
    const result = f.run();
    const diagnostics = result.stdout + result.stderr;
    assert.equal(result.signal, null, diagnostics);
    assert.equal(result.status, status, diagnostics);
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'state.json'), 'utf8')).idReads, idReads);
    const events = readFileSync(join(f.dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(e => e.kind === 'gh' && e.value.some(arg => arg.includes('updatePullRequestBranch'))).length, updates);
    assert.equal(existsSync(join(f.dir, 'lease-held')), false);
    assert.match(diagnostics, status === 0 ? /outcome=merged/ : /verify=1 outcome=update-branch-failed .*held=0/);
    const sleeps = existsSync(join(f.dir, 'sleeps')) ? readFileSync(join(f.dir, 'sleeps'), 'utf8').trim().split('\n').map(Number) : [];
    assert.deepEqual(sleeps.slice(0, idReads - 1), Array.from({ length: idReads - 1 }, (_, i) => (i + 1) * 5),
      'existing bounded backoff applies before retrying ID resolution');
    if (status !== 0) assert.equal(sleeps.length, idReads - 1, 'no sleep after permanent failure or exhaustion');
  });
}

for (const scenario of ['rebase', 'recovery', 'pending', 'disjoint', 'foreign', 'foreign-recovery', 'foreign-after-rebase', 'conflict', 'dirty']) {
  test(`HAMSELFREBASE-01: ${scenario}`, t => {
    const f = fixture(t, scenario);
    const result = f.run();
    const diagnostics = result.stdout + result.stderr;
    const stops = ['foreign', 'foreign-recovery', 'foreign-after-rebase', 'conflict', 'dirty'].includes(scenario);
    assert.equal(result.signal, null, diagnostics);
    if (scenario === 'foreign-after-rebase') {
      const pushed = readFileSync(join(f.dir, 'pushed-comments'), 'utf8');
      assert.ok(pushed.includes(`HAM-Pushed-Head: ${f.rebased}`));
      assert.doesNotMatch(pushed, new RegExp(JSON.parse(readFileSync(join(f.dir, 'state.json'), 'utf8')).foreign));
      assert.match(diagnostics, /outcome=head-changed/);
    }
    assert.equal(result.status, scenario === 'conflict' ? 21 : scenario === 'dirty' ? 1 : stops ? 20 : 0, diagnostics);
    assert.equal(readFileSync(join(f.dir, 'leases'), 'utf8'), !stops ? 'acquire\nrelease\nacquire\nrelease\n' : 'acquire\nrelease\n', diagnostics);
    assert.equal(existsSync(join(f.dir, 'lease-held')), false);
    if (!stops) assert.equal(readFileSync(join(f.dir, 'wait-scales'), 'utf8'), 'scale\n');
    const events = readFileSync(join(f.dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(e => e.kind === 'gh' && e.value.some(arg => arg.includes('updatePullRequestBranch'))).length, 1);
    if (!stops) {
      assert.match(diagnostics, /merge=0 outcome=merged held=0/);
      assert.doesNotMatch(diagnostics, /head-changed|next hammer/);
      assert.equal(f.git(['rev-parse', 'HEAD']), f.rebased);
      assert.equal(existsSync(join(f.dir, 'tested-head')), scenario !== 'disjoint');
      if (scenario !== 'disjoint') assert.equal(readFileSync(join(f.dir, 'tested-head'), 'utf8').trim(), f.rebased);
      const checks = events.filter(e => e.kind === 'checks').map(e => e.value);
      assert.equal(checks[0].conclusion, scenario === 'pending' ? 'PENDING' : 'SUCCESS');
      assert.ok(checks.slice(1).every(check => check.head === f.rebased && check.conclusion === 'SUCCESS'));
      assert.match(readFileSync(join(f.dir, 'comments'), 'utf8'), new RegExp(`HAM-Validated-Head: ${f.rebased}`));
      if (scenario === 'recovery') assert.match(readFileSync(join(f.dir, 'comments'), 'utf8'), /ham-recovered-attestation/);
    } else {
      assert.equal(events.some(e => e.kind === 'gh' && e.value[1] === 'merge'), false);
      assert.equal(existsSync(join(f.dir, 'comments')), false);
      assert.match(diagnostics, scenario === 'conflict' ? /outcome=rebase-conflict/ : scenario === 'dirty' ? /outcome=rebased-head-sync-failed/ : /outcome=head-changed/);
      if (['conflict', 'dirty'].includes(scenario)) assert.equal(f.git(['rev-parse', 'HEAD']), f.original);
    }
  });
}

for (const scenario of ['ci-touching', 'ci-disjoint', 'ci-disjoint-strict', 'ci-disjoint-lease-delay', 'ci-disjoint-conflict', 'ci-conflict', 'ci-red', 'ci-pending', 'ci-head-moved', 'ci-predicate-refused', 'ci-range-unavailable', 'ci-strict-behind', 'ci-shared-deadline']) {
  test(`LEASEFAIR-02: ${scenario}`, t => {
    const f = fixture(t, scenario);
    if (scenario === 'ci-disjoint') {
      assert.equal(f.git(['--git-dir', join(f.dir, 'remote.git'), 'diff', '--name-only', `${f.rebased}^`, f.nextBase]), 'unrelated.txt');
      assert.equal(f.git(['--git-dir', join(f.dir, 'remote.git'), 'diff', '--name-only', `${f.rebased}^`, f.rebased]), 'surface.txt');
    }
    const result = f.run();
    const diagnostics = result.stdout + result.stderr;
    const succeeds = ['ci-touching', 'ci-disjoint', 'ci-disjoint-strict', 'ci-disjoint-lease-delay', 'ci-strict-behind'].includes(scenario);
    assert.equal(result.signal, null, diagnostics);
    assert.equal(result.status, succeeds ? 0 : ['ci-conflict', 'ci-disjoint-conflict'].includes(scenario) ? 21 : 20, diagnostics);
    assert.equal(readFileSync(join(f.dir, 'leases'), 'utf8'), 'acquire\nrelease\nacquire\nrelease\n', diagnostics);
    assert.equal(existsSync(join(f.dir, 'lease-held')), false);
    assert.equal(readFileSync(join(f.dir, 'wait-scales'), 'utf8'), 'scale\n');
    if (scenario === 'ci-shared-deadline') {
      assert.equal(Number(readFileSync(join(f.dir, 'clock'), 'utf8')) - 1700000000, 900,
        'first CI wait, rebase and retry must consume one absolute deadline');
    }
    const events = readFileSync(join(f.dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const checks = events.filter(e => e.kind === 'checks').map(e => e.value);
    assert.ok(checks.some(c => c.head === f.rebased && c.held === false), 'first wait is lease-free');
    if (!['ci-conflict', 'ci-disjoint-conflict', 'ci-disjoint', 'ci-disjoint-lease-delay'].includes(scenario)) {
      const retryChecks = checks.filter(c => c.head === f.nextRebased);
      assert.ok(retryChecks.length >= 1, diagnostics);
      assert.ok(retryChecks.every(c => c.held === true), 'retry never releases while polling');
    }
    const merges = events.filter(e => e.kind === 'gh' && e.value[1] === 'merge');
    assert.equal(merges.length, succeeds ? 1 : 0, diagnostics);
    if (succeeds) {
      assert.ok(merges[0].value.includes(['ci-disjoint', 'ci-disjoint-lease-delay'].includes(scenario) ? f.rebased : f.nextRebased));
      if (['ci-disjoint', 'ci-disjoint-lease-delay'].includes(scenario)) {
        assert.equal(f.git(['rev-parse', 'HEAD']), f.rebased, 'unrelated non-strict advance retains the validated head');
        assert.equal(events.filter(e => e.kind === 'gh' && e.value.some(arg => arg.includes('updatePullRequestBranch'))).length, 1,
          'only the mandatory initial rebase; no CI restart');
        assert.ok(checks.every(c => c.head === f.rebased));
        assert.equal(events.some(e => e.kind === 'predicate'), false, 'original head-bound authority stays intact');
        return;
      }
      assert.equal(f.git(['merge-base', f.nextBase, 'HEAD']), f.nextBase);
      assert.ok(checks.some(c => c.head === f.nextRebased && c.conclusion === 'PENDING'));
      assert.ok(checks.some(c => c.head === f.nextRebased && c.conclusion === 'SUCCESS'));
      assert.ok(events.some(e => e.kind === 'predicate' && e.value === f.nextRebased));
      assert.ok(events.some(e => e.kind === 'range' && e.value === f.nextRebased), 'retry publication proves the new range');
      assert.match(diagnostics, /outcome=merged/);
    } else {
      if (scenario === 'ci-range-unavailable') {
        assert.ok(events.some(e => e.kind === 'range' && e.value === f.nextRebased), diagnostics);
        assert.equal(events.some(e => e.kind === 'predicate'), false, 'no predicate may consume stale range evidence');
        assert.doesNotMatch(readFileSync(join(f.dir, 'comments'), 'utf8'), new RegExp(f.nextRebased),
          'failed range proof must stop retry audit publication');
        assert.match(diagnostics, /synthetic retry range proof unavailable/);
      } else assert.match(diagnostics, new RegExp(['ci-conflict', 'ci-disjoint-conflict'].includes(scenario) ? 'outcome=rebase-conflict' :
        scenario === 'ci-red' ? 'outcome=github-gate-red' : scenario === 'ci-head-moved' ? 'outcome=live-head-moved-before-merge' :
          scenario === 'ci-predicate-refused' ? 'outcome=retry-predicate-not-eligible' : 'outcome=required-checks-pending'));
    }
    if (['ci-red', 'ci-pending'].includes(scenario)) {
      const pushed = readFileSync(join(f.dir, 'pushed-comments'), 'utf8');
      assert.ok(pushed.includes(`HAM-Base-Head: ${f.rebased}`));
      assert.ok(pushed.includes(`HAM-Pushed-Head: ${f.nextRebased}`));
      assert.doesNotMatch(pushed, /HAM-Validated-Head:/);
      assert.ok(events.findIndex(e => e.kind === 'pushed-edge' && e.value.pushedHead === f.nextRebased)
        < events.findIndex(e => e.kind === 'checks' && e.value.head === f.nextRebased),
      'publication provenance must precede the first CI check on the rebased head');
    }
    assert.doesNotMatch(diagnostics, /outcome=base-advanced-during-ci-wait/);
  });
}

for (const scenario of ['old-reply', 'ci-old-reply', 'snapshot-lag', 'old-reply-foreign', 'old-reply-never']) {
  test(`LAC-2097: update-branch visibility converges without repeating the CAS: ${scenario}`, t => {
    const f = fixture(t, scenario);
    const result = f.run(), diagnostics = result.stdout + result.stderr;
    const refusal = ['old-reply-foreign', 'old-reply-never'].includes(scenario);
    assert.equal(result.signal, null, diagnostics);
    assert.equal(result.status, scenario === 'old-reply-foreign' ? 20 : scenario === 'old-reply-never' ? 1 : 0, diagnostics);
    assert.equal(existsSync(join(f.dir, 'lease-held')), false, 'terminal completion/refusal releases ownership');
    const events = readFileSync(join(f.dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(e => e.kind === 'gh' && e.value.some(arg => arg.includes('updatePullRequestBranch'))).length,
      scenario === 'ci-old-reply' ? 2 : 1, 'one mutation per required rebase, regardless of stale replies');
    assert.equal(events.filter(e => e.kind === 'gh' && e.value[1] === 'merge').length, refusal ? 0 : 1);
    if (refusal) {
      assert.equal(events.some(e => e.kind === 'pushed-edge'), false, 'cannot mint provenance for an unproven candidate');
      assert.equal(existsSync(join(f.dir, 'comments')), false);
      assert.match(diagnostics, scenario === 'old-reply-never' ? /outcome=rebase-head-timeout/ : /outcome=rebase-result-unproven/);
    } else {
      assert.match(diagnostics, /outcome=merged/);
      assert.equal(f.git(['rev-parse', 'HEAD']), scenario === 'ci-old-reply' ? f.nextRebased : f.rebased);
      if (scenario !== 'snapshot-lag') assert.equal(JSON.parse(readFileSync(join(f.dir, 'rebase-result-proof.json'))).proof, 'exact-rebase-tree-replay');
    }
  });
}

for (const scenario of ['ci-canceled', 'ci-closed']) {
  test(`LAC-2097: live closure refusal before reacquisition leaves no owner: ${scenario}`, t => {
    const f = fixture(t, scenario);
    const result = f.run(), diagnostics = result.stdout + result.stderr;
    assert.equal(result.status, 20, diagnostics);
    assert.match(diagnostics, /merge-lease-admission-refused/);
    assert.equal(readFileSync(join(f.dir, 'leases'), 'utf8'), 'acquire\nrelease\n');
    assert.equal(existsSync(join(f.dir, 'lease-held')), false);
    const events = readFileSync(join(f.dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.some(e => e.kind === 'gh' && e.value[1] === 'merge'), false);
    assert.equal(events.filter(e => e.kind === 'gh' && e.value.some(arg => arg.includes('updatePullRequestBranch'))).length, 1);
  });
}

test('LAC-2097: a strict already-up-to-date no-op keeps its exact head without another mutation', t => {
  const f = fixture(t, 'no-op');
  const result = f.run(), diagnostics = result.stdout + result.stderr;
  assert.equal(result.status, 0, diagnostics);
  assert.equal(f.git(['rev-parse', 'HEAD']), f.rebased);
  const events = readFileSync(join(f.dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e => e.kind === 'gh' && e.value.some(arg => arg.includes('updatePullRequestBranch'))).length, 1);
  assert.equal(events.some(e => e.kind === 'pushed-edge'), false, 'no invented publication edge for unchanged SHA');
  assert.equal(existsSync(join(f.dir, 'lease-held')), false);
});

for (const scenario of ['ci-lease-deadline', 'ci-id-deadline']) {
  test(`LAC-2097: exhausted CI deadline cannot start a rebase or restart CI: ${scenario}`, t => {
    const f = fixture(t, scenario);
    const result = f.run(), diagnostics = result.stdout + result.stderr;
    assert.equal(result.status, 20, diagnostics);
    assert.match(diagnostics, /outcome=github-gate-timeout/);
    assert.equal(f.git(['rev-parse', 'HEAD']), f.rebased);
    const events = readFileSync(join(f.dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(e => e.kind === 'gh' && e.value.some(arg => arg.includes('updatePullRequestBranch'))).length, 1,
      'expired reacquisition preserves the previously validated source head');
    assert.equal(events.some(e => e.kind === 'gh' && e.value[1] === 'merge'), false);
    assert.equal(existsSync(join(f.dir, 'lease-held')), false);
  });
}

// HAMVERDICTREADY-01: the shipped hammer close controller hands its owned
// predicate verdict to the real merge phase. These synthetic fixtures run the
// real bin/hammer-close.sh -> bin/hammer-close-controller.sh -> rendered
// bin/hammer-merge.sh chain. Only the process boundary is stubbed: node helper
// processes, GitHub reads/writes and the merge call itself. The verify-head and
// publish phases are synthetic; they are not part of the verdict handoff.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderHammerProcedure } from '../src/hammer-procedure.mjs';
import { loadAwareTimeoutMs } from '../src/load-aware-timeout.mjs';

const root = resolve(import.meta.dirname, '..');
const template = readFileSync(join(root, 'templates/hammer-prompt.md'), 'utf8');
const subprocessTimeout = loadAwareTimeoutMs(60_000);
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

function runDetached(script, args, env, cwd) {
  return new Promise(done => {
    const child = spawn('/bin/bash', ['-c', 'exec 0<&-; exec /bin/bash "$@"', 'fixture', script, ...args], {
      env, cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } }, subprocessTimeout);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('close', status => { clearTimeout(timer); done({ status, stdout, stderr }); });
  });
}

function gitRepo(dir) {
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim();
  mkdirSync(dir, { recursive: true });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'example.txt'), 'reviewed\n');
  git('add', 'example.txt'); git('commit', '-qm', 'Synthetic reviewed head');
  return { head: git('rev-parse', 'HEAD') };
}

// The fake node owns every helper process. Verdict behaviour comes from
// FIXTURE_AMA_CHECK: eligible, stale (eligible for another head), fail.
const fakeNodeSource = realNode => `#!/bin/bash
log() { printf '%s\\n' "$*" >> "$FIXTURE_LOG"; }
path="$1"; shift
if [ "$path" = --input-type=module ]; then
  code=$(cat)
  case "$code" in
    *'const rollup = await fetchHammerPr'*)
      log gate-read
      printf '{"ok":true,"reasons":[],"terminalReviewProof":null,"state":"OPEN","open":true,"headMatches":true,"expectedHead":"%s","liveHead":"%s","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","checksCount":1,"checksConclusion":"SUCCESS","badChecks":[]}\\n' "$POST_REMEDIATION_SHA" "$POST_REMEDIATION_SHA" ;;
  esac
  exit 0
fi
case "$(basename "$path")" in
  hammer-helper-step.mjs) shift 4; exec "$@" ;;
  hammer-pr-read.mjs)
    case " $* " in
      *' title '*) echo 'Synthetic fixture change' ;;
      *' body '*) echo 'Synthetic fixture body' ;;
      *)
        if [ -f "$FIXTURE_MERGED" ]; then
          printf '{"state":"MERGED","headRefOid":"%s","mergeCommit":{"oid":"%s"},"mergedAt":"2026-01-01T00:00:00Z"}\\n' "$FIXTURE_HEAD" "$FIXTURE_MERGE_COMMIT"
        else
          printf '{"headRefOid":"%s","state":"OPEN"}\\n' "$FIXTURE_HEAD"
        fi ;;
    esac ;;
  hammer-controller.mjs)
    case "$1" in
      run) shift; ctl="$1"; shift; log "controller-run $(basename "$ctl")"
        exec /bin/bash -c 'IFS= read -r ready || true; source "$@"' hammer-controller "$ctl" "$@" < /dev/null ;;
      *) log "controller $1" ;;
    esac ;;
  hammer-predicate-inputs.mjs) log predicate-inputs ;;
  primary-change-context.mjs) echo '{}' ;;
  ama-check.mjs)
    log "ama-check marker=\${HAM_VERDICT_READY_FILE:-empty}"
    case "\${FIXTURE_AMA_CHECK:-eligible}" in
      fail) echo 'synthetic predicate build failure' >&2; exit 1 ;;
      stale) verdict_head=$(printf '%040d' 0) ;;
      *) verdict_head="$POST_REMEDIATION_SHA" ;;
    esac
    printf '{"eligible":true,"reasons":[],"trace":{"headMatch":{"current":"%s"},"branchProtection":{"required":false}}}\\n' "$verdict_head" ;;
  ama-audit.mjs)
    for ((i = 1; i <= $#; i++)); do
      if [ "\${!i}" = --outcome ]; then j=$((i + 1)); log "ama-audit \${!j}"; fi
    done ;;
  merge-commit-body.mjs) echo '{"text":"Synthetic fixture body","subject":"Synthetic fixture change","rewrites":[]}' ;;
  legacy-lane-write.mjs)
    while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done
    shift
    log "merge-call $*"
    : > "$FIXTURE_MERGED" ;;
  hammer-terminal-audit.mjs|hammer-progress.mjs|merge-action-receipt.mjs|watcher-wake.mjs|record-merge-signal.mjs|dismiss-withdrawn-reviews.mjs|stacked-base-check.mjs|load-aware-timeout.mjs|metered-gh.mjs)
    log "$(basename "$path" .mjs) $*" ;;
  *) exec ${shellQuote(realNode)} "$path" "$@" ;;
esac
`;

function closeFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hamverdictready-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = join(dir, 'run');
  const checkout = join(dir, 'checkout');
  mkdirSync(run, { mode: 0o700 }); mkdirSync(join(dir, 'fake-bin'));
  const { head } = gitRepo(checkout);
  const log = join(dir, 'events.log');
  const fakeNode = join(dir, 'fake-bin/node');
  writeFileSync(fakeNode, fakeNodeSource(process.execPath));
  chmodSync(fakeNode, 0o755);
  const values = { ROOT_DIR: root, RUN_DIR: run, HQ_ROOT: dir, REPO: 'fixture/repo', PR_NUMBER: '42',
    PR_URL: 'https://github.com/fixture/repo/pull/42', REVIEWED_SHA: head, TARGET_REMEDIATION_SHA: head,
    RISK_CLASS: 'low', MERGE_METHOD: 'squash', HQ_OWNER: 'fixture', AUDIT_PATH: join(run, 'audit.json'),
    REVIEWER: 'synthetic-reviewer', AMA_TRAILERS_SHELL: "''" };
  const inputs = template.match(/cat > '<<RUN_DIR>>\/inputs\.sh' <<'HAM_INPUTS'\n([\s\S]*?)\nHAM_INPUTS/)[1]
    .replace(/<<([A-Z_]+)>>/g, (_, key) => values[key]);
  writeFileSync(join(run, 'inputs.sh'), `${inputs}\n`);
  writeFileSync(join(run, 'base-head'), head);
  // The real merge phase, rendered exactly as dispatch renders it.
  writeFileSync(join(run, 'hammer-merge.sh'), renderHammerProcedure('hammer-merge', values));
  // Synthetic verify-head: holds the lease and defines the lease/base helpers
  // the real merge phase calls. No CI publication, so --wait-ci is a no-op.
  writeFileSync(join(run, 'hammer-verify-head.sh'), `log() { printf '%s\\n' "$*" >> "$FIXTURE_LOG"; }
ham_release_merge_lease() {
  if [ "\${HAM_MERGE_LEASE_HELD:-0}" = 1 ]; then log "release \${*:-holder}"; fi
  HAM_MERGE_LEASE_HELD=0
  return 0
}
ham_acquire_merge_lease() { HAM_MERGE_LEASE_HELD=1; HAM_MERGE_LEASE_ID=ml_fixture; log acquire; }
ham_mark_merge_lease_retryable_abort() { log "retryable-abort $1"; }
ham_base_touches_pr_files() { return 1; }
ham_capture_current_base_sha() { HAM_CAPTURED_BASE_SHA=$(git rev-parse HEAD); }
ham_rebase_head() { return 21; }
# The procedure pins its poll cadence; the fixture's clock does not wait.
sleep() { :; }
BASE_BRANCH=main
ham_acquire_merge_lease
export POST_REMEDIATION_SHA HAM_PRODUCED_HEAD
POST_REMEDIATION_SHA=$(git rev-parse HEAD); HAM_PRODUCED_HEAD="$POST_REMEDIATION_SHA"
HAM_NEEDS_REVALIDATION=false
HAM_PHASE_OUTCOME=verified
return 0
`);
  writeFileSync(join(run, 'hammer-publish.sh'), `HAM_PUBLISHED_AUDIT_HEAD="$POST_REMEDIATION_SHA"
HAM_PHASE_OUTCOME=published
return 0
`);
  writeFileSync(join(run, 'audit-details.md'), '**Findings addressed**\n- Synthetic correction (blocking): example.txt; fixed\n');
  writeFileSync(join(run, 'terminal-remediation.json'), JSON.stringify({ active: true, commit: {}, auditComment: {} }));
  writeFileSync(join(run, 'close-plan.json'), JSON.stringify({ auditDetailsFile: 'audit-details.md',
    remediated: { total: 1, blocking: 1, nonBlocking: 0 }, failingTestsFixed: 'suite already green',
    docCurrency: { status: 'not applicable', reason: 'example.txt: no doc' }, validationFiles: ['example.txt'] }));
  const env = {
    PATH: '/usr/bin:/bin', HOME: dir, HAM_NODE_BIN: fakeNode, FIXTURE_LOG: log, FIXTURE_HEAD: head,
    FIXTURE_MERGED: join(dir, 'merged'), FIXTURE_MERGE_COMMIT: 'b'.repeat(40),
    HQ_LAUNCH_REQUEST_ID: 'lrq_fixture', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  };
  const events = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  const close = (extra = {}) => runDetached(join(root, 'bin/hammer-close.sh'), [join(run, 'close-plan.json')],
    { ...env, ...extra }, checkout).then(result => ({ ...result,
    closeResult: existsSync(join(run, 'close-result.json')) ? JSON.parse(readFileSync(join(run, 'close-result.json'), 'utf8')) : null }));
  return { dir, run, head, events, close };
}

const mergeCalls = events => events.filter(event => event.startsWith('merge-call '));

test('an eligible exact-head verdict built by the shipped controller passes the ownership gate and reaches the merge call', async t => {
  const f = closeFixture(t);
  const result = await f.close();
  const events = f.events();
  const diagnostics = `${result.stderr}\n${result.stdout}\n${events.join('\n')}`;
  assert.doesNotMatch(result.stdout, /no owned predicate verdict/, diagnostics);
  assert.equal(result.status, 0, diagnostics);
  assert.equal(result.closeResult.outcome, 'merged', diagnostics);
  // The marker is empty while ama-check runs; the merge happens afterwards.
  assert.ok(events.includes('ama-check marker=empty'), diagnostics);
  const calls = mergeCalls(events);
  assert.equal(calls.length, 1, diagnostics);
  assert.match(calls[0], new RegExp(`pr merge https://github.com/fixture/repo/pull/42 --squash --match-head-commit ${f.head} `));
  assert.ok(!events.includes('ama-audit failed-without-merge'), diagnostics);
  assert.ok(events.indexOf('ama-check marker=empty') < events.indexOf(calls[0]), diagnostics);
});

test('an inherited marker naming a foreign verdict is cleared before ama-check and a failed ama-check refuses', async t => {
  const f = closeFixture(t);
  const foreign = join(f.dir, 'foreign-verdict.json');
  writeFileSync(foreign, JSON.stringify({ eligible: true, trace: { headMatch: { current: f.head },
    branchProtection: { required: false } } }));
  const result = await f.close({ FIXTURE_AMA_CHECK: 'fail', HAM_VERDICT_FILE: foreign, HAM_VERDICT_READY_FILE: foreign });
  const events = f.events();
  const diagnostics = `${result.stderr}\n${result.stdout}\n${events.join('\n')}`;
  assert.equal(result.status, 1, diagnostics);
  assert.equal(result.closeResult.outcome, 'predicate-build-failed', diagnostics);
  assert.equal(result.closeResult.stage, 'predicate', diagnostics);
  assert.equal(result.closeResult.leaseHeld, false, diagnostics);
  assert.ok(events.includes('ama-check marker=empty'), diagnostics);
  assert.deepEqual(mergeCalls(events), [], diagnostics);
  assert.ok(!events.some(event => event.startsWith('gate-read')), 'the merge phase never ran');
  assert.ok(events.includes('release holder'), diagnostics);
});

test('a stale-head verdict still refuses at the real merge phase', async t => {
  const f = closeFixture(t);
  const result = await f.close({ FIXTURE_AMA_CHECK: 'stale' });
  const events = f.events();
  const diagnostics = `${result.stderr}\n${result.stdout}\n${events.join('\n')}`;
  assert.equal(result.status, 20, diagnostics);
  assert.equal(result.closeResult.outcome, 'predicate-not-eligible', diagnostics);
  assert.match(result.stdout, /HAM hard-blocker: predicate is not eligible for the validated head/);
  assert.deepEqual(mergeCalls(events), [], diagnostics);
  assert.ok(events.includes('ama-audit failed-without-merge'), diagnostics);
});

// The ownership gate itself, unchanged: the real merge phase refuses a missing
// marker, a marker naming another file, and a verdict file the run does not own.
function runMergePhase(t, { marker, verdictOwnedByRun = true }) {
  const dir = mkdtempSync(join(tmpdir(), 'hamverdictready-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const head = 'a'.repeat(40);
  const fakeNode = join(dir, 'node');
  writeFileSync(fakeNode, fakeNodeSource(process.execPath));
  chmodSync(fakeNode, 0o755);
  const verdict = join(dir, 'verdict.json');
  writeFileSync(verdict, JSON.stringify({ eligible: true, trace: { headMatch: { current: head },
    branchProtection: { required: false } } }));
  const foreign = join(dir, 'foreign.json');
  writeFileSync(foreign, readFileSync(verdict));
  const script = join(dir, 'hammer-merge.sh');
  writeFileSync(script, renderHammerProcedure('hammer-merge', { ROOT_DIR: root, RUN_DIR: dir, HQ_ROOT: dir,
    REPO: 'fixture/repo', PR_NUMBER: '42', PR_URL: 'https://github.com/fixture/repo/pull/42', REVIEWED_SHA: head,
    TARGET_REMEDIATION_SHA: head, MERGE_METHOD: 'squash', REVIEWER: 'synthetic-reviewer', RISK_CLASS: 'low' }));
  const markerValue = { own: verdict, foreign, empty: '' }[marker];
  // /etc/hosts is a regular file owned by root, never by an unprivileged test user.
  const verdictPath = verdictOwnedByRun ? verdict : '/etc/hosts';
  const log = join(dir, 'events.log');
  const result = execFileSyncStatus('/bin/bash', ['-c', `
HAM_MERGE_LEASE_HELD=1 HAM_MERGE_LEASE_ID=ml_fixture
POST_REMEDIATION_SHA=${head} HAM_PUBLISHED_AUDIT_HEAD=${head}
HAM_VERDICT_FILE=${shellQuote(verdictPath)} HAM_VERDICT_READY_FILE=${shellQuote(markerValue === verdict ? verdictPath : markerValue)}
ham_release_merge_lease() { printf 'release\\n' >> "$FIXTURE_LOG"; HAM_MERGE_LEASE_HELD=0; }
source "$1"
status=$?
printf 'outcome %s\\n' "$HAM_PHASE_OUTCOME" >> "$FIXTURE_LOG"
exit "$status"
`, '_', script], { PATH: '/usr/bin:/bin', HOME: dir, HAM_NODE_BIN: fakeNode, FIXTURE_LOG: log,
    FIXTURE_HEAD: head, FIXTURE_MERGED: join(dir, 'merged'), FIXTURE_MERGE_COMMIT: 'b'.repeat(40), TMPDIR: dir });
  return { ...result, events: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] };
}

function execFileSyncStatus(file, args, env) {
  try {
    const stdout = execFileSync(file, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: subprocessTimeout });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

for (const [name, options] of [
  ['an empty marker', { marker: 'empty' }],
  ['a marker naming a foreign verdict file', { marker: 'foreign' }],
  ['a verdict file the run does not own', { marker: 'own', verdictOwnedByRun: false }],
]) {
  test(`the real merge phase refuses ${name} as predicate-verdict-unavailable`, { skip: options.verdictOwnedByRun === false && process.getuid?.() === 0 }, t => {
    const result = runMergePhase(t, options);
    const diagnostics = `${result.stderr}\n${result.events.join('\n')}`;
    assert.equal(result.status, 20, diagnostics);
    assert.match(result.stderr, /HAM hard-blocker: current run has no owned predicate verdict/);
    assert.ok(result.events.includes('ama-audit failed-without-merge'), diagnostics);
    assert.ok(result.events.includes('outcome predicate-verdict-unavailable'), diagnostics);
    assert.ok(result.events.includes('release'), diagnostics);
    assert.deepEqual(mergeCalls(result.events), [], diagnostics);
  });
}

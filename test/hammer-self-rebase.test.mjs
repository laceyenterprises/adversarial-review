import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderHammerProcedure } from '../src/hammer-procedure.mjs';
import { recordPendingAttestation } from '../src/ama/hammer-pending-attestation.mjs';

const root = resolve(import.meta.dirname, '..');
const helper = join(root, 'test/fixtures/hammer-self-rebase.mjs');
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

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
  const commit = (text, parent) => {
    const blob = git(['--git-dir', remote, 'hash-object', '-w', '--stdin'], text);
    const tests = git(['--git-dir', remote, 'hash-object', '-w', '--stdin'], surfaceTest);
    const tree = git(['--git-dir', remote, 'mktree'], `100644 blob ${blob}\tsurface.txt\n100644 blob ${tests}\tsurface.test.mjs\n`);
    return git(['--git-dir', remote, 'commit-tree', tree, ...(parent ? ['-p', parent] : [])], 'Synthetic change\n');
  };
  const ancestor = commit('base-old\nbody\nhammer-old\n');
  const original = commit('base-old\nbody\nhammer-new\n', ancestor);
  const base = commit('base-new\nbody\nhammer-old\n', ancestor);
  const rebased = commit('base-new\nbody\nhammer-new\n', base);
  const foreign = commit('foreign\n', rebased);
  git(['--git-dir', remote, 'update-ref', 'refs/heads/main', base]);
  git(['--git-dir', remote, 'update-ref', 'refs/heads/topic', original]);
  git(['init', '--quiet']);
  git(['remote', 'add', 'origin', remote]);
  // Seed only A and its parent. B must be fetched by the production procedure.
  const pack = execFileSync(realGit, ['--git-dir', remote, 'pack-objects', '--stdout', '--revs'], { env, input: original + '\n', timeout: 10000 });
  execFileSync(realGit, ['unpack-objects'], { cwd: scratch, env, input: pack, timeout: 10000 });
  git(['checkout', '--quiet', '--detach', original]);
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ original, rebased, base, foreign, head: original, behind: true }));
  writeFileSync(join(dir, 'details'), 'Synthetic surface repaired.\n');
  writeFileSync(join(dir, 'clock'), '1700000000');
  const executable = (name, source) => writeFileSync(join(bin, name), source, { mode: 0o755 });
  executable('gh', '#!/bin/sh\nexec "$REAL_NODE" "$FIXTURE_HELPER" gh "$@"\n');
  executable('date', '#!/bin/sh\nif [ "$1" = +%s ]; then cat "$FIXTURE_DIR/clock"; else exec /bin/date "$@"; fi\n');
  executable('sleep', `#!/bin/sh
value=$(cat "$FIXTURE_DIR/clock")
echo $((value + $1)) > "$FIXTURE_DIR/clock"
`);
  executable('node-fixture', `#!/bin/bash
case "$1" in
  */metered-gh.mjs) shift 2; exec gh "$@" ;;
  */hammer-pr-read.mjs) shift 3; exec gh pr view "$@" ;;
  */merge-lease.mjs)
    case "$2" in
      acquire) touch "$FIXTURE_DIR/lease-held"; echo acquire >> "$FIXTURE_DIR/leases"; echo '{"leaseId":"fixture-lease"}' ;;
      release) rm "$FIXTURE_DIR/lease-held"; echo release >> "$FIXTURE_DIR/leases"; echo '{}' ;;
      status) echo '{"holder":{"leaseId":"fixture-lease","holderPr":42,"pastDeadline":false,"holderPidLive":true,"ageSeconds":1}}' ;;
      needs-revalidation) exec "$REAL_NODE" "$@" ;;
      *) exit 78 ;;
    esac ;;
  --input-type=module)
    if [ -n "\${POST_REMEDIATION_SHA:-}" ]; then cat >/dev/null; exec "$REAL_NODE" "$FIXTURE_HELPER" gate;
    else exec "$REAL_NODE" "$@"; fi ;;
  */hammer-head-context.mjs) exec "$REAL_NODE" "$FIXTURE_HELPER" range ;;
  */ama-audit.mjs|*/merge-action-receipt.mjs|*/watcher-wake.mjs|*/dismiss-withdrawn-reviews.mjs|*/stacked-base-check.mjs) echo '{}' ;;
  *) exec "$REAL_NODE" "$@" ;;
esac
`);
  Object.assign(env, { HAM_NODE_BIN: join(bin, 'node-fixture'), HAM_RUN_DIR: dir, HAM_BASE_HEAD: original,
    HAM_VALIDATION_BASE_SHA: scenario === 'disjoint' ? base : ancestor,
    HAM_AUDIT_DETAILS_FILE: join(dir, 'details'), HAM_AUDIT_REMEDIATED_TOTAL: '0',
    HAM_AUDIT_REMEDIATED_BLOCKING: '0', HAM_AUDIT_REMEDIATED_NON_BLOCKING: '0',
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
    counts: { total: 0, blocking: 0, nonBlocking: 0 } });
  const run = () => spawnSync('/bin/bash', ['-c', `
ham_fixture_completion() { :; }
if [ "$SCENARIO" = dirty ]; then echo dirty >> surface.txt; fi
source "$FIXTURE_DIR/hammer-verify-head.sh"
status=$?
echo "verify=$status outcome=$HAM_PHASE_OUTCOME head=\${HAM_PRODUCED_HEAD:-} revalidate=\${HAM_NEEDS_REVALIDATION:-}"
[ "$status" -eq 0 ] || exit "$status"
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
source "$FIXTURE_DIR/hammer-merge.sh"
status=$?
echo "merge=$status outcome=$HAM_PHASE_OUTCOME held=$HAM_MERGE_LEASE_HELD"
exit "$status"
`], { cwd: scratch, env, encoding: 'utf8', timeout: 45000 });
  return { dir, scratch, original, rebased, run, git };
}

for (const scenario of ['rebase', 'recovery', 'pending', 'disjoint', 'foreign', 'foreign-recovery', 'conflict', 'dirty']) {
  test(`HAMSELFREBASE-01: ${scenario}`, t => {
    const f = fixture(t, scenario);
    const result = f.run();
    const diagnostics = result.stdout + result.stderr;
    const stops = ['foreign', 'foreign-recovery', 'conflict', 'dirty'].includes(scenario);
    assert.equal(result.signal, null, diagnostics);
    assert.equal(result.status, scenario === 'conflict' ? 21 : scenario === 'dirty' ? 1 : stops ? 20 : 0, diagnostics);
    assert.equal(readFileSync(join(f.dir, 'leases'), 'utf8'), !stops ? 'acquire\nrelease\nacquire\nrelease\n' : 'acquire\nrelease\n', diagnostics);
    assert.equal(existsSync(join(f.dir, 'lease-held')), false);
    const events = readFileSync(join(f.dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(e => e.kind === 'gh' && e.value[1] === 'update-branch').length, 1);
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

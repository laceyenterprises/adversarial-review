// HAMCONTROLLERSCRIPT-01: the closer's controllers are shipped, tested scripts.
// The model writes only data and runs one command. These synthetic fixtures run
// the shipped scripts with no controlling terminal and a closed stdin, stub only
// the process boundary (node helpers, gh, git remote, hq) and record the order
// of lease, validation and merge side effects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runHelperStep } from '../bin/hammer-helper-step.mjs';
import { resolveHammerShellHelper, HAMMER_SERVICE_ROOT } from '../src/ama/hammer-shell-helper-command.mjs';
import { parseClosePlan } from '../bin/hammer-close-plan.mjs';
import { parseCloseCommands } from '../bin/close-commands.mjs';
import { buildMergeAgentPrompt, FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER } from '../src/merge-agent-prompt.mjs';

const root = resolve(import.meta.dirname, '..');
const template = readFileSync(join(root, 'templates/hammer-prompt.md'), 'utf8');
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

// Run with no controlling terminal (new session) and file descriptor 0 closed.
function runDetached(script, args, env, cwd) {
  return new Promise(done => {
    const child = spawn('/bin/bash', ['-c', 'exec 0<&-; exec /bin/bash "$@"', 'fixture', script, ...args], {
      env, cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } }, 20_000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('close', status => { clearTimeout(timer); done({ status, stdout, stderr }); });
  });
}

function scratch(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function gitRepo(dir) {
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim();
  mkdirSync(dir, { recursive: true });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'example.txt'), 'reviewed\n');
  git('add', 'example.txt'); git('commit', '-qm', 'Synthetic reviewed head');
  const reviewed = git('rev-parse', 'HEAD');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/example.mjs'), 'export const fixed = true;\n');
  git('add', 'src/example.mjs'); git('commit', '-qm', 'Synthetic remediation');
  return { reviewed, head: git('rev-parse', 'HEAD') };
}

// ---------------------------------------------------------------- hammer close

function hammerFixture(t, { liveHead } = {}) {
  const dir = scratch(t, 'hamcontrollerscript-');
  const run = join(dir, 'run');
  const checkout = join(dir, 'checkout');
  const bin = join(dir, 'fake-bin');
  mkdirSync(run, { mode: 0o700 }); mkdirSync(bin);
  const shas = gitRepo(checkout);
  const log = join(dir, 'events.log');
  const fakeNode = join(bin, 'node');
  writeFileSync(fakeNode, `#!/bin/bash
log() { printf '%s\\n' "$*" >> "$FIXTURE_LOG"; }
[ -t 0 ] && { log 'stdin-is-a-tty'; exit 90; }
path="$1"; shift
case "$(basename "$path")" in
  hammer-helper-step.mjs) shift 4; exec "$@" ;;
  hammer-pr-read.mjs) log "pr-read $*"; printf '{"headRefOid":"%s"}\\n' "$FIXTURE_LIVE_HEAD" ;;
  hammer-controller.mjs)
    case "$1" in
      assert-owner) log assert-owner ;;
      resolve-environment) [ -n "\${HAM_RUN_DIR:-}" ] || { log 'resolve-before-inputs'; exit 125; }; log resolve-environment ;;
      run) shift; ctl="$1"; shift; log "controller-run $(basename "$ctl")"
        exec /bin/bash -c 'IFS= read -r ready || true; source "$@"' hammer-controller "$ctl" "$@" < /dev/null ;;
    esac ;;
  hammer-validate.mjs)
    log "validate $*"
    if [ -n "\${FIXTURE_VALIDATION_ARGV:-}" ]; then
      ${shellQuote(process.execPath)} -e 'require("node:fs").writeFileSync(process.env.FIXTURE_VALIDATION_ARGV, JSON.stringify(process.argv.slice(1)))' -- "$@"
    fi
    exit "\${FIXTURE_VALIDATE_EXIT:-0}" ;;
  hammer-predicate-inputs.mjs) log predicate-inputs ;;
  primary-change-context.mjs) echo '{}' ;;
  ama-check.mjs) log "ama-check reviewed=$(printf '%s' "$*" | sed -n 's/.*--reviewed-sha \\([0-9a-f]*\\).*/\\1/p')"; echo '{"eligible":true}' ;;
  hammer-terminal-audit.mjs) log "terminal-audit $*" ;;
  *) exec ${shellQuote(process.execPath)} "$path" "$@" ;;
esac
`, { mode: 0o755 });
  // Synthetic phases keep the real lease contract: acquire in verify-head,
  // release through an EXIT trap and on every refusal, merge on the exact head.
  const phasePrelude = `log() { printf '%s\\n' "$*" >> "$FIXTURE_LOG"; }
ham_release_merge_lease() {
  if [ "\${HAM_MERGE_LEASE_HELD:-0}" = 1 ]; then log "release \${*:-holder} lease=$HAM_MERGE_LEASE_ID"; fi
  HAM_MERGE_LEASE_HELD=0; HAM_MERGE_LEASE_ID=''
  return 0
}
`;
  writeFileSync(join(run, 'hammer-verify-head.sh'), `${phasePrelude}
log "verify-head validated=\${HAM_LOCALLY_VALIDATED_HEAD:-none}"
HAM_MERGE_LEASE_HELD=1; HAM_MERGE_LEASE_ID=ml_fixture; log acquire
trap ham_release_merge_lease EXIT
export POST_REMEDIATION_SHA HAM_PRODUCED_HEAD
POST_REMEDIATION_SHA=$(git rev-parse HEAD); HAM_PRODUCED_HEAD="$POST_REMEDIATION_SHA"; HAM_CURRENT_BASE_SHA="$HAM_REVIEWED_SHA"
if [ "\${FIXTURE_VERIFY_EXIT:-0}" != 0 ]; then HAM_PHASE_OUTCOME=rebase-conflict; ham_release_merge_lease; return "$FIXTURE_VERIFY_EXIT"; fi
if [ -n "\${FIXTURE_NEEDS_REVALIDATION:-}" ] && [ -z "\${HAM_LOCALLY_VALIDATED_HEAD:-}" ]; then HAM_NEEDS_REVALIDATION=true; else HAM_NEEDS_REVALIDATION=false; fi
HAM_PHASE_OUTCOME=verified
return 0
`);
  writeFileSync(join(run, 'hammer-publish.sh'), `${phasePrelude}
log "publish publication-only=\${HAM_COMMIT_PUBLICATION_ONLY:-0} held=\${HAM_MERGE_LEASE_HELD:-0} total=$HAM_AUDIT_REMEDIATED_TOTAL doc=$HAM_DOC_CURRENCY"
[ -s "$HAM_AUDIT_DETAILS_FILE" ] || return 1
if [ "\${HAM_COMMIT_PUBLICATION_ONLY:-0}" != 1 ]; then export HAM_AUDIT_COMMENT_BODY="HAM-Validated-Head: $POST_REMEDIATION_SHA"; fi
HAM_PHASE_OUTCOME=published
return 0
`);
  writeFileSync(join(run, 'hammer-merge.sh'), `${phasePrelude}
if [ "\${1:-}" = --wait-ci ]; then log "wait-ci held=$HAM_MERGE_LEASE_HELD"; HAM_PHASE_OUTCOME=ci-wait-not-needed; return 0; fi
[ "\${HAM_MERGE_LEASE_HELD:-0}" = 1 ] || { HAM_PHASE_OUTCOME=merge-lease-not-held; return 1; }
log "merge-phase held=1 verdict=$(cat "$HAM_VERDICT_FILE")"
if [ -n "\${FIXTURE_MERGE_REFUSE:-}" ]; then HAM_PHASE_OUTCOME=predicate-not-eligible; ham_release_merge_lease; return 20; fi
log "gh pr merge --squash --match-head-commit $POST_REMEDIATION_SHA"
trap - EXIT; ham_release_merge_lease merged
HAM_PHASE_OUTCOME=merged
return 0
`);
  const values = { ROOT_DIR: root, RUN_DIR: run, HQ_ROOT: dir, REPO: 'fixture/repo', PR_NUMBER: '42',
    PR_URL: 'https://github.com/fixture/repo/pull/42', REVIEWED_SHA: shas.reviewed,
    TARGET_REMEDIATION_SHA: shas.reviewed, RISK_CLASS: 'low', MERGE_METHOD: 'squash', HQ_OWNER: 'fixture',
    AUDIT_PATH: join(run, 'audit.json'), REVIEWER: 'codex', AMA_TRAILERS_SHELL: "''" };
  // The real inputs.sh body from Appendix A, rendered with synthetic values.
  const inputs = template.match(/cat > '<<RUN_DIR>>\/inputs\.sh' <<'HAM_INPUTS'\n([\s\S]*?)\nHAM_INPUTS/)[1]
    .replace(/<<([A-Z_]+)>>/g, (_, key) => values[key]);
  writeFileSync(join(run, 'inputs.sh'), `${inputs}\n`);
  writeFileSync(join(run, 'base-head'), shas.reviewed);
  writeFileSync(join(run, 'audit-details.md'), '**Findings addressed**\n- Synthetic correction (blocking): src/example.mjs; fixed\n');
  writeFileSync(join(run, 'terminal-remediation.json'), JSON.stringify({ active: true, commit: {}, auditComment: {} }));
  const plan = { auditDetailsFile: 'audit-details.md', remediated: { total: 1, blocking: 1, nonBlocking: 0 },
    failingTestsFixed: 'suite already green', docCurrency: { status: 'not applicable', reason: 'src/example.mjs: no doc' },
    validationFiles: ['src/example.mjs'] };
  writeFileSync(join(run, 'close-plan.json'), JSON.stringify(plan));
  const env = {
    // A minimal PATH: helpers must resolve from the checkout, not from PATH.
    PATH: '/usr/bin:/bin', HOME: dir, HAM_NODE_BIN: fakeNode, FIXTURE_LOG: log,
    FIXTURE_LIVE_HEAD: liveHead === 'reviewed' ? shas.reviewed : shas.head,
    HQ_LAUNCH_REQUEST_ID: 'lrq_fixture', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  };
  const events = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  const close = (extra = {}) => runDetached(join(root, 'bin/hammer-close.sh'), [join(run, 'close-plan.json')],
    { ...env, ...extra }, checkout).then(result => ({ ...result,
    closeResult: existsSync(join(run, 'close-result.json')) ? JSON.parse(readFileSync(join(run, 'close-result.json'), 'utf8')) : null }));
  return { dir, run, checkout, shas, env, events, close, plan };
}

test('the shipped hammer close runs with no tty and closed stdin, holds the lease through merge and releases it', async t => {
  const f = hammerFixture(t);
  const result = await f.close();
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(result.closeResult.outcome, 'merged');
  assert.equal(result.closeResult.status, 0);
  assert.match(result.stdout, /HAM close result: \{/);
  const events = f.events();
  assert.ok(!events.includes('stdin-is-a-tty'));
  assert.ok(!events.includes('resolve-before-inputs'));
  // Inputs first, then environment, then the controller; never the reverse.
  assert.deepEqual(events.slice(0, 2), ['resolve-environment', 'controller-run hammer-close-controller.sh']);
  const order = ['assert-owner', 'acquire', 'publish publication-only=0 held=1 total=1 doc=not applicable',
    'wait-ci held=1', 'predicate-inputs', `ama-check reviewed=${f.shas.reviewed}`,
    'merge-phase held=1 verdict={"eligible":true}', `gh pr merge --squash --match-head-commit ${f.shas.head}`,
    'release merged lease=ml_fixture'];
  let at = -1;
  for (const event of order) {
    const next = events.indexOf(event, at + 1);
    assert.ok(next > at, `missing or out of order: ${event}\n${events.join('\n')}`);
    at = next;
  }
  assert.equal(events.filter(event => event.startsWith('release ')).length, 1);
  assert.ok(!events.some(event => event.startsWith('publish publication-only=1')), 'no publication when the PR has the head');
  assert.ok(!events.some(event => /--admin/.test(event)));
  // The claim was bound to the exact merged head by the real helper.
  assert.equal(JSON.parse(readFileSync(join(f.run, 'terminal-remediation.json'), 'utf8')).commit.sha, f.shas.head);
});

test('a local commit the PR lacks is published before verify-head; revalidation yields the lease and runs the plan files', async t => {
  const f = hammerFixture(t, { liveHead: 'reviewed' });
  const result = await f.close({ FIXTURE_NEEDS_REVALIDATION: '1' });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const events = f.events();
  const publish = events.indexOf('publish publication-only=1 held=0 total=1 doc=not applicable');
  const firstVerify = events.indexOf('verify-head validated=none');
  assert.ok(publish >= 0 && publish < firstVerify, events.join('\n'));
  const yielded = events.indexOf('release --yield local-validation lease=ml_fixture');
  const validated = events.indexOf('validate --canonical -- src/example.mjs');
  const secondVerify = events.indexOf(`verify-head validated=${f.shas.head}`);
  assert.ok(firstVerify < yielded && yielded < validated && validated < secondVerify, events.join('\n'));
});

test('the launcher resolves an unset or empty Node pin through the real inputs runtime resolver', async t => {
  for (const pin of [undefined, '']) {
    const f = hammerFixture(t);
    const result = await f.close({ HAM_NODE_BIN: pin, AGENT_OS_NODE_BIN: undefined,
      PATH: `${join(f.dir, 'fake-bin')}:/usr/bin:/bin` });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(result.closeResult.outcome, 'merged');
    assert.ok(f.events().includes('resolve-environment'));
  }
});

test('fallback revalidation preserves unusual git paths as individual validator arguments', async t => {
  const f = hammerFixture(t);
  const paths = ['src/with space.mjs', 'src/with\ttab.mjs', 'src/with\nnewline.mjs',
    'src/café.mjs', 'src/with"quote.mjs', 'src/with\\backslash.mjs'];
  for (const path of paths) writeFileSync(join(f.checkout, path), 'export const fixed = true;\n');
  execFileSync('git', ['add', '--', ...paths], { cwd: f.checkout });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--no-verify', '-qm', 'Synthetic unusual paths'], { cwd: f.checkout });
  const { validationFiles: _omitted, ...plan } = f.plan;
  writeFileSync(join(f.run, 'close-plan.json'), JSON.stringify(plan));
  const argvPath = join(f.dir, 'validation-argv.json');
  const result = await f.close({ FIXTURE_NEEDS_REVALIDATION: '1', FIXTURE_VALIDATION_ARGV: argvPath });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const argv = JSON.parse(readFileSync(argvPath, 'utf8'));
  assert.deepEqual(argv.slice(0, 2), ['--canonical', '--']);
  assert.deepEqual(argv.slice(2).sort(), ['src/example.mjs', ...paths].sort());
});

test('a refusal at every stage stops without merge and releases a held lease', async t => {
  for (const [extra, status, outcome, stage, held] of [
    [{ FIXTURE_VERIFY_EXIT: '21' }, 21, 'rebase-conflict', 'hammer-verify-head', true],
    [{ FIXTURE_MERGE_REFUSE: '1' }, 20, 'predicate-not-eligible', 'hammer-merge', true],
    [{ FIXTURE_NEEDS_REVALIDATION: '1', FIXTURE_VALIDATE_EXIT: '1' }, 1, 'targeted-validation-failed', 'local-validation', true],
  ]) {
    const f = hammerFixture(t);
    const result = await f.close(extra);
    assert.equal(result.status, status, `${JSON.stringify(extra)}\n${result.stderr}`);
    assert.equal(result.closeResult.outcome, outcome);
    assert.equal(result.closeResult.stage, stage);
    assert.equal(result.closeResult.leaseHeld, false);
    const events = f.events();
    assert.ok(!events.some(event => event.startsWith('gh pr merge')), events.join('\n'));
    if (held) assert.ok(events.some(event => event.startsWith('release ')), events.join('\n'));
    assert.equal(events.filter(event => event === 'acquire').length,
      events.filter(event => event.startsWith('release ')).length, 'every acquisition is released once');
  }
});

test('the close refuses before any controller or lease when inputs or plan data are missing', async t => {
  const missingInputs = hammerFixture(t);
  rmSync(join(missingInputs.run, 'inputs.sh'));
  let result = await missingInputs.close();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /dispatch-inputs-missing/);
  assert.deepEqual(missingInputs.events(), ['terminal-audit dispatch-inputs-missing']);

  const badPlan = hammerFixture(t);
  writeFileSync(join(badPlan.run, 'close-plan.json'), JSON.stringify({ ...badPlan.plan,
    remediated: { total: 3, blocking: 1, nonBlocking: 1 } }));
  result = await badPlan.close();
  assert.equal(result.status, 65);
  assert.match(result.stderr, /close-plan-invalid: remediated must hold/);
  assert.deepEqual(badPlan.events(), [], 'no environment read, controller or lease');
});

test('close plan data is validated and never carries shell', t => {
  const run = scratch(t, 'hamcontrollerscript-plan-');
  writeFileSync(join(run, 'details.md'), '**Findings addressed**\n');
  const planPath = join(run, 'close-plan.json');
  const plan = { auditDetailsFile: 'details.md', remediated: { total: 0, blocking: 0, nonBlocking: 0 },
    failingTestsFixed: 'suite already green', docCurrency: { status: 'applicable', reason: "it's $(id)" } };
  const parsed = parseClosePlan(JSON.stringify(plan), { planPath, runDir: run });
  assert.equal(parsed.HAM_DOC_CURRENCY_REASON, "it's $(id)");
  for (const [mutation, message] of [
    [{ script: 'echo' }, /unknown keys: script/],
    [{ auditDetailsFile: '../outside.md' }, /does not exist|in HAM_RUN_DIR/],
    [{ docCurrency: { status: 'updated', reason: 'x' } }, /docCurrency.status/],
    [{ docCurrency: { status: 'applicable', reason: 'two\nlines' } }, /docCurrency.reason/],
    [{ validationFiles: ['/etc/passwd'] }, /repository-relative/],
    [{ validationFiles: ['--all'] }, /repository-relative/],
  ]) assert.throws(() => parseClosePlan(JSON.stringify({ ...plan, ...mutation }), { planPath, runDir: run }), message);
});

// ------------------------------------------------------------ helper resolution

test('ham_gh, ham_git and ham_pr resolve to deployed executables with a minimal PATH', async t => {
  const dir = scratch(t, 'hamcontrollerscript-helper-');
  const fakeNode = join(dir, 'node');
  writeFileSync(fakeNode, `#!/bin/sh\nprintf '%s\\n' "$@"\n`, { mode: 0o755 });
  const env = { PATH: '/nonexistent', HAM_NODE_BIN: fakeNode, HAM_REPO: 'fixture/repo', HAM_PR_NUMBER: '42', TMPDIR: dir };
  assert.deepEqual(resolveHammerShellHelper('ham_gh', ['pr', 'comment'], { env }),
    { command: fakeNode, args: [join(HAMMER_SERVICE_ROOT, 'bin/metered-gh.mjs'), 'exec-hammer', 'pr', 'comment'] });
  assert.deepEqual(resolveHammerShellHelper('ham_pr', ['--json', 'state'], { env }).args,
    [join(HAMMER_SERVICE_ROOT, 'bin/hammer-pr-read.mjs'), 'fixture/repo', '42', '--json', 'state']);
  assert.deepEqual(resolveHammerShellHelper('git', ['status'], { env }), { command: 'git', args: ['status'] });
  let stdout = '';
  const status = await runHelperStep({ mode: 'mutation', step: 'no-merge-comment', nominal: 5, ceiling: 5,
    command: 'ham_gh', args: ['pr', 'comment', '42'], env }, {
    budget: nominal => nominal, stdout: text => { stdout += text; }, stderr: () => {},
    report: () => { throw new Error('no failure expected'); },
  });
  assert.equal(status, 0);
  assert.deepEqual(stdout.trim().split('\n'),
    [join(HAMMER_SERVICE_ROOT, 'bin/metered-gh.mjs'), 'exec-hammer', 'pr', 'comment', '42']);
});

// ------------------------------------------------------------ merge-agent close

function mergeFixture(t, { commands, predecessors = '', ciCostExit = 0, leaseExit = 0, validateExit = 0,
  afterController = false } = {}) {
  const dir = scratch(t, 'hamcontrollerscript-merge-');
  const checkout = join(dir, 'checkout');
  const bin = join(dir, 'fake-bin');
  const run = join(dir, 'run');
  mkdirSync(bin); mkdirSync(run);
  const shas = gitRepo(checkout);
  const log = join(dir, 'events.log');
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'node'), `#!/bin/bash
log() { printf '%s\\n' "$*" >> "$FIXTURE_LOG"; }
path="$1"; shift
case "$(basename "$path")" in
  hammer-controller.mjs) log "controller $*" ;;
  merge-lease.mjs)
    case "$1" in
      acquire) log "lease-acquire $*"
        if [ "$FIXTURE_LEASE_EXIT" = 70 ]; then echo '{"parked":true,"reason":"fixture-parked"}'; exit 70; fi
        echo '{"leaseId":"ml_fixture"}' ;;
      release) log "lease-release $*" ;;
      needs-revalidation) echo '{"needsRevalidation":false}' ;;
    esac ;;
  hammer-validate.mjs) log "validate $*"; exit "$FIXTURE_VALIDATE_EXIT" ;;
  ci-cost-check.mjs) log "ci-cost $*"; exit "$FIXTURE_CI_COST_EXIT" ;;
  *) exec ${shellQuote(process.execPath)} "$path" "$@" ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, 'gh'), `#!/bin/bash
printf 'gh %s\\n' "$*" >> "$FIXTURE_LOG"
case "$*" in
  "pr view 42 --repo fixture/repo --json headRefName,body") echo '{"headRefName":"feature","body":""}' ;;
  "pr view 42 --repo fixture/repo --json body --jq"*) printf '%s\\n' "$FIXTURE_PREDECESSORS" ;;
  "pr view 7 --repo fixture/repo --json state --jq"*) echo OPEN ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, 'git'), `#!/bin/bash
case "$1" in
  fetch) printf 'git %s\\n' "$*" >> "$FIXTURE_LOG"; exit 0 ;;
  push) printf 'git %s\\n' "$*" >> "$FIXTURE_LOG"; exit 0 ;;
  rev-parse) if [ "$2" = --verify ]; then echo "$FIXTURE_BASE"; exit 0; fi ;;
esac
exec ${shellQuote(realGit)} "$@"
`, { mode: 0o755 });
  writeFileSync(join(bin, 'hq'), '#!/bin/sh\nprintf \'hq %s\\n\' "$*" >> "$FIXTURE_LOG"\n', { mode: 0o755 });
  writeFileSync(join(run, 'close-commands.json'), JSON.stringify(commands
    ?? { validations: [{ pytest: true, args: ['tests/test_example.py'] }] }));
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, HAM_NODE_BIN: join(bin, 'node'), HAM_RUN_DIR: run,
    FIXTURE_LOG: log, FIXTURE_BASE: shas.reviewed, FIXTURE_PREDECESSORS: predecessors,
    FIXTURE_CI_COST_EXIT: String(ciCostExit), FIXTURE_LEASE_EXIT: String(leaseExit),
    FIXTURE_VALIDATE_EXIT: String(validateExit), GIT_CONFIG_GLOBAL: '/dev/null' };
  let script = join(root, 'bin/merge-agent-close-controller.sh');
  if (afterController) {
    const deployedBin = join(dir, 'deployed', 'bin');
    mkdirSync(deployedBin, { recursive: true });
    for (const helper of ['hammer-node-runtime.sh', 'close-commands.mjs']) {
      writeFileSync(join(deployedBin, helper), readFileSync(join(root, 'bin', helper)));
    }
    const extended = join(deployedBin, 'merge-agent-close-controller.sh');
    writeFileSync(extended, `${readFileSync(script, 'utf8')}\nprintf 'after-controller\\n' >> "$FIXTURE_LOG"\n`);
    script = extended;
  }
  const close = () => runDetached(script,
    ['--repo', 'fixture/repo', '--base', 'main', '--pr', '42', '--commands', join(run, 'close-commands.json')], env, checkout);
  const events = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  return { checkout, shas, close, events };
}

test('the shipped merge-agent controller merges only with --match-head-commit on the validated head', async t => {
  const f = mergeFixture(t);
  const result = await f.close();
  assert.equal(result.status, 0, result.stderr);
  const events = f.events();
  const at = prefix => events.findIndex(event => event.startsWith(prefix));
  assert.ok(at('controller assert-owner') < at('lease-acquire'));
  assert.ok(at('lease-acquire') < at('hq generated-conflicts rebase'));
  assert.ok(at('hq generated-conflicts rebase') < at('validate --pytest -- tests/test_example.py'));
  assert.ok(at('validate') < at('git push --force-with-lease'));
  assert.ok(at('git push') < at('ci-cost'));
  const merge = events.find(event => event.startsWith('gh pr merge'));
  assert.equal(merge, `gh pr merge 42 --repo fixture/repo --squash --auto --match-head-commit ${f.shas.head}`);
  assert.ok(at('gh pr merge') < at('lease-release'));
  assert.match(events.find(event => event.startsWith('lease-release')), /--lease-id ml_fixture/);
  assert.match(events.find(event => event.startsWith('lease-acquire')), new RegExp(`--head ${f.shas.head} .*--owner-pid [1-9]`));
});

test('the shipped merge-agent controller refuses on blockers and releases the lease on every path after acquisition', async t => {
  for (const [options, status, acquired] of [
    [{ predecessors: 'Protects-Against-Unsafe-Merge-Until-PR: #7' }, 75, true],
    [{ ciCostExit: 3 }, 3, true],
    [{ validateExit: 1 }, 1, true],
    [{ leaseExit: 70 }, 70, false],
    [{ commands: { validations: [] } }, 65, false],
    [{ commands: { validations: [{ args: ['ok'], shell: 'rm -rf /' }] } }, 65, false],
  ]) {
    const f = mergeFixture(t, options);
    const result = await f.close();
    const events = f.events();
    assert.equal(result.status, status, `${JSON.stringify(options)}\n${result.stderr}\n${events.join('\n')}`);
    assert.ok(!events.some(event => event.startsWith('gh pr merge')), JSON.stringify(options));
    assert.equal(events.some(event => event.startsWith('lease-acquire')), status !== 65, JSON.stringify(options));
    assert.equal(events.some(event => event.startsWith('lease-release')), acquired, JSON.stringify(options));
  }
});

test('a refused CI cost check exits before a subsequent diagnostic and preserves its status through cleanup', async t => {
  const f = mergeFixture(t, { ciCostExit: 3, afterController: true });
  const result = await f.close();
  assert.equal(result.status, 3, result.stderr);
  const events = f.events();
  assert.ok(events.some(event => event.startsWith('ci-cost ')));
  assert.ok(events.some(event => event.startsWith('lease-release ')));
  assert.ok(!events.some(event => event.startsWith('gh pr merge')));
  assert.ok(!events.includes('after-controller'));
});

test('close commands are argv data for hammer-validate', () => {
  assert.deepEqual(parseCloseCommands(JSON.stringify({ validations: [
    { pytest: true, args: ['tests/a.py'] }, { args: ['npm', 'test'] }] })),
  [['--pytest', '--', 'tests/a.py'], ['--', 'npm', 'test']]);
  for (const bad of ['[]', '{}', '{"validations":[{"args":[]}]}', '{"validations":[{"args":["a\\nb"]}]}',
    '{"validations":[{"pytest":"yes","args":["a"]}]}']) assert.throws(() => parseCloseCommands(bad));
});

// --------------------------------------------------------------- prompt bodies

test('neither closer prompt carries a controller shell body or a tty/stdin read', () => {
  const merge = buildMergeAgentPrompt({ repo: 'fixture/repo', prNumber: 42, baseBranch: 'main', headSha: 'a'.repeat(40) },
    { trigger: FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER });
  for (const prompt of [template, merge]) {
    assert.doesNotMatch(prompt, /close-controller\.sh"|set -euo pipefail|trap cleanup_merge_lease|Write the following complete/);
    assert.doesNotMatch(prompt, /<\s*\/dev\/(?:tty|stdin)|exec [0-9]*<\s*\/dev/);
  }
  assert.match(merge, /'[^']*\/bin\/hammer-controller\.mjs' run '[^']*\/bin\/merge-agent-close-controller\.sh' --repo 'fixture\/repo' --base 'main' --pr '42' --commands "\$HAM_RUN_DIR\/close-commands\.json"/);
  for (const script of ['hammer-close.sh', 'hammer-close-controller.sh', 'merge-agent-close-controller.sh']) {
    const source = readFileSync(join(root, 'bin', script), 'utf8');
    assert.match(source, /^exec 0<\/dev\/null$/m, script);
    assert.doesNotMatch(source, /\/dev\/tty|\/dev\/stdin|read -r[^\n]*<&0/, script);
  }
  // The real hammer merge phase keeps its exact-head, never-admin merge.
  const hammerMerge = readFileSync(join(root, 'bin/hammer-merge.sh'), 'utf8');
  const mergeCall = hammerMerge.match(/exec-hammer pr merge [^\n]*\\\n(?:[^\n]*\\\n)*[^\n]*/)?.[0] ?? '';
  assert.match(mergeCall, /--match-head-commit "\$POST_REMEDIATION_SHA"/);
  assert.doesNotMatch(hammerMerge, /--admin\b(?![^\n]*(?:never|Never|NOT))/);
});

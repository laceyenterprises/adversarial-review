// HAMCONTROLLERSCRIPT-01: the closer's controllers are shipped, tested scripts.
// The model writes only data and runs one command. These synthetic fixtures run
// the shipped scripts with no controlling terminal and a closed stdin, stub only
// the process boundary (node helpers, gh, git remote, hq) and record the order
// of lease, validation and merge side effects.
import test from 'node:test';
import { hammerBootstrapInputs } from './helpers/hammer-bootstrap-inputs.mjs';
import assert from 'node:assert/strict';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runHelperStep } from '../bin/hammer-helper-step.mjs';
import { amaAuditFilePath, readAmaAuditEntry } from '../src/ama/audit.mjs';
import { readDeferredSourceHold } from '../src/ama/deferred-source-custody.mjs';
import { resolveHammerShellHelper, HAMMER_SERVICE_ROOT } from '../src/ama/hammer-shell-helper-command.mjs';
import { parseClosePlan } from '../bin/hammer-close-plan.mjs';
import { parseCloseCommands } from '../bin/close-commands.mjs';
import { buildMergeAgentPrompt, FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER } from '../src/merge-agent-prompt.mjs';
import { hammerQueueInputs } from '../src/finalization/hammer-queue-command.mjs';

const root = resolve(import.meta.dirname, '..');
const template = readFileSync(join(root, 'templates/hammer-prompt.md'), 'utf8');
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

function staticMirrorGh(responses, calls) {
  const routes = Object.entries(responses).flatMap(([path, response]) => {
    if (response === 'unauthorized') {
      return [`${shellQuote(path)}) printf '%s\\n' 'HTTP 401 Unauthorized' >&2; exit 1 ;;`];
    }
    if (!response || response === true) return [];
    return [`${shellQuote(path)}) response=${shellQuote(JSON.stringify(response))} ;;`];
  });
  return `#!/bin/sh
jq -cn '$ARGS.positional' --args -- "$@" >> ${shellQuote(calls)} || { echo 'fixture gh: jq argv capture failed' >&2; exit 97; }
case "\${2-}" in
  ${routes.join('\n  ')}
  *) exit 1 ;;
esac
[ "\${1-}" = api ] || exit 1
shift 2
for arg do
  if [ "$arg" = 'If-None-Match: "fixture"' ]; then
    printf 'HTTP/2.0 304 Not Modified\\n\\n'
    exit 1
  fi
done
printf 'HTTP/2.0 200 OK\\nETag: "fixture"\\n\\n%s\\n' "$response"
`;
}

// Run with no controlling terminal (new session) and file descriptor 0 closed.
function runDetached(script, args, env, cwd, timeoutMs = 20_000) {
  return new Promise(done => {
    const child = spawn('/bin/bash', ['-c', 'exec 0<&-; exec /bin/bash "$@"', 'fixture', script, ...args], {
      env, cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } }, timeoutMs);
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

test('the static validation transport records exact argv and refuses invalid requests', t => {
  const dir = scratch(t, 'hammer-mirror-gh-');
  const executable = join(dir, 'gh');
  const calls = join(dir, 'calls');
  const path = "repos/fixture/repo/content/a'b?ref=abc";
  const response = { content: 'quote "\'\n' };
  writeFileSync(executable, staticMirrorGh({ [path]: response, '/private': 'unauthorized' }, calls), { mode: 0o755 });
  const argv = [
    ['api', path, '--header', 'line one\nline two'],
    ['api', path, '--header', 'If-None-Match: "fixture"'],
    ['api', '/private'],
    ['api', '/missing'],
    ['pr', path],
  ];
  const results = argv.map(args => spawnSync(executable, args, { encoding: 'utf8' }));
  assert.deepEqual(results.map(({ status, stdout, stderr }) => [status, stdout, stderr]), [
    [0, `HTTP/2.0 200 OK\nETag: "fixture"\n\n${JSON.stringify(response)}\n`, ''],
    [1, 'HTTP/2.0 304 Not Modified\n\n', ''],
    [1, '', 'HTTP 401 Unauthorized\n'],
    [1, '', ''],
    [1, '', ''],
  ]);
  assert.deepEqual(readFileSync(calls, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line)), argv);
});

test('the static validation transport diagnoses missing or failing jq', t => {
  const dir = scratch(t, 'hammer-mirror-jq-');
  const executable = join(dir, 'gh');
  writeFileSync(executable, staticMirrorGh({ '/route': { ok: true } }, join(dir, 'calls')), { mode: 0o755 });
  for (const failing of [false, true]) {
    if (failing) writeFileSync(join(dir, 'jq'), '#!/bin/sh\nexit 2\n', { mode: 0o755 });
    const result = spawnSync(executable, ['api', '/route'], {
      encoding: 'utf8', env: { ...process.env, PATH: dir },
    });
    assert.equal(result.status, 97);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /fixture gh: jq argv capture failed/);
  }
});

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

function hammerFixture(t, { liveHead, queue = false } = {}) {
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
  hammer-helper-step.mjs)
    mode="$1"; step="$2"; shift 4
    "$@"; status=$?
    if [ "$mode" = read:report ] && [ "$step" = primary-change-context ] && [ -n "\${FIXTURE_PRIMARY_ERROR:-}" ]; then
      log "terminal-audit primary-change-context-failed"
    fi
    exit "$status" ;;
  hammer-pr-read.mjs)
    log "pr-read $*"
    live="$FIXTURE_LIVE_HEAD"
    if [ -n "\${FIXTURE_REBASE_REMOTE:-}" ]; then live=$(git --git-dir="$FIXTURE_REBASE_REMOTE" rev-parse refs/heads/feature); fi
    printf '{"headRefOid":"%s"}\\n' "$live" ;;
  hammer-controller.mjs)
    case "$1" in
      assert-owner) log assert-owner ;;
      resolve-environment) [ -n "\${HAM_RUN_DIR:-}" ] || { log 'resolve-before-inputs'; exit 125; }; log resolve-environment ;;
      run) shift; ctl="$1"; shift; log "controller-run $(basename "$ctl")"
        if [ -n "\${FIXTURE_TIMEOUT_EXIT:-}" ]; then
          export HAM_CONTROLLER_RECORD="$HAM_RUN_DIR/controller-00000000-0000-0000-0000-000000000000.json"
          /bin/bash "$ctl" "$@" < /dev/null
          status=$?
          if [ -f "$HAM_CONTROLLER_RECORD" ] && [ ! -f "$HAM_RUN_DIR/controller-drained" ]; then
            [ ! -f "$HAM_RUN_DIR/close-result.json" ] || log premature-close-result
            jq '.state = "quiescent" | .drained = true' "$HAM_CONTROLLER_RECORD" > "$HAM_CONTROLLER_RECORD.tmp"
            mv "$HAM_CONTROLLER_RECORD.tmp" "$HAM_CONTROLLER_RECORD"
            : > "$HAM_RUN_DIR/controller-drained"
            log controller-drained
          fi
          exit "$status"
        fi
        exec /bin/bash -c 'IFS= read -r ready || true; source "$@"' hammer-controller "$ctl" "$@" < /dev/null ;;
    esac ;;
  hammer-validate.mjs)
    if [ "$1" = --check-custody ] && [ "\${FIXTURE_CUSTODY_HOLD:-0}" -eq 1 ]; then exit 75; fi
    if [ "$1" = --check-rebase-publication ]; then exec ${shellQuote(process.execPath)} "$path" "$@"; fi
    if [ "$1" = --complete-rebase-publication ]; then
      log complete-publication
      if [ "\${FIXTURE_COMPLETION_FAIL_ALWAYS:-0}" = 1 ]; then exit 1; fi
      if [ -n "\${FIXTURE_COMPLETION_FAIL_ONCE:-}" ] && [ ! -f "$FIXTURE_COMPLETION_FAIL_ONCE" ]; then
        : > "$FIXTURE_COMPLETION_FAIL_ONCE"; exit 1
      fi
      exit 0
    fi
    if [ "$1" != --check-deferred ]; then log "validate $*"; fi
    if [ -n "\${FIXTURE_VALIDATION_REMOTE_HEAD:-}" ] && [ "$1" != --check-deferred ]; then
      printf '%s\\n' "\${HAM_CLOSE_VALIDATION_REMOTE_HEAD:-}" > "$FIXTURE_VALIDATION_REMOTE_HEAD"
    fi
    if [ "\${FIXTURE_REAL_VALIDATE:-0}" = 1 ]; then exec ${shellQuote(process.execPath)} "$path" "$@"; fi
    if [ "$1" = --check-deferred ]; then
      if [ -n "\${FIXTURE_CHECK_DEFERRED_EXIT:-}" ] && ls "$HAM_RUN_DIR"/validation-deferred-*.json >/dev/null 2>&1; then
        exit "$FIXTURE_CHECK_DEFERRED_EXIT"
      fi
      exit 0
    fi
    # MRQ-20: a validator timeout stops the whole controller round once.
    if [ -n "\${FIXTURE_TIMEOUT_ONCE:-}" ] && [ ! -f "$FIXTURE_TIMEOUT_ONCE" ]; then
      : > "$FIXTURE_TIMEOUT_ONCE"; log validation-timeout
      head=$(git rev-parse HEAD)
      if [ -n "\${FIXTURE_REBASE_REMOTE:-}" ]; then
        record=controller-00000000-0000-0000-0000-000000000000.json
        jq -cn --arg head "$head" --arg record "$record" --arg ci "\${FIXTURE_DECLARED_CI:-false}" \
          --arg receipt "$HAM_CLOSE_VALIDATION_RECEIPT" \
          '{schemaVersion:1,head:$head,validation:"unknown",reason:"absolute-timeout",localFailureObserved:false,
            cleanCheckout:true,ciAuthoritative:($ci == "true"),controllerRecord:$record,localValidationReceipt:$receipt}' \
          > "$HAM_RUN_DIR/validation-deferred-$head.json"
        case "\${FIXTURE_VALIDATION_EVIDENCE:-unknown}" in
          failed) printf '{"checks":[{"result":"fail"}]}\\n' ;;
          unreadable) printf '{\\n' ;;
          *) jq -cn --arg head "$head" '{head:$head,selectedCheckCount:1,checks:[{name:"local",result:"pass"}]}' ;;
        esac > "$HAM_CLOSE_VALIDATION_RECEIPT"
        state="\${FIXTURE_DRAIN_STATE:-quiescent}"
        if [ -n "\${FIXTURE_TIMEOUT_EXIT:-}" ]; then state=running; fi
        jq -cn --arg launch "$HQ_LAUNCH_REQUEST_ID" --arg state "$state" \
          '{launchRequestId:$launch,state:$state,reason:"validation-stopped",drained:($state == "quiescent"),leaseCleanup:{released:true}}' \
          > "$HAM_RUN_DIR/$record"
      else
        printf '{"validation":"unknown","reason":"absolute-timeout"}' > "$HAM_RUN_DIR/validation-deferred-$head.json"
      fi
      if [ -n "\${FIXTURE_TIMEOUT_EXIT:-}" ]; then exit "$FIXTURE_TIMEOUT_EXIT"; fi
      kill -TERM "$PPID"; exit 124
    fi
    if [ -n "\${FIXTURE_VALIDATION_ARGV:-}" ]; then
      ${shellQuote(process.execPath)} -e 'require("node:fs").writeFileSync(process.env.FIXTURE_VALIDATION_ARGV, JSON.stringify(process.argv.slice(1)))' -- "$@"
    fi
    if [ -n "\${FIXTURE_VALIDATION_OUTCOME:-}" ]; then
      jq -cn --arg head "$HAM_CLOSE_VALIDATION_HEAD" --arg outcome "$FIXTURE_VALIDATION_OUTCOME" \
        '{head:$head,status:75,outcome:$outcome}' > "$HAM_CLOSE_VALIDATION_RECEIPT"
    fi
    exit "\${FIXTURE_VALIDATE_EXIT:-0}" ;;
  hammer-predicate-inputs.mjs) log predicate-inputs ;;
  hammer-review-handoff.mjs) log "review-handoff $4 $5" ;;
  hammer-queue-handoff.mjs)
    log "queue-handoff head=$POST_REMEDIATION_SHA audit=$HAM_PUBLISHED_AUDIT_HEAD gen=$HAM_QUEUE_ROUTE_GENERATION"
    printf '{"outcome":"%s"}\n' "\${FIXTURE_QUEUE_OUTCOME:-queue-handoff-admitted}" > "$HAM_RUN_DIR/queue-handoff.json"
    exit "\${FIXTURE_QUEUE_EXIT:-0}" ;;
  primary-change-context.mjs)
    if [ -n "\${FIXTURE_PRIMARY_ERROR:-}" ]; then exit 1; fi
    if [ -n "\${FIXTURE_HISTORY_ERROR:-}" ]; then printf '%s\\n' "$FIXTURE_HISTORY_ERROR"; exit 1; fi
    echo '{}' ;;
  ama-check.mjs) log "ama-check reviewed=$(printf '%s' "$*" | sed -n 's/.*--reviewed-sha \\([0-9a-f]*\\).*/\\1/p')"; echo '{"eligible":true}' ;;
  hammer-terminal-audit.mjs)
    log "terminal-audit $*"
    if [ -n "\${FIXTURE_REBASE_REMOTE:-}" ]; then exec ${shellQuote(process.execPath)} "$path" "$@"; fi ;;
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
if [ -n "\${FIXTURE_ADVANCE_REBASE:-}" ] && [ -z "\${HAM_LOCALLY_VALIDATED_HEAD:-}" ]; then
  git -c user.name=Fixture -c user.email=fixture@example.invalid commit -q --allow-empty -m 'Synthetic next head' || return 1
  git push -q "$FIXTURE_REBASE_REMOTE" HEAD:refs/heads/feature || return 1
fi
POST_REMEDIATION_SHA=$(git rev-parse HEAD); HAM_PRODUCED_HEAD="$POST_REMEDIATION_SHA"; HAM_CURRENT_BASE_SHA="$HAM_REVIEWED_SHA"
if [ "\${FIXTURE_VERIFY_EXIT:-0}" != 0 ]; then HAM_PHASE_OUTCOME=rebase-conflict; ham_release_merge_lease; return "$FIXTURE_VERIFY_EXIT"; fi
if [ -n "\${FIXTURE_NEEDS_REVALIDATION:-}" ] && [ -z "\${HAM_LOCALLY_VALIDATED_HEAD:-}" ]; then HAM_NEEDS_REVALIDATION=true; else HAM_NEEDS_REVALIDATION=false; fi
if [ "\${HAM_NEEDS_REVALIDATION:-false}" = true ] && [ "\${FIXTURE_UNSET_POST_SHA:-0}" = 1 ]; then unset POST_REMEDIATION_SHA; fi
HAM_PHASE_OUTCOME=verified
return 0
`);
  writeFileSync(join(run, 'hammer-publish.sh'), `${phasePrelude}
log "publish publication-only=\${HAM_COMMIT_PUBLICATION_ONLY:-0} held=\${HAM_MERGE_LEASE_HELD:-0} total=$HAM_AUDIT_REMEDIATED_TOTAL doc=$HAM_DOC_CURRENCY"
[ -s "$HAM_AUDIT_DETAILS_FILE" ] || return 1
if [ "\${HAM_COMMIT_PUBLICATION_ONLY:-0}" = 1 ] && [ -n "\${FIXTURE_REBASE_REMOTE:-}" ]; then
  [ "$HAM_CLOSE_REBASE_HEAD" = "$(git rev-parse HEAD)" ] || return 1
  git push -q --force-with-lease="refs/heads/feature:$FIXTURE_LIVE_HEAD" "$FIXTURE_REBASE_REMOTE" \
    "$HAM_CLOSE_REBASE_HEAD:refs/heads/feature" || return 1
  HAM_PUSHED_HEAD="$HAM_CLOSE_REBASE_HEAD"
fi
if [ "\${HAM_COMMIT_PUBLICATION_ONLY:-0}" != 1 ]; then export HAM_AUDIT_COMMENT_BODY="HAM-Validated-Head: $POST_REMEDIATION_SHA" HAM_PUBLISHED_AUDIT_HEAD="$POST_REMEDIATION_SHA"; fi
HAM_PHASE_OUTCOME=published
return 0
`);
  writeFileSync(join(run, 'hammer-merge.sh'), `${phasePrelude}
if [ "\${1:-}" = --wait-ci ]; then
  log "wait-ci held=$HAM_MERGE_LEASE_HELD"
  if [ -n "\${FIXTURE_REBASE_REMOTE:-}" ]; then
    log "required-ci head=$POST_REMEDIATION_SHA"
    [ "$POST_REMEDIATION_SHA" = "$(git --git-dir="$FIXTURE_REBASE_REMOTE" rev-parse refs/heads/feature)" ] || return 1
    if [[ "\${FIXTURE_GREEN_HEAD:-}" != any && "$POST_REMEDIATION_SHA" != "\${FIXTURE_GREEN_HEAD:-}" ]]; then
      HAM_PHASE_OUTCOME=required-checks-pending
      return 75
    fi
  fi
  HAM_PHASE_OUTCOME=ci-wait-not-needed
  return 0
fi
[ "\${HAM_MERGE_LEASE_HELD:-0}" = 1 ] || { HAM_PHASE_OUTCOME=merge-lease-not-held; return 1; }
if [ "\${1:-}" = --history-read-abort ]; then
  log "history-read-abort $HAM_HISTORY_READ_ERROR"; HAM_PHASE_OUTCOME=history-read-failed:transient:http-502
  ham_release_merge_lease
  return 1
fi
log "merge-phase held=1 verdict=$(cat "$HAM_VERDICT_FILE")"
if [ -n "\${FIXTURE_LATE_CONFLICTS:-}" ]; then
  attempts=0
  if [ -f "$HAM_RUN_DIR/final-gate-rebases" ]; then read -r attempts < "$HAM_RUN_DIR/final-gate-rebases"; fi
  if [ "$attempts" -lt "$FIXTURE_LATE_CONFLICTS" ]; then
    ham_append_terminal_audit() { log "gate-audit $*"; }
    ham_release_merge_lease --yield final-gate-conflict
    HAM_PHASE_OUTCOME=retry-final-gate-conflict
    return 20
  fi
fi
if [ -n "\${FIXTURE_MERGE_REFUSE:-}" ]; then HAM_PHASE_OUTCOME=predicate-not-eligible; ham_release_merge_lease; return 20; fi
log "gh pr merge --squash --match-head-commit $POST_REMEDIATION_SHA"
trap - EXIT; ham_release_merge_lease merged
HAM_PHASE_OUTCOME=merged
return 0
`);
  const values = { ROOT_DIR: root, RUN_DIR: run, HQ_ROOT: dir, REPO: 'fixture/repo', PR_NUMBER: '42',
    PR_URL: 'https://github.com/fixture/repo/pull/42', REVIEWED_SHA: shas.reviewed,
    TARGET_REMEDIATION_SHA: shas.reviewed, RISK_CLASS: 'low', MERGE_METHOD: 'squash', HQ_OWNER: 'fixture',
    AUDIT_PATH: join(run, 'audit.json'), REVIEWER: 'codex', AMA_TRAILERS_SHELL: "''",
    ...(queue ? { QUEUE_INPUTS: hammerQueueInputs({ routeGeneration: 3, handoffCommand: ['/fixture/queue-handoff'],
      workerId: 'hammer-fixture', workerClass: 'hammer' }) } : {}) };
  // The dispatched inputs.sh body rendered with synthetic values.
  writeFileSync(join(run, 'inputs.sh'), hammerBootstrapInputs(values));
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
  return { dir, run, checkout, shas, env, events, close, plan, bin,
    auditIdentity: { repo: values.REPO, prNumber: Number(values.PR_NUMBER) } };
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
  assert.ok(!events.some(event => event.startsWith('queue-handoff')), 'MRQ-21: a legacy lane never hands off');
  // The claim was bound to the exact merged head by the real helper.
  assert.equal(JSON.parse(readFileSync(join(f.run, 'terminal-remediation.json'), 'utf8')).commit.sha, f.shas.head);
});

test('MRQ-21: a queue-v2 lane hands off the published head and never waits CI, runs the predicate or merges', async t => {
  const f = hammerFixture(t, { queue: true });
  const result = await f.close();
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(result.closeResult.outcome, 'queue-handoff-admitted');
  assert.equal(result.closeResult.stage, 'queue-handoff');
  assert.equal(result.closeResult.postRemediationSha, f.shas.head);
  assert.match(result.stdout, /HAM queue handoff admitted: no closing comment/);
  const events = f.events();
  const order = ['acquire', 'publish publication-only=0 held=1 total=1 doc=not applicable',
    `queue-handoff head=${f.shas.head} audit=${f.shas.head} gen=3`, 'release holder lease=ml_fixture'];
  let at = -1;
  for (const event of order) {
    const next = events.indexOf(event, at + 1);
    assert.ok(next > at, `missing or out of order: ${event}\n${events.join('\n')}`);
    at = next;
  }
  for (const after of ['wait-ci', 'predicate-inputs', 'ama-check', 'merge-phase', 'gh pr merge']) {
    assert.ok(!events.some(event => event.startsWith(after)), `${after} ran on a queue-v2 lane\n${events.join('\n')}`);
  }
  assert.equal(events.filter(event => event.startsWith('release ')).length, 1);
});

test('MRQ-21: an unconfirmed or world-ended handoff stops without merge and releases the lease', async t => {
  for (const [exit, outcome] of [[75, 'queue-handoff-unadmitted'], [20, 'head-changed']]) {
    const f = hammerFixture(t, { queue: true });
    const result = await f.close({ FIXTURE_QUEUE_EXIT: String(exit), FIXTURE_QUEUE_OUTCOME: outcome });
    assert.equal(result.status, exit, `${result.stderr}\n${result.stdout}`);
    assert.equal(result.closeResult.outcome, outcome);
    const events = f.events();
    assert.ok(!events.some(event => /^(wait-ci|ama-check|merge-phase|gh pr merge)/.test(event)), events.join('\n'));
    assert.equal(events.filter(event => event.startsWith('release ')).length, 1);
    assert.doesNotMatch(result.stdout, /no closing comment/);
  }
  // A zero exit without a durable admitted outcome is never success.
  const f = hammerFixture(t, { queue: true });
  const result = await f.close({ FIXTURE_QUEUE_OUTCOME: 'something-else' });
  assert.equal(result.status, 75);
  assert.equal(result.closeResult.outcome, 'something-else');
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

test('outside-lease revalidation binds custody to the live or pushed head without a post-remediation SHA', async t => {
  for (const liveHead of [undefined, 'reviewed']) {
    const f = hammerFixture(t, { liveHead });
    const receipt = join(f.run, 'remote-head');
    const result = await f.close({ FIXTURE_NEEDS_REVALIDATION: '1', FIXTURE_UNSET_POST_SHA: '1',
      FIXTURE_VALIDATION_REMOTE_HEAD: receipt,
      ...(liveHead === 'reviewed' ? { HAM_PUSHED_HEAD: f.shas.head } : {}) });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(readFileSync(receipt, 'utf8').trim(), f.shas.head);
  }
});

function mirrorFixture(t, { entries, runs, manifestFailure, checkFailure, partialChecks, localFailure, remoteDrift, baseDrift, baseFailure, subcontext, duplicateGlobs, currentRegistry, jobDetails, deferJobReadsAfter } = {}) {
  const f = hammerFixture(t);
  const dir = join(f.checkout, 'scripts/ci-mirror');
  const path = 'scripts/ci-mirror/checks.json';
  mkdirSync(dir, { recursive: true });
  const commands = entries.map(([name, fields]) => ({ name, command: `fixture-command ${name}`, ...fields }));
  let manifest = { 'path-glob': { 'src/**': commands },
    'always-on-workflow-coverage': { 'fixture.yml': { mirrored_by: commands.map(check => check.name) } },
    'ratchet-placement': { 'local-only': { 'scripts/host-check.py': 'Requires local state' } } };
  if (duplicateGlobs) manifest['path-glob']['src/*.mjs'] = commands;
  if (currentRegistry) manifest = { checks: Object.fromEntries(commands.map(row => [row.name,
    { runs: ['ci', 'pre-push'], paths: ['src/**'], ...row }])) };
  writeFileSync(join(f.checkout, path), JSON.stringify(manifest));
  const subpath = 'scripts/ci-mirror/checks.adversarial-review.json';
  const submanifest = { 'path-glob': { 'src/**': [
    { name: 'sub-covered', command: 'fixture-command sub-covered', ci_jobs: ['build'] },
    { name: 'sub-local', command: 'fixture-command sub-local' },
  ] } };
  if (subcontext) writeFileSync(join(f.checkout, subpath), JSON.stringify(submanifest));
  writeFileSync(join(dir, 'run-ci-mirror.py'), readFileSync(join(root, 'test/fixtures/ci-mirror-contract.py')));
  const git = (...args) => execFileSync('git', args, { cwd: f.checkout, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  git('add', '--', 'scripts/ci-mirror');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--no-verify', '-qm', 'Synthetic mirror');
  const head = git('rev-parse', 'HEAD');
  const base = f.shas.head;
  const content = (path, data) => ({ type: 'file', path, encoding: 'base64',
    content: Buffer.from(JSON.stringify(data)).toString('base64') });
  const responses = {
    'repos/fixture/repo/pulls/42': { head: { sha: head }, base: { sha: base } },
    [`repos/fixture/repo/contents/${path}?ref=${head}`]: manifestFailure ? null : {
      type: 'file', path, encoding: 'base64',
      content: Buffer.from(JSON.stringify(remoteDrift ? {} : manifest)).toString('base64'),
    },
    [`repos/fixture/repo/contents/${path}?ref=${base}`]: baseFailure ? null : content(path, baseDrift || manifest),
    ...(subcontext ? {
      [`repos/fixture/repo/contents/${subpath}?ref=${head}`]: content(subpath, submanifest),
      [`repos/fixture/repo/contents/${subpath}?ref=${base}`]: content(subpath, submanifest),
    } : {}),
    [`repos/fixture/repo/commits/${head}/check-runs?per_page=100&page=1&filter=latest`]: checkFailure || {
      total_count: (runs || []).length + (partialChecks ? 1 : 0),
      check_runs: (runs || []).map(([name, overrides], index) => ({
        name, head_sha: head, status: 'completed', conclusion: 'success', app: { slug: 'github-actions' },
        details_url: `https://github.com/fixture/repo/actions/runs/123/job/${index + 1}`, ...overrides,
      })),
    },
  };
  if (currentRegistry) for (const [index, [name]] of (runs || []).entries()) {
    responses[`repos/fixture/repo/actions/jobs/${index + 1}`] = jobDetails === false ? null : {
      id: index + 1, run_id: 123, head_sha: head, name, status: 'completed', conclusion: 'success',
      steps: commands.filter(row => row.ci?.job === name).map(row => ({
        name: row.ci.name, status: 'completed', conclusion: 'success',
      })), ...jobDetails,
    };
  }
  const calls = join(f.dir, 'gh-calls');
  const localChecks = join(f.dir, 'local-checks');
  // Only the quota-defer cases need to write dynamic credential state. Most
  // calls replay an already serialized HTTP response and record exact argv.
  const gh = !Number.isInteger(deferJobReadsAfter) ? staticMirrorGh(responses, calls) : `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const [action, path, ...args] = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify([action, path, ...args]) + '\\n');
const response = ${JSON.stringify(responses)}[path];
if (response === 'unauthorized') {
  console.error('HTTP 401 Unauthorized');
  process.exit(1);
}
if (response === true) process.exit(1);
if (action !== 'api' || !response) process.exit(1);
if (args.includes('If-None-Match: "fixture"')) {
  console.log('HTTP/2.0 304 Not Modified\\n');
  process.exit(1);
}
if ((${deferJobReadsAfter} === 0 && path.includes('/check-runs?')) ||
  path.endsWith('/actions/jobs/${deferJobReadsAfter}')) {
  const { createHash } = require('node:crypto');
  const { writeFileSync } = require('node:fs');
  const credential = 'token-' + createHash('sha256').update('synthetic-offline-token').digest('hex').slice(0, 24);
  writeFileSync(process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH, JSON.stringify({
    [credential + '/core']: { credential, resource: 'core', remaining: 100, limit: 5000,
      resetAt: new Date(Date.now() + 60000).toISOString(), observedAt: Date.now() },
  }));
}
console.log('HTTP/2.0 200 OK\\nETag: "fixture"\\n\\n' + JSON.stringify(response));
`;
  writeFileSync(join(f.bin, 'gh'), gh, { mode: 0o755 });
  const validationEnv = {
    PATH: `${f.bin}:${process.env.PATH}`, FIXTURE_LIVE_HEAD: head,
    FIXTURE_NEEDS_REVALIDATION: '1', FIXTURE_REAL_VALIDATE: '1', FIXTURE_LOCAL_CHECKS: localChecks,
    FIXTURE_LOCAL_FAILURE: localFailure, FIXTURE_SUBCONTEXT: subcontext ? '1' : undefined,
    MERGE_AGENT_GH_TOKEN: 'synthetic-offline-token', MERGE_AGENT_GH_TOKEN_EXPIRES_AT: '2099-01-01T00:00:00Z',
    GHO_API_CALL_LOG_DISABLE: '1', GHO_RATE_LIMIT_SHARED_STATE_PATH: join(f.dir, 'quota.json'),
  };
  const run = extra => f.close({ ...validationEnv, ...extra });
  const standalone = (extra, { runDir = f.run, checkout = f.checkout, timeoutMs = 20_000 } = {}) => runDetached('-c', [
    'source "$1/inputs.sh" && exec "$2" "$HAM_ROOT_DIR/bin/hammer-validate.mjs" --canonical -- src/example.mjs',
    'fixture', runDir, process.execPath], { ...f.env, ...validationEnv, ...extra }, checkout, timeoutMs);
  const read = path => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n') : [];
  return { checkout: f.checkout, dir: f.dir, runDir: f.run, head, run, standalone,
    calls: () => read(calls).map(line => JSON.parse(line)),
    lowBudget() {
      const credential = `token-${createHash('sha256').update('synthetic-offline-token').digest('hex').slice(0, 24)}`;
      writeFileSync(join(f.dir, 'quota.json'), JSON.stringify({ [`${credential}/core`]: {
        credential, resource: 'core', remaining: 100, limit: 5000,
        resetAt: new Date(Date.now() + 60_000).toISOString(), observedAt: Date.now(),
      } }));
    },
    local: () => read(localChecks), events: f.events,
    earlyAuditExists: () => existsSync(amaAuditFilePath(f.dir, 'fixture/repo', 42, f.shas.reviewed)) };
}

test('standalone exact-head coverage skips only the authenticated step and hands off a denied local-only guard once', async t => {
  const f = mirrorFixture(t, { currentRegistry: true, entries: [
    ['covered', { ci: { job: 'build', name: 'Run covered' } }],
    ['telegram-responder-guard', { ci: { job: 'build', name: 'Run guard' }, local_only: true }],
    ['later', {}],
  ], runs: [['build']] });
  const env = { FIXTURE_INSPECTION_DENIED: 'telegram-responder-guard', HQ_WORKER_RUN_ID: 'wrun_fixture' };
  const first = await f.standalone(env);
  assert.equal(first.status, 75, first.stderr);
  assert.match(first.stderr, /canonical-validation-deferred: process-inspection-unavailable/);
  assert.match(first.stderr, /cleanup=finished status=75/);
  assert.deepEqual(f.local(), ['fixture-command telegram-responder-guard']);
  const handoffPath = join(f.runDir, `validation-deferred-${f.head}.json`);
  const handoffBytes = readFileSync(handoffPath, 'utf8');
  const handoff = JSON.parse(handoffBytes);
  assert.equal(handoff.outcome, 'deferred');
  assert.equal(handoff.validation, 'unknown');
  const receipt = JSON.parse(readFileSync(handoff.localValidationReceipt, 'utf8'));
  assert.deepEqual(receipt.checks.map(check => [check.name, check.status, check.reason]), [
    ['covered', 'ci-covered', 'exact-head-ci-success'], ['telegram-responder-guard', 'failed', 'local-only'],
  ]);
  assert.equal(receipt.checks[0].jobs[0].step, 'Run covered');
  assert.equal(receipt.checks[1].result, 'inconclusive');
  assert.match(readFileSync(receipt.checks[1].diagnostics[0].path, 'utf8'), /33 reload cases passed/);
  const progress = join(f.dir, 'dispatch/lrq_fixture/hammer-progress/wrun_fixture');
  assert.equal(existsSync(join(progress, 'validation-passed.json')), false);
  assert.equal(existsSync(join(progress, 'validation-failed.json')), false);
  assert.equal(JSON.parse(readFileSync(join(progress, 'last-phase.json'), 'utf8')).reason, 'canonical-validation-deferred');
  const events = f.events();
  const calls = f.calls();
  assert.equal((await f.standalone(env)).status, 75);
  assert.equal((await f.run(env)).status, 75);
  assert.deepEqual(f.local(), ['fixture-command telegram-responder-guard']);
  assert.deepEqual(f.events(), events, 'reentry does not start a controller or acquire a lease');
  assert.deepEqual(f.calls(), calls);
  assert.equal(readFileSync(handoffPath, 'utf8'), handoffBytes);
  const audit = readAmaAuditEntry(f.dir, 'fixture/repo', 42, f.head);
  assert.deepEqual(audit.attempts.map(({ outcome, reason }) => [outcome, reason]),
    [['deferred', 'canonical-validation-deferred']]);
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--no-verify', '--allow-empty', '-qm', 'Changed head'], { cwd: f.checkout });
  const newHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.checkout, encoding: 'utf8' }).trim();
  const inputsPath = join(f.runDir, 'inputs.sh');
  const target = readFileSync(join(f.runDir, 'base-head'), 'utf8').trim();
  writeFileSync(inputsPath, readFileSync(inputsPath, 'utf8').replaceAll(target, newHead));
  assert.equal((await f.standalone({})).status, 0);
  assert.deepEqual(f.local(), ['fixture-command telegram-responder-guard', 'fixture-command covered', 'fixture-command telegram-responder-guard',
    'fixture-command later'], 'a different head runs locally when offered only stale CI');
});

test('standalone CI coverage falls back locally for dirty, stale, ambiguous and invalid evidence', async t => {
  for (const [options, dirty, reason] of [
    [{}, true, 'validation-head-unavailable'],
    [{ runs: [['build', { head_sha: 'f'.repeat(40) }]] }, false, 'ci-job-head-mismatch'],
    [{ runs: [['build'], ['build']] }, false, 'ci-job-ambiguous'],
    [{ baseDrift: {} }, false, 'manifest-base-mismatch'],
  ]) {
    const f = mirrorFixture(t, { entries: [['telegram-responder-guard', { ci_jobs: ['build'] }]], runs: [['build']], ...options });
    if (dirty) writeFileSync(join(f.checkout, 'src/example.mjs'), 'uncommitted fix\n');
    const result = await f.standalone({ FIXTURE_INSPECTION_DENIED: 'telegram-responder-guard' });
    assert.equal(result.status, 75, result.stderr);
    assert.deepEqual(f.local(), ['fixture-command telegram-responder-guard']);
    const handoff = JSON.parse(readFileSync(join(f.runDir, `validation-deferred-${f.head}.json`), 'utf8'));
    const receipt = JSON.parse(readFileSync(handoff.localValidationReceipt, 'utf8'));
    assert.deepEqual(receipt.checks.map(({ reason, result }) => [reason, result]), [[reason, 'inconclusive']]);
    if (dirty) assert.deepEqual(f.calls(), []);
  }
});

test('a different check quoting the Telegram no-verdict line keeps its passing result', async t => {
  const f = mirrorFixture(t, { entries: [['unrelated-test', {}], ['later', {}]], runs: [] });
  const result = await f.standalone({ FIXTURE_INSPECTION_DENIED: 'unrelated-test' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.local(), ['fixture-command unrelated-test', 'fixture-command later']);
  assert.equal(existsSync(join(f.runDir, `validation-deferred-${f.head}.json`)), false);
});

test('a second closer keeps the unpublished repair and does not rerun the broad battery', async t => {
  const f = mirrorFixture(t, { entries: [['broad', {}], ['local-guard', { local_only: true }]], runs: [] });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  const checkout = join(f.dir, 'successor');
  mkdirSync(checkout);
  git(checkout, 'init', '-q');
  git(checkout, 'fetch', '--no-tags', f.checkout, f.head);
  git(checkout, 'checkout', '--quiet', '--detach', 'FETCH_HEAD');
  writeFileSync(join(f.checkout, 'src/example.mjs'), 'export const finalRepair = true;\n');
  git(f.checkout, 'add', 'src/example.mjs');
  git(f.checkout, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Final repair');
  const repaired = git(f.checkout, 'rev-parse', 'HEAD');
  const nextRun = join(f.dir, 'next-run');
  mkdirSync(nextRun);
  const inputs = readFileSync(join(f.runDir, 'inputs.sh'), 'utf8')
    .replaceAll(readFileSync(join(f.runDir, 'base-head'), 'utf8').trim(), f.head);
  writeFileSync(join(f.runDir, 'inputs.sh'), inputs);
  writeFileSync(join(nextRun, 'inputs.sh'), inputs.replaceAll(f.runDir, nextRun));
  writeFileSync(join(nextRun, 'base-head'), f.head);
  const first = await f.standalone({ FIXTURE_CHILD_TIMEOUT: 'broad' });
  assert.equal(first.status, 124, first.stderr);
  assert.deepEqual(f.local(), ['fixture-command broad']);
  const identity = { repo: 'fixture/repo', prNumber: 42, headSha: f.head };
  const hold = readDeferredSourceHold(f.dir, identity);
  rmSync(f.runDir, { recursive: true });
  rmSync(f.checkout, { recursive: true });
  const second = await f.standalone({ FIXTURE_CHILD_TIMEOUT: 'broad', HQ_LAUNCH_REQUEST_ID: 'lrq_successor' },
    { runDir: nextRun, checkout });
  assert.throws(() => git(checkout, 'cat-file', '-e', repaired), 'successor has only the live head');
  assert.deepEqual({ batteries: f.local(), retainedHead: hold?.sourceHead },
    { batteries: ['fixture-command broad'], retainedHead: repaired }, `${first.stderr}\n${second.stderr}`);
  assert.equal(second.status, 75, second.stderr);
  assert.match(second.stderr, /Operator decision required/);
  assert.equal(hold.launchRequestId, 'lrq_fixture');
  const read = name => JSON.parse(readFileSync(join(hold.evidenceDir, name), 'utf8'));
  assert.equal(read('deferred.json').ciAuthoritative, false);
  assert.equal(read('bounded-cleanup.json').cleanup, 'finished');
  assert.equal(read('validation.json').selectedCheckCount, 2);
  assert.equal(read('validation.json').checks[0].result, 'inconclusive');
  const source = read('source.json');
  assert.equal(source.status, 'bundled');
  git(checkout, 'fetch', join(hold.evidenceDir, source.bundle), source.ref);
  assert.equal(git(checkout, 'rev-parse', 'FETCH_HEAD'), repaired, 'recover source after original checkout and scratch are removed');
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), f.head, 'custody neither publishes nor checks out retained source');
});

test('an UNKNOWN budget result can reach required CI only after the local-only guard passes', async t => {
  for (const guardFailed of [false, true]) {
    const f = mirrorFixture(t, { entries: [['covered', { ci_jobs: ['build'] }],
      ['guard', { ci_jobs: ['build'], local_only: true }], ['last', {}]], runs: [['build']] });
    const config = join(f.dir, 'config.yaml');
    writeFileSync(config, 'version: 1\nroles:\n  adversarial:\n    merge_authority:\n      required_check_contexts: [build]\n');
    const result = await f.standalone({ AGENT_OS_CONFIG_PATH: config, FIXTURE_BUDGET_AFTER_CHECKS: '1', FIXTURE_MULTI_BATCH: '1',
      HQ_WORKER_RUN_ID: 'wrun_fixture',
      ...(guardFailed ? { FIXTURE_FAILED_GUARD: 'guard', FIXTURE_CHILD_TIMEOUT: 'last' } : {}) }, { timeoutMs: 60_000 });
    const handoffPath = join(f.runDir, `validation-deferred-${f.head}.json`);
    assert.ok(existsSync(handoffPath), `${result.status}: ${result.stderr}\n${result.stdout}`);
    const handoff = JSON.parse(readFileSync(handoffPath, 'utf8'));
    const receipt = JSON.parse(readFileSync(handoff.localValidationReceipt, 'utf8'));
    assert.equal(receipt.selectedCheckCount, 3);
    assert.deepEqual(f.local(), ['fixture-command guard', 'fixture-command last']);
    assert.equal(receipt.checks[0].status, 'ci-covered');
    assert.equal(receipt.checks[1].reason, 'local-only');
    assert.equal(receipt.checks[1].result, guardFailed ? 'fail' : 'pass');
    assert.equal(receipt.validation, 'unknown');
    assert.equal(handoff.ciAuthoritative, !guardFailed);
    assert.equal(result.status, guardFailed ? 124 : 0, result.stderr);
    const phase = JSON.parse(readFileSync(join(f.dir,
      'dispatch/lrq_fixture/hammer-progress/wrun_fixture/last-phase.json'), 'utf8'));
    assert.equal(phase.reason, guardFailed ? 'canonical-validation-deferred'
      : 'local-validation-unknown-github-required-gate-authoritative');
    const identity = { repo: 'fixture/repo', prNumber: 42,
      headSha: readFileSync(join(f.runDir, 'base-head'), 'utf8').trim() };
    const retained = readDeferredSourceHold(f.dir, identity, { includeContinued: true });
    assert.equal(Boolean(retained.continuedAt), !guardFailed);
    assert.equal(Boolean(readDeferredSourceHold(f.dir, identity)), guardFailed);
    if (!guardFailed) {
      const closed = await f.run({ AGENT_OS_CONFIG_PATH: config });
      assert.equal(closed.status, 0, `${closed.stderr}\n${closed.stdout}`);
      assert.equal(closed.closeResult.outcome, 'merged');
      assert.ok(f.events().includes(`gh pr merge --squash --match-head-commit ${f.head}`));
      assert.deepEqual(f.local(), ['fixture-command guard', 'fixture-command last'],
        'the shipped close preflight and controller reuse the qualifying UNKNOWN receipt');
    }
  }
});

test('an inconclusive conflict replay holds the captured remote source head', async t => {
  const f = mirrorFixture(t, { entries: [['broad', {}]], runs: [] });
  const git = (...args) => execFileSync('git', args, { cwd: f.checkout, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--no-verify', '--allow-empty', '-qm', 'Synthetic conflict replay');
  const replay = git('rev-parse', 'HEAD');
  const dispatch = readFileSync(join(f.runDir, 'base-head'), 'utf8').trim();
  assert.notEqual(dispatch, f.head);
  writeFileSync(join(f.runDir, 'conflict-repair-publish.env'), `source=${f.head}\nhead=${replay}\nbranch=feature\n`);
  await f.standalone({ FIXTURE_CHILD_TIMEOUT: 'broad' });
  const identity = { repo: 'fixture/repo', prNumber: 42 };
  assert.equal(readDeferredSourceHold(f.dir, { ...identity, headSha: f.head })?.sourceHead, replay);
  assert.equal(readDeferredSourceHold(f.dir, { ...identity, headSha: dispatch }), null);
});

test('MRQ-20: a timeout that cannot defer to CI gets no second controller round', async t => {
  const f = hammerFixture(t);
  const result = await f.close({ FIXTURE_NEEDS_REVALIDATION: '1', FIXTURE_TIMEOUT_ONCE: join(f.dir, 'timed-out'),
    FIXTURE_CHECK_DEFERRED_EXIT: '75' });
  assert.notEqual(result.status, 0);
  assert.equal(result.closeResult, null);
  assert.match(result.stdout, /"outcome":"canonical-validation-deferred"/);
  const events = f.events();
  assert.equal(events.filter(event => event.startsWith('controller-run ')).length, 1, events.join('\n'));
  assert.equal(events.some(event => event.startsWith('gh pr merge')), false);
});

function conflictRebaseFixture(t, { declared = true } = {}) {
  const f = hammerFixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: f.checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...f.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim();
  const remote = join(f.dir, 'remote.git');
  git('init', '-q', '--bare', remote);
  git('push', '-q', remote, 'HEAD:refs/heads/feature');
  git('checkout', '-qb', 'upstream', f.shas.reviewed);
  mkdirSync(join(f.checkout, 'src'), { recursive: true });
  writeFileSync(join(f.checkout, 'src/example.mjs'), 'export const upstream = true;\n');
  git('add', 'src/example.mjs');
  git('commit', '-qm', 'Synthetic upstream change');
  git('checkout', '-q', '--detach', f.shas.head);
  assert.throws(() => git('rebase', 'upstream'));
  writeFileSync(join(f.checkout, 'src/example.mjs'), 'export const fixed = true, upstream = true;\n');
  git('add', 'src/example.mjs');
  git('-c', 'core.editor=true', 'rebase', '--continue');
  const head = git('rev-parse', 'HEAD');
  writeFileSync(join(f.run, 'conflict-repair-publish.env'), `source=${f.shas.head}\nhead=${head}\nbranch=feature\n`);
  const config = join(f.dir, 'config.yaml');
  writeFileSync(config, declared
    ? 'version: 1\nroles:\n  adversarial:\n    merge_authority:\n      required_check_contexts: [unit]\n'
    : 'version: 1\n');
  const close = (extra = {}) => f.close({ FIXTURE_REBASE_REMOTE: remote, AGENT_OS_CONFIG_PATH: config,
    FIXTURE_DECLARED_CI: String(declared), ...extra });
  return { ...f, close, head, remoteHead: () => git(`--git-dir=${remote}`, 'rev-parse', 'refs/heads/feature'),
    timeout: join(f.dir, 'timed-out') };
}

for (const mode of ['clean', 'semantic-conflict', 'cap', 'changed-patch', 'custody-hold']) {
  test(`CLOSERCONFLICT-01 final gate recovery: ${mode}`, async t => {
    const f = hammerFixture(t);
    const gitEnv = { ...f.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
    const git = (...args) => execFileSync('git', args, {
      cwd: f.checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv,
    }).trim();
    const remote = join(f.dir, 'remote.git');
    git('init', '-q', '--bare', remote);
    git('remote', 'add', 'origin', remote);
    let source = f.shas.head;
    if (mode === 'changed-patch') {
      writeFileSync(join(f.checkout, 'duplicate.txt'), 'landed on both sides\n');
      git('add', 'duplicate.txt');
      git('commit', '-qm', 'Shared change');
      source = git('rev-parse', 'HEAD');
    }
    git('push', '-q', 'origin', 'HEAD:refs/heads/feature');
    git('checkout', '-qb', 'upstream', f.shas.reviewed);
    if (mode === 'semantic-conflict') {
      mkdirSync(join(f.checkout, 'src'));
      writeFileSync(join(f.checkout, 'src/example.mjs'), 'export const upstream = true;\n');
      git('add', 'src/example.mjs');
    } else if (mode === 'changed-patch') {
      writeFileSync(join(f.checkout, 'duplicate.txt'), 'landed on both sides\n');
      git('add', 'duplicate.txt');
    } else {
      writeFileSync(join(f.checkout, 'upstream.txt'), 'base only\n');
      git('add', 'upstream.txt');
    }
    git('commit', '-qm', 'Synthetic base advancement');
    const base = git('rev-parse', 'HEAD');
    git('push', '-q', 'origin', 'HEAD:refs/heads/main');
    git('checkout', '-q', '--detach', source);
    const inputs = join(f.run, 'inputs.sh');
    writeFileSync(inputs, `${readFileSync(inputs, 'utf8')}
ham_bounded_git_sync() { git fetch -q origin "$@"; }
ham_pr() {
  printf '{"state":"OPEN","isDraft":false,"headRefOid":"%s","baseRefName":"main","headRefName":"feature"}\\n' \
    "$(git --git-dir="$FIXTURE_REBASE_REMOTE" rev-parse refs/heads/feature)"
}
`);
    const result = await f.close({ ...gitEnv, FIXTURE_LIVE_HEAD: source, FIXTURE_REBASE_REMOTE: remote,
      FIXTURE_CUSTODY_HOLD: mode === 'custody-hold' ? '1' : '0',
      FIXTURE_GREEN_HEAD: 'any', FIXTURE_LATE_CONFLICTS: mode === 'cap' ? '3' : '1' });
    const expected = { clean: [0, 'merged'], 'semantic-conflict': [21, 'needs-rebase-repair'],
      cap: [20, 'needs-rebase-repair'], 'changed-patch': [20, 'exact-head-review-required'],
      'custody-hold': [75, 'canonical-validation-deferred'] }[mode];
    assert.deepEqual([result.status, result.closeResult?.outcome], expected, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.closeResult.leaseHeld, false);
    const events = f.events();
    const remoteHead = git(`--git-dir=${remote}`, 'rev-parse', 'refs/heads/feature');
    if (mode === 'semantic-conflict') {
      assert.equal(remoteHead, source);
      assert.match(events.join('\n'), /gate-audit deferred needs-rebase-repair/);
      assert.equal(git('diff', '--name-only', '--diff-filter=U'), 'src/example.mjs');
    } else if (mode === 'custody-hold') {
      assert.equal(remoteHead, source);
      assert.ok(events.includes('gate-audit deferred canonical-validation-deferred'));
      assert.match(result.stderr, /HAM conflict repair: canonical-validation-deferred/);
    } else {
      assert.notEqual(remoteHead, source);
      git('merge-base', '--is-ancestor', base, remoteHead);
      const yieldIndex = events.indexOf('release --yield final-gate-conflict lease=ml_fixture');
      const validateIndex = events.findIndex(event => event.startsWith('validate '));
      const pushIndex = events.findIndex(event => event.startsWith('publish publication-only=1 held=0'));
      assert.ok(yieldIndex >= 0 && yieldIndex < validateIndex && validateIndex < pushIndex, events.join('\n'));
    }
    const merges = events.filter(event => event.startsWith('gh pr merge'));
    assert.deepEqual(merges, mode === 'clean' ? [`gh pr merge --squash --match-head-commit ${remoteHead}`] : []);
    if (mode === 'cap') assert.equal(readFileSync(join(f.run, 'final-gate-rebases'), 'utf8'), '2\n');
    if (mode === 'changed-patch') assert.ok(events.includes(`review-handoff ${remoteHead} --exact-head`));
  });
}

test('a drained validation timeout publishes the repaired rebase and waits on CI for that exact head', async t => {
  for (const green of [false, true]) {
    const f = conflictRebaseFixture(t);
    const result = await f.close({ FIXTURE_TIMEOUT_ONCE: f.timeout, FIXTURE_NEEDS_REVALIDATION: '1',
      FIXTURE_GREEN_HEAD: green ? f.head : f.shas.head });
    assert.equal(result.status, green ? 0 : 75, result.stderr);
    assert.equal(result.closeResult.outcome, green ? 'merged' : 'required-checks-pending');
    assert.equal(f.remoteHead(), f.head);
    const events = f.events();
    const publish = events.findIndex(event => event.startsWith('publish publication-only=1 held=0'));
    assert.ok(publish > events.indexOf('validation-timeout'), events.join('\n'));
    assert.ok(events.indexOf(`required-ci head=${f.head}`) > publish, events.join('\n'));
    assert.equal(events.filter(event => event.startsWith('validate ')).length, 1);
    assert.equal(events.includes(`gh pr merge --squash --match-head-commit ${f.head}`), green);
  }
});

test('post-publication completion retries a transient failure without pushing again', async t => {
  const f = conflictRebaseFixture(t);
  const result = await f.close({ FIXTURE_TIMEOUT_ONCE: f.timeout,
    FIXTURE_COMPLETION_FAIL_ONCE: join(f.dir, 'completion-failed'), FIXTURE_GREEN_HEAD: f.head });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.closeResult.outcome, 'merged');
  assert.equal(f.remoteHead(), f.head);
  assert.equal(f.events().filter(event => event === 'complete-publication').length, 2);
  assert.equal(f.events().filter(event => event.startsWith('publish publication-only=1')).length, 1);
});

test('post-publication custody failure defers with status 75 after three attempts', async t => {
  const f = conflictRebaseFixture(t);
  const result = await f.close({ FIXTURE_TIMEOUT_ONCE: f.timeout,
    FIXTURE_COMPLETION_FAIL_ALWAYS: '1', FIXTURE_GREEN_HEAD: f.head });
  assert.equal(result.status, 75, result.stderr);
  assert.equal(result.closeResult.status, 75);
  assert.equal(result.closeResult.outcome, 'canonical-validation-deferred');
  assert.equal(f.remoteHead(), f.head);
  const events = f.events();
  assert.equal(events.filter(event => event === 'complete-publication').length, 3);
  assert.equal(events.filter(event => event.startsWith('publish publication-only=1')).length, 1);
  assert.equal(events.some(event => event.startsWith('gh pr merge')), false);
});

test('a passing conflict repair reuses validation only on the same published head', async t => {
  for (const moved of [false, true]) {
    const f = conflictRebaseFixture(t);
    const result = await f.close({ FIXTURE_NEEDS_REVALIDATION: '1', FIXTURE_GREEN_HEAD: f.head,
      FIXTURE_ADVANCE_REBASE: moved ? '1' : '' });
    const events = f.events();
    assert.equal(result.status, moved ? 75 : 0, result.stderr);
    assert.equal(events.filter(event => event.startsWith('validate ')).length, moved ? 2 : 1, events.join('\n'));
    assert.ok(events.includes(`verify-head validated=${f.remoteHead()}`), events.join('\n'));
  }
});

test('conflict-repair timeout or load stop leaves publication to a fresh round after supervisor drain', async t => {
  for (const status of [75, 124, 137, 143]) {
    const f = conflictRebaseFixture(t);
    const result = await f.close({ FIXTURE_TIMEOUT_ONCE: f.timeout, FIXTURE_TIMEOUT_EXIT: String(status),
      FIXTURE_GREEN_HEAD: f.head });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.remoteHead(), f.head);
    const events = f.events();
    assert.equal(events.filter(event => event.startsWith('controller-run ')).length, 2);
    assert.equal(events.includes('premature-close-result'), false);
    assert.ok(events.indexOf('controller-drained') < events.findIndex(event => event.startsWith('publish ')));
  }
});

test('a genuine local failure, an undrained round or unreadable evidence blocks rebase publication', async t => {
  for (const scenario of ['failure', 'undrained', 'failed', 'unreadable']) {
    const f = conflictRebaseFixture(t);
    const result = await f.close(scenario === 'failure' ? { FIXTURE_VALIDATE_EXIT: '42' }
      : { FIXTURE_TIMEOUT_ONCE: f.timeout,
        FIXTURE_DRAIN_STATE: scenario === 'undrained' ? 'cleanup-unconfirmed' : 'quiescent',
        FIXTURE_VALIDATION_EVIDENCE: scenario });
    assert.notEqual(result.status, 0);
    if (scenario === 'failure') {
      assert.equal(result.closeResult.outcome, 'targeted-validation-failed');
    } else {
      assert.match(result.stdout, /"outcome":"source-publication-refused"/);
      const events = f.events();
      const repeated = await f.close({ FIXTURE_CHECK_DEFERRED_EXIT: '75' });
      assert.equal(repeated.status, 1, repeated.stderr);
      assert.match(repeated.stdout, /"outcome":"source-publication-refused"/);
      assert.deepEqual(f.events(), events);
    }
    assert.equal(f.remoteHead(), f.shas.head);
    assert.ok(!f.events().some(event => /^(publish|wait-ci|gh pr merge)/.test(event)));
    assert.equal(f.events().filter(event => event.startsWith('controller-run ')).length, 1);
  }
});

test('a published rebase without declared CI authority leaves a durable watcher continuation', async t => {
  const f = conflictRebaseFixture(t, { declared: false });
  const result = await f.close({ FIXTURE_TIMEOUT_ONCE: f.timeout });
  assert.equal(result.status, 75, result.stderr);
  assert.equal(result.closeResult.outcome, 'canonical-validation-deferred');
  assert.equal(result.closeResult.postRemediationSha, f.head);
  assert.equal(f.remoteHead(), f.head);
  assert.ok(!f.events().some(event => /^(acquire|wait-ci|gh pr merge)/.test(event)));
  const audit = readAmaAuditEntry(f.dir, f.auditIdentity.repo, f.auditIdentity.prNumber, f.head);
  const [attempt] = audit.attempts;
  assert.equal(attempt.outcome, 'deferred');
  assert.deepEqual(attempt.continuation, { kind: 'redrive', owner: 'watcher', headSha: f.head,
    notBefore: attempt.continuation.notBefore, lease: 'fresh' });
  assert.ok(Number.isFinite(Date.parse(attempt.continuation.notBefore)));
});

test('close controller hands off denied validation after one lease yield', async t => {
  const f = mirrorFixture(t, { entries: [['telegram-responder-guard', { local_only: true }]], runs: [] });
  const result = await f.run({ FIXTURE_INSPECTION_DENIED: 'telegram-responder-guard' });
  assert.equal(result.status, 75, result.stderr);
  assert.equal(result.closeResult.outcome, 'canonical-validation-deferred');
  assert.equal(result.closeResult.leaseHeld, false);
  const events = f.events();
  assert.deepEqual(events.filter(event => event.startsWith('release ')), ['release --yield local-validation lease=ml_fixture']);
  assert.equal(events.some(event => event.startsWith('gh pr merge')), false);
  assert.equal((await f.run()).status, 75);
  assert.deepEqual(f.events(), events);
});

test('the close skips only explicitly mapped, successful exact-head mirror checks and reports each decision', async t => {
  const f = mirrorFixture(t, {
    entries: [
      ['covered', { ci_jobs: ['build', 'lint'] }], ['skipped', { ci_jobs: ['skipped', 'build'] }],
      ['neutral', { ci_jobs: ['neutral'] }], ['old', { ci_jobs: ['old'] }],
      ['unmapped', {}], ['host', { ci_jobs: ['build'], local_only: true }],
      ['missing', { ci_jobs: ['missing'] }], ['duplicate', { ci_jobs: ['duplicate'] }],
      ['wrong-app', { ci_jobs: ['wrong-app'] }],
      ['ratchet', { ci_jobs: ['build'], command: 'python3 scripts/host-check.py' }],
    ],
    runs: [
      ['build'], ['lint'], ['skipped', { conclusion: 'skipped' }], ['neutral', { conclusion: 'neutral' }],
      ['old', { head_sha: 'a'.repeat(40) }], ['duplicate'], ['duplicate', { status: 'in_progress' }],
      ['wrong-app', { app: { slug: 'other-app' } }],
    ],
  });
  const result = await f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.local(), [...['skipped', 'neutral', 'old', 'unmapped', 'host', 'missing', 'duplicate', 'wrong-app']
    .map(name => `fixture-command ${name}`), 'python3 scripts/host-check.py']);
  const [receipt] = result.closeResult.localValidation;
  assert.equal(receipt.head, f.head);
  assert.deepEqual(receipt.checks[0], { name: 'covered', cwd: null, status: 'ci-covered',
    commandSha256: createHash('sha256').update('fixture-command covered').digest('hex'),
    manifest: 'scripts/ci-mirror/checks.json',
    manifestSha256: createHash('sha256').update(readFileSync(join(f.checkout, 'scripts/ci-mirror/checks.json'))).digest('hex'),
    reason: 'exact-head-ci-success', jobs: [{ name: 'build', runId: '123' }, { name: 'lint', runId: '123' }] });
  assert.deepEqual(receipt.checks.slice(1).map(row => [row.status, row.reason]), [
    ['run', 'ci-job-skipped'], ['run', 'ci-job-neutral'], ['run', 'ci-job-head-mismatch'], ['run', 'no-ci-mapping'],
    ['run', 'local-only'], ['run', 'ci-job-missing'], ['run', 'ci-job-ambiguous'],
    ['run', 'ci-job-identity-unverified'], ['run', 'local-only'],
  ]);
  assert.equal(f.calls().length, 4);
  assert.equal((await f.run()).status, 0);
  assert.ok(f.calls().slice(4).every(call => call.includes('If-None-Match: "fixture"')));
});

test('a repository with workflow-level coverage alone runs the selected battery without coverage requests', async t => {
  const f = mirrorFixture(t, { entries: [['verify', {}]], runs: [['verify']] });
  const result = await f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.local(), ['fixture-command verify']);
  assert.deepEqual(f.calls(), []);
  assert.equal(result.closeResult.localValidation[0].checks[0].reason, 'no-ci-mapping');
});

test('a non-matching skip probe executes the check locally and reports its actual failure', async t => {
  const f = mirrorFixture(t, { entries: [['verify', { ci_jobs: ['build'] }]],
    runs: [['build']], localFailure: 'verify' });
  const result = await f.run({ FIXTURE_SKIP_REASON: 'prefixed: ci-covered' });
  assert.equal(result.status, 75, result.stderr);
  assert.deepEqual(f.local(), ['fixture-command verify']);
  assert.deepEqual(result.closeResult.localValidation[0].checks, [{
    name: 'verify', cwd: null, status: 'failed', reason: 'ci-evidence-unavailable',
    commandSha256: createHash('sha256').update('fixture-command verify').digest('hex'),
    result: 'inconclusive', localReason: 'synthetic timeout',
  }]);
});

test('upstream signatures retain evidence across duplicate selection and submodule contexts', async t => {
  const f = mirrorFixture(t, { entries: [['covered', { ci_jobs: ['build'] }]],
    runs: [['build']], subcontext: true, duplicateGlobs: true });
  const result = await f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.local(), ['fixture-command sub-local']);
  assert.deepEqual(result.closeResult.localValidation[0].checks.map(({ name, cwd, status }) => ({ name, cwd, status })), [
    { name: 'covered', cwd: null, status: 'ci-covered' },
    { name: 'sub-covered', cwd: 'tools/adversarial-review', status: 'ci-covered' },
    { name: 'sub-local', cwd: 'tools/adversarial-review', status: 'run' },
  ]);
});

test('a module-level mirror refusal preserves the environment failure without claiming coverage', async t => {
  const f = mirrorFixture(t, { entries: [['covered', { ci_jobs: ['build'] }]], runs: [['build']] });
  const result = await f.run({ FIXTURE_IMPORT_EXIT: '76' });
  assert.equal(result.status, 76, result.stderr);
  assert.equal(result.closeResult.outcome, 'canonical-validation-deferred');
  assert.deepEqual(f.local(), []);
  assert.deepEqual(result.closeResult.localValidation[0].checks.map(row => [row.status, row.reason, row.exitStatus]), [
    ['interrupted', 'canonical-mirror-environment-unavailable', 76],
  ]);
});

test('coverage reads preserve the reserved budget and fall back locally below the polling floor', async t => {
  const f = mirrorFixture(t, { entries: [['verify', { ci_jobs: ['build'] }]], runs: [['build']] });
  f.lowBudget();
  const result = await f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), []);
  assert.deepEqual(f.local(), ['fixture-command verify']);
  assert.equal(result.closeResult.localValidation[0].checks[0].reason, 'ci-budget-deferred');
});

test('PR changes to local-only markers or CI mappings cannot grant coverage', async t => {
  for (const fields of [{ local_only: true, ci_jobs: ['build'] }, { ci_jobs: ['trusted'] }]) {
    const f = mirrorFixture(t, { entries: [['verify', { ci_jobs: ['build'] }]], runs: [['build']],
      baseDrift: { 'path-glob': { 'src/**': [{ name: 'verify', command: 'fixture-command verify', ...fields }] } } });
    const result = await f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.local(), ['fixture-command verify']);
    assert.equal(result.closeResult.localValidation[0].checks[0].reason, 'manifest-base-mismatch');
    assert.ok(f.calls().every(call => !call[1].includes('/check-runs')));
  }
});

test('unreadable evidence, changed manifests and the off switch retain local validation and its failure outcome', async t => {
  const scenarios = [
    [{ manifestFailure: true }, {}, 'manifest-read-failed'],
    [{ remoteDrift: true }, {}, 'manifest-head-mismatch'],
    [{ baseDrift: {} }, {}, 'manifest-base-mismatch'],
    [{ baseFailure: true }, {}, 'manifest-read-failed'],
    [{ checkFailure: true }, {}, 'ci-check-read-failed'],
    [{ checkFailure: 'unauthorized' }, {}, 'ci-check-read-failed'],
    [{ partialChecks: true }, {}, 'ci-check-read-failed'],
    [{}, { HAM_LOCAL_VALIDATION_CI_DEDUP: '0' }, 'ci-dedup-disabled'],
  ];
  for (const [options, env, reason] of scenarios) {
    const f = mirrorFixture(t, { entries: [['verify', { ci_jobs: ['build'] }]], runs: [['build']],
      localFailure: 'verify', ...options });
    const result = await f.run(env);
    assert.equal(result.status, 75, result.stderr);
    // MRQ-20: an inconclusive mirror check (exit 75) is UNKNOWN, never a pass;
    // with no declared required contexts it keeps the canonical deferral.
    assert.equal(result.closeResult.outcome, 'canonical-validation-deferred');
    assert.equal(result.closeResult.stage, 'local-validation');
    assert.deepEqual(f.local(), ['fixture-command verify']);
    assert.deepEqual(result.closeResult.localValidation[0].checks, [{
      name: 'verify', cwd: null, status: 'failed',
      commandSha256: createHash('sha256').update('fixture-command verify').digest('hex'), reason, result: 'inconclusive', localReason: 'synthetic timeout',
    }]);
    assert.ok(!f.events().some(event => event.startsWith('wait-ci') || event.startsWith('gh pr merge')));
    assert.equal(f.earlyAuditExists(), false, 'optional reads must not write a terminal audit');
    if (reason === 'ci-dedup-disabled') assert.deepEqual(f.calls(), []);
  }
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
    [{ FIXTURE_NEEDS_REVALIDATION: '1', FIXTURE_VALIDATE_EXIT: '78' }, 78, 'validation-environment-failed', 'local-validation', true],
    [{ FIXTURE_NEEDS_REVALIDATION: '1', FIXTURE_VALIDATE_EXIT: '75', FIXTURE_VALIDATION_OUTCOME: 'harness-fault:socket-path' },
      75, 'harness-fault:socket-path', 'local-validation', true],
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

test('the close passes failed history evidence to the abort audit before deleting it', async t => {
  const f = hammerFixture(t);
  const reason = 'history read failed: history-read-failed:transient:http-502 attempts=5 fixture';
  const result = await f.close({ FIXTURE_HISTORY_ERROR: JSON.stringify({ historyReadFailed: true, reason }) });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.closeResult.outcome, 'history-read-failed:transient:http-502');
  assert.ok(f.events().includes(`history-read-abort ${reason}`));
  assert.ok(!f.events().some(event => event.startsWith('ama-check') || event.startsWith('gh pr merge')));
  assert.equal(f.events().filter(event => event.startsWith('release ')).length, 1);
});

test('primary-change failure without history evidence retains a terminal audit', async t => {
  const f = hammerFixture(t);
  const result = await f.close({ FIXTURE_PRIMARY_ERROR: '1' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.closeResult.outcome, 'primary-change-context-failed');
  assert.ok(f.events().includes('terminal-audit primary-change-context-failed'));
});

test('primary-change helper reports missing evidence but leaves classified history to the controller', async () => {
  for (const [output, expectedReports] of [
    ['', ['primary-change-context-failed']],
    [JSON.stringify({ historyReadFailed: true, reason: 'history read failed: history-read-failed:transient:http-502 attempts=5 fixture' }), []],
  ]) {
    const reports = [];
    const status = await runHelperStep({ mode: 'read:report', step: 'primary-change-context',
      nominal: 5, ceiling: 5, command: process.execPath,
      args: ['-e', 'process.stdout.write(process.argv[1]); process.exitCode = 1', output] }, {
      budget: () => 5, report: reason => { reports.push(reason); }, stderr: () => {}, stdout: () => {},
    });
    assert.equal(status, 1);
    assert.deepEqual(reports, expectedReports);
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
  afterController = false, movedSource = false, prTitle = 'Synthetic change', prBody = 'Synthetic body',
  messageReadExit = 0, messageJson, sanitizerExit = 0, sanitizerOutput } = {}) {
  const dir = scratch(t, 'hamcontrollerscript-merge-');
  const checkout = join(dir, 'checkout');
  const bin = join(dir, 'fake-bin');
  const run = join(dir, 'run');
  mkdirSync(bin); mkdirSync(run);
  const shas = gitRepo(checkout);
  const source = movedSource ? 'c'.repeat(40) : shas.head;
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
  merge-commit-body.mjs)
    log sanitizer
    [ "$FIXTURE_SANITIZER_EXIT" = 0 ] || exit "$FIXTURE_SANITIZER_EXIT"
    if [ "\${FIXTURE_SANITIZER_OUTPUT+x}" = x ]; then
      # Consume the pipeline input like the real helper before returning success.
      # Otherwise jq can race this stub's exit and fail with SIGPIPE under pipefail.
      cat >/dev/null
      printf '%s' "$FIXTURE_SANITIZER_OUTPUT"; exit 0
    fi
    exec ${shellQuote(process.execPath)} "$path" "$@" ;;
  *) exec ${shellQuote(process.execPath)} "$path" "$@" ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, 'gh'), `#!/bin/bash
args="$*"
printf 'gh %s\\n' "\${args//$'\\n'/\\\\n}" >> "$FIXTURE_LOG"
if [ "$1 $2" = 'pr merge' ]; then printf '%s\\0' "$@" > "$FIXTURE_LOG.merge-argv"; fi
case "$*" in
  "pr view 42 --repo fixture/repo --json title,body")
    [ "$FIXTURE_MESSAGE_READ_EXIT" = 0 ] || exit "$FIXTURE_MESSAGE_READ_EXIT"
    printf '%s\\n' "$FIXTURE_MESSAGE_JSON" ;;
  "pr view 42 --repo fixture/repo --json headRefName,headRefOid,body") echo '{"headRefName":"feature","headRefOid":"${source}","body":""}' ;;
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
    FIXTURE_VALIDATE_EXIT: String(validateExit), GIT_CONFIG_GLOBAL: '/dev/null',
    FIXTURE_MESSAGE_JSON: messageJson ?? JSON.stringify({ title: prTitle, body: prBody }),
    FIXTURE_MESSAGE_READ_EXIT: String(messageReadExit), FIXTURE_SANITIZER_EXIT: String(sanitizerExit),
    ...(sanitizerOutput === undefined ? {} : { FIXTURE_SANITIZER_OUTPUT: sanitizerOutput }) };
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
  const mergeArgv = () => (existsSync(`${log}.merge-argv`)
    ? readFileSync(`${log}.merge-argv`, 'utf8').split('\0').slice(0, -1) : null);
  return { checkout, shas, close, events, mergeArgv, env };
}

test('the standalone publisher releases the merge lease when its local input cannot contain the PR head', async t => {
  const f = mergeFixture(t, { movedSource: true });
  const result = await f.close();
  assert.equal(result.status, 20, result.stderr);
  assert.match(result.stderr, /source-publication-refused/);
  assert.ok(f.events().some(event => event.startsWith('lease-release')));
  assert.ok(!f.events().some(event => /^(?:git push|hq generated-conflicts|validate)/.test(event)));
});

test('the shipped merge-agent controller merges only with --match-head-commit on the validated head', async t => {
  const f = mergeFixture(t);
  const result = await f.close();
  assert.equal(result.status, 0, result.stderr);
  const events = f.events();
  const at = prefix => events.findIndex(event => event.startsWith(prefix));
  assert.ok(at('controller assert-owner') < at('lease-acquire'));
  assert.ok(at('lease-acquire') < at('hq generated-conflicts rebase'));
  assert.ok(at('hq generated-conflicts rebase') < at('validate --pytest -- tests/test_example.py'));
  assert.ok(at('validate') < at(`git push --force-with-lease=refs/heads/feature:${f.shas.head} origin ${f.shas.head}:refs/heads/feature`));
  assert.ok(at('git push') < at('ci-cost'));
  assert.deepEqual(f.mergeArgv(), ['pr', 'merge', '42', '--repo', 'fixture/repo', '--squash', '--auto',
    '--match-head-commit', f.shas.head, '--subject', 'Synthetic change (#42)',
    '--body', 'Synthetic body\n\nClosed-By: merge-agent']);
  assert.ok(at('ci-cost') < at('gh pr view 42 --repo fixture/repo --json title,body'));
  assert.ok(at('gh pr view 42 --repo fixture/repo --json title,body') < at('gh pr merge'));
  assert.ok(at('gh pr merge') < at('lease-release'));
  assert.match(events.find(event => event.startsWith('lease-release')), /--lease-id ml_fixture/);
  assert.match(events.find(event => event.startsWith('lease-acquire')), new RegExp(`--head ${f.shas.head} .*--owner-pid [1-9]`));
});

// MERGEAGENTBODY-01: the fallback controller's squash message is the shared
// sanitizer's output, never GitHub's default built from the raw PR body.
test('the merge-agent controller neutralizes closing keywords exactly as the hammer merge helper does', async t => {
  const prTitle = 'Fix #9: synthetic title';
  const prBody = 'Synthetic change.\n\nFixes #123\ncloses acme/other#5\nResolves https://github.com/fixture/repo/issues/77\nCloses #42';
  const f = mergeFixture(t, { prTitle, prBody });
  const result = await f.close();
  assert.equal(result.status, 0, result.stderr);
  const argv = f.mergeArgv();
  assert.ok(argv, f.events().join('\n'));
  const subject = argv[argv.indexOf('--subject') + 1];
  const body = argv[argv.indexOf('--body') + 1];
  // Same helper, same input, as bin/hammer-merge.sh pipes it; only the trailer differs by closer.
  const hammer = execFileSync(process.execPath, [join(root, 'bin/merge-commit-body.mjs'), 'fixture/repo', '42', f.shas.head], {
    input: prBody, encoding: 'utf8', env: { ...f.env, PATH: process.env.PATH, HAM_PR_TITLE: prTitle, HAM_AMA_TRAILERS: 'Closed-By: hammer' },
  });
  const expected = JSON.parse(hammer);
  assert.equal(subject, expected.subject);
  assert.equal(body, expected.text.replace(/Closed-By: hammer$/, 'Closed-By: merge-agent'));
  assert.equal(subject, 'Fix PR #9: synthetic title (#42)');
  assert.match(body, /^Fixes PR #123$/m);
  assert.match(body, /^closes PR acme\/other#5$/m);
  assert.match(body, /^Resolves PR https:\/\/github\.com\/fixture\/repo\/issues\/77$/m);
  assert.match(body, /^Closes #42$/m, 'a reference to this PR stays a closing reference');
  assert.doesNotMatch(body, /^Fixes #123$/m);
  assert.ok(argv.includes('--match-head-commit') && !argv.includes('--admin'));
});

test('the merge-agent controller refuses to merge without a readable non-empty title and releases the lease', async t => {
  for (const options of [{ prTitle: '  ' }, { messageReadExit: 1 },
    { messageJson: 'not JSON' }, { messageJson: '{"title":42,"body":""}' }]) {
    const f = mergeFixture(t, options);
    const result = await f.close();
    const events = f.events();
    assert.equal(result.status, 75, `${JSON.stringify(options)}\n${result.stderr}`);
    assert.match(result.stderr, options.prTitle ? /merge-title-missing/ : /commit-title-read-failed/);
    assert.equal(f.mergeArgv(), null, JSON.stringify(options));
    assert.ok(!events.some(event => event.startsWith('gh pr merge')), JSON.stringify(options));
    assert.equal(events.filter(event => event.startsWith('lease-release')).length, 1, JSON.stringify(options));
    assert.ok(!events.includes('sanitizer'), 'unreadable titles must stop before sanitization');
  }
});

test('the merge-agent controller escalates sanitizer and decoder failures and releases the lease once', async t => {
  for (const [options, reason] of [
    [{ sanitizerExit: 1 }, 'commit-body-sanitization-failed'],
    [{ sanitizerOutput: 'not JSON' }, 'commit-subject-decode-failed'],
    [{ sanitizerOutput: '{"text":"body"}' }, 'commit-subject-decode-failed'],
    [{ sanitizerOutput: '{"subject":42,"text":"body"}' }, 'commit-subject-decode-failed'],
    [{ sanitizerOutput: '{"subject":"title"}' }, 'commit-body-decode-failed'],
    [{ sanitizerOutput: '{"subject":"title","text":42}' }, 'commit-body-decode-failed'],
  ]) {
    const f = mergeFixture(t, options);
    const result = await f.close();
    const events = f.events();
    assert.equal(result.status, 64, `${JSON.stringify(options)}\n${result.stderr}`);
    assert.ok(result.stderr.includes(`merge close: ${reason}; refusing merge`), result.stderr);
    assert.equal(f.mergeArgv(), null, JSON.stringify(options));
    assert.ok(!events.some(event => event.startsWith('gh pr merge')), JSON.stringify(options));
    assert.equal(events.filter(event => event === 'sanitizer').length, 1);
    assert.equal(events.filter(event => event.startsWith('lease-acquire')).length, 1);
    assert.equal(events.filter(event => event.startsWith('lease-release')).length, 1);
    assert.match(events.find(event => event.startsWith('lease-release')), /--lease-id ml_fixture/);
    assert.ok(events.indexOf('sanitizer') < events.findIndex(event => event.startsWith('lease-release')));
  }
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


test('current registry coverage requires successful exact workflow step evidence', async t => {
  const f = mirrorFixture(t, { currentRegistry: true,
    entries: [['covered', { ci: { job: 'build', name: 'Run covered' } }],
      ['skipped', { ci: { job: 'build', name: 'Run skipped' } }],
      ['local', { ci: { job: 'build', name: 'Run local' }, advisory: true }]],
    runs: [['build']], jobDetails: { steps: [
      { name: 'Run covered', status: 'completed', conclusion: 'success' },
      { name: 'Run skipped', status: 'completed', conclusion: 'skipped' },
      { name: 'Run local', status: 'completed', conclusion: 'success' },
    ] },
  });
  const result = await f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.local(), ['fixture-command skipped', 'fixture-command local']);
  const checks = result.closeResult.localValidation[0].checks;
  assert.deepEqual(checks.map(row => [row.status, row.reason]), [
    ['ci-covered', 'exact-head-ci-success'], ['run', 'ci-step-not-successful'], ['run', 'local-only'],
  ]);
  assert.equal(f.calls().filter(call => call[1]?.includes('/actions/jobs/')).length, 1);
  assert.deepEqual(checks[0].jobs, [{ name: 'build', runId: '123', jobId: '1', step: 'Run covered' }]);
});

test('current registry job-detail budget deferral stops reads and preserves completed evidence', async t => {
  for (const deferJobReadsAfter of [0, 1]) {
    const f = mirrorFixture(t, { currentRegistry: true, deferJobReadsAfter,
      entries: ['first', 'second', 'third'].map(name => [name, { ci: { job: name, name: `Run ${name}` } }]),
      runs: [['first'], ['second'], ['third']],
    });
    const result = await f.run();
    assert.equal(result.status, 0, result.stderr);
    const checks = result.closeResult.localValidation[0].checks;
    assert.deepEqual(checks.map(row => row.reason),
      ['first', 'second', 'third'].map((_, index) => index < deferJobReadsAfter ? 'exact-head-ci-success' : 'ci-budget-deferred'));
    assert.deepEqual(f.local(), ['first', 'second', 'third'].slice(deferJobReadsAfter).map(name => `fixture-command ${name}`));
    assert.equal(f.calls().filter(call => call[1]?.includes('/actions/jobs/')).length, deferJobReadsAfter);
  }
});

test('unverified current registries do not fetch unused job details beside verified legacy manifests', async t => {
  const f = mirrorFixture(t, { currentRegistry: true, remoteDrift: true, subcontext: true,
    entries: [['covered', { ci: { job: 'build', name: 'Run covered' } }]], runs: [['build']],
  });
  const result = await f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.closeResult.localValidation[0].checks[0].reason, 'manifest-head-mismatch');
  assert.deepEqual(f.local(), ['fixture-command covered', 'fixture-command sub-local']);
  assert.equal(f.calls().filter(call => call[1]?.includes('/actions/jobs/')).length, 0);
});

test('current registry unknown and mismatched workflow steps retain local validation', async t => {
  for (const [jobDetails, reason] of [
    [false, 'ci-step-read-failed'], [{ head_sha: 'a'.repeat(40) }, 'ci-step-job-mismatch'],
    [{ run_id: 124 }, 'ci-step-job-mismatch'], [{ steps: [] }, 'ci-step-missing'],
    [{ steps: [1, 2].map(() => ({ name: 'Run covered', status: 'completed', conclusion: 'success' })) }, 'ci-step-ambiguous'],
  ]) {
    const f = mirrorFixture(t, { currentRegistry: true,
      entries: [['covered', { ci: { job: 'build', name: 'Run covered' } }]], runs: [['build']], jobDetails,
    });
    const result = await f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.local(), ['fixture-command covered']);
    assert.equal(result.closeResult.localValidation[0].checks[0].reason, reason);
  }
});

// HAMCONFLICTSYNC-01: every helper a hammer shell calls is defined where it runs.
//
// HAMCONTROLLERSCRIPT-01 moved the close controller out of the prompt. Appendix
// D still called `ham_bounded_git_sync`, which then existed only inside the
// shipped verify-head phase, so every conflict repair stopped at setup. The
// same port dropped the verdict-ready marker (HAMVERDICTREADY-01). These
// contracts read the real template and shipped scripts, source the real
// inputs.sh Appendix A writes, and fail when a block or a sourced phase relies
// on a helper or handoff marker nothing provides at that point. The conflict
// fixture then runs the shipped conflict repair against a synthetic CONFLICTING
// PR through to a rebased head. Only the GitHub/credential process boundary and
// the bounded-step wrapper are stubbed; git, the rebase and the proof are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderHammerProcedure, HAMMER_PHASES } from '../src/hammer-procedure.mjs';
import { parseClosePlan, renderClosePlanExports } from '../bin/hammer-close-plan.mjs';

const root = resolve(import.meta.dirname, '..');
const read = path => readFileSync(join(root, path), 'utf8');
const template = read('templates/hammer-prompt.md');
const controller = read('bin/hammer-close-controller.sh');
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const SHA = 'a'.repeat(40);
const values = root => ({
  ROOT_DIR: root, RUN_DIR: '/synthetic/run', HQ_ROOT: '/synthetic/hq', REPO: 'fixture/repo', PR_NUMBER: '42',
  PR_URL: 'https://github.com/fixture/repo/pull/42', REVIEWED_SHA: SHA, TARGET_REMEDIATION_SHA: SHA,
  RISK_CLASS: 'low', MERGE_METHOD: 'squash', HQ_OWNER: 'fixture', AUDIT_PATH: '/synthetic/run/audit.json',
  REVIEWER: 'synthetic-reviewer', AMA_TRAILERS_SHELL: "''",
});

// --- A small, fail-closed reader of shell function use (not an interpreter).
function shellDefinitions(text) {
  return new Set([...text.matchAll(/(?:^|[\s;{])(ham_\w+)\(\)\s*\{/g)].map(m => m[1]));
}
function shellCalls(text) {
  const calls = new Set();
  const guarded = new Set([...text.matchAll(/declare -F "?(ham_\w+)"?/g)].map(m => m[1]));
  for (const line of text.replace(/\$\(\([\s\S]*?\)\)/g, ' ').split('\n')) {
    // Comments, and declarations whose names are variables, never call.
    if (/^\s*#/.test(line) || /^\s*(?:local|declare|export|unset)\b/.test(line)) continue;
    for (const m of line.matchAll(/(?<![\w$#{-])(ham_\w+)\b(?!\s*\(\)|\+?=|\[)/g)) {
      const before = line.slice(0, m.index);
      if (/\b(?:for|read(?:\s+-\w+|\s+'')*)\s+(?:[\w-]+\s+)*$/.test(before)) continue;
      if (/:\s*"$/.test(before) || /declare -F "?$/.test(before)) continue; // data literal / guard
      calls.add(m[1]);
    }
  }
  return { calls, guarded };
}
// The fenced bash blocks the closer runs, each with the prose just before it.
function promptBlocks(markdown) {
  return [...markdown.matchAll(/```bash\n([\s\S]*?)```/g)].map(m => ({
    body: m[1], line: markdown.slice(0, m.index).split('\n').length,
    prose: markdown.slice(Math.max(0, m.index - 400), m.index),
  }));
}
// Undefined helpers: calls minus what the shell has at that point (the real
// inputs.sh), what the block defines and what the block itself sources.
function undefinedHelpers(body, available, sourced = () => '') {
  const own = shellDefinitions(body);
  for (const [, path] of body.matchAll(/^\s*source\s+"([^"]+\.sh)"/gm)) {
    for (const name of shellDefinitions(sourced(path))) own.add(name);
  }
  const { calls, guarded } = shellCalls(body);
  return [...calls].filter(name => !available.has(name) && !own.has(name) && !guarded.has(name)).sort();
}

// Appendix A's inputs.sh, written exactly as the closer writes it, then
// sourced by a real bash: its `declare -F` is what every closer shell has.
function realInputs(t, { helpers } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hamconflictsync-inputs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let rootDir = root;
  if (helpers !== undefined) {
    rootDir = join(dir, 'root');
    mkdirSync(join(rootDir, 'bin'), { recursive: true });
    symlinkSync(join(root, 'bin/hammer-node-runtime.sh'), join(rootDir, 'bin/hammer-node-runtime.sh'));
    writeFileSync(join(rootDir, 'bin/hammer-shell-helpers.sh'), helpers);
  }
  const run = join(dir, 'run');
  mkdirSync(run);
  const bound = { ...values(rootDir), RUN_DIR: run };
  const inputs = template.match(/cat > '<<RUN_DIR>>\/inputs\.sh' <<'HAM_INPUTS'\n([\s\S]*?)\nHAM_INPUTS/)[1]
    .replace(/<<([A-Z_]+)>>/g, (_, key) => {
      assert.ok(Object.hasOwn(bound, key), `unbound inputs.sh value ${key}`);
      return bound[key];
    });
  writeFileSync(join(run, 'inputs.sh'), `${inputs}\n`);
  writeFileSync(join(run, 'base-head'), SHA);
  const result = spawnSync('/bin/bash', ['-c', `source ${shellQuote(join(run, 'inputs.sh'))} || exit 9
declare -F | sed 's/^declare -f //'
echo ---
compgen -e`], { encoding: 'utf8', timeout: 10_000,
    env: { PATH: '/usr/bin:/bin', HOME: dir, HAM_NODE_BIN: process.execPath } });
  assert.equal(result.status, 0, result.stderr);
  const [functions, exported] = result.stdout.split('---\n');
  return { functions: new Set(functions.trim().split('\n')), exported: new Set(exported.trim().split('\n')), run };
}

test('every ham_* helper a closer-run prompt block calls is defined by the shell at that point', t => {
  const { functions } = realInputs(t);
  // inputs.sh really defines the documented helpers, not just names in prose.
  for (const name of ['ham_step', 'ham_read', 'ham_pr', 'ham_gh', 'ham_git', 'ham_bounded_git_sync']) {
    assert.ok(functions.has(name), `inputs.sh must define ${name}`);
  }
  const blocks = promptBlocks(template);
  const controllerOnly = blocks.filter(block => /never run or re-type it/.test(block.prose));
  // The one block the close command runs is documentation, not a closer step.
  assert.equal(controllerOnly.length, 1, 'exactly one block is documented as run by the close command');
  let checked = 0;
  for (const block of blocks) {
    if (controllerOnly.includes(block)) continue;
    const missing = undefinedHelpers(block.body, functions,
      // inputs.sh is the shell's baseline above; shipped helpers add their own.
      path => (path.startsWith('<<ROOT_DIR>>/') ? read(path.replace('<<ROOT_DIR>>/', '')) : ''));
    assert.deepEqual(missing, [], `prompt block at line ${block.line} calls undefined helper(s) ${missing.join(', ')}`);
    checked += shellCalls(block.body).calls.size > 0 ? 1 : 0;
  }
  assert.ok(checked >= 5, `expected several helper-calling blocks, checked ${checked}`);
  // Inline closer commands in prose follow the same contract.
  for (const [, span] of template.matchAll(/`(ham_\w+ [^`]+)`/g)) {
    assert.deepEqual(undefinedHelpers(span, functions), [], `inline command \`${span}\``);
  }
});

test('the contract catches the conflict block that called a verify-head-only helper', t => {
  // The shared helpers as shipped before this fix: no bounded fetch helpers.
  const helpers = read('bin/hammer-shell-helpers.sh');
  const before = helpers.slice(0, helpers.indexOf('\n# HAMCONFLICTSYNC-01:'));
  const { functions } = realInputs(t, { helpers: `${before}\n` });
  assert.equal(functions.has('ham_bounded_git_sync'), false);
  const legacyBlock = [
    'HEAD_BRANCH=$(ham_pr --json headRefName --jq \'.headRefName\')',
    'ham_bounded_git_sync "$BASE_BRANCH" "$HEAD_BRANCH"',
    'ham_step mutation:report checkout 90 540 git checkout "$HEAD_BRANCH"',
  ].join('\n');
  assert.deepEqual(undefinedHelpers(legacyBlock, functions), ['ham_bounded_git_sync']);
  // The shipped conflict repair has the same exposure through inputs.sh.
  assert.deepEqual(undefinedHelpers(read('bin/hammer-conflict-repair.sh'), functions), ['ham_bounded_git_sync']);
  // A helper only a guard can reach is allowed; an unguarded call is not.
  const guarded = 'if declare -F ham_release_merge_lease >/dev/null; then ham_release_merge_lease; fi';
  assert.deepEqual(undefinedHelpers(guarded, functions), []);
  assert.deepEqual(undefinedHelpers('ham_release_merge_lease --yield x', functions), ['ham_release_merge_lease']);
});

const controllerPhases = [...new Set([...controller.matchAll(/ham_close_phase(?:_or_stop)? (hammer-[a-z-]+)/g)].map(m => m[1]))];
const renderedPhase = phase => renderHammerProcedure(phase, values(root));

test('every ham_* helper a shipped script calls is defined where it is sourced', t => {
  const { functions } = realInputs(t);
  assert.deepEqual([...controllerPhases].sort(), [...HAMMER_PHASES].sort());
  // Phases share the controller shell: inputs.sh, the controller and every
  // phase it sources provide functions to one another.
  const shared = new Set([...functions, ...shellDefinitions(controller),
    ...controllerPhases.flatMap(phase => [...shellDefinitions(renderedPhase(phase))])]);
  for (const phase of controllerPhases) {
    assert.deepEqual(undefinedHelpers(renderedPhase(phase), shared), [], `${phase} calls an undefined helper`);
  }
  assert.deepEqual(undefinedHelpers(controller, shared), [], 'close controller calls an undefined helper');
  // The conflict repair runs in its own process: only inputs.sh and itself.
  assert.deepEqual(undefinedHelpers(read('bin/hammer-conflict-repair.sh'), functions), []);
});

// --- Handoff markers: refusal gates a phase evaluates on caller-provided state.
function gatePreconditions(phaseText) {
  const lines = phaseText.split('\n');
  const assignedBefore = (name, index) => lines.slice(0, index).some(line =>
    new RegExp(`(?:^|[\\s;(])(?:export\\s+|local\\s+)?${name}=|\\bread\\b[^;]*\\b${name}\\b|^\\s*export\\s[^=]*\\b${name}\\b|\\bham_procedure_floor ${name}\\b`).test(line));
  const needs = new Map();
  lines.forEach((line, index) => {
    if (!/^\s*if .*; then\s*$/.test(line) || !/hard-blocker/.test(lines.slice(index + 1, index + 4).join('\n'))) return;
    for (const [, name] of line.matchAll(/\$\{?((?:HAM_|POST_REMEDIATION_SHA)\w*)/g)) {
      // A tunable read with its own non-empty default needs no caller.
      const reads = [...line.matchAll(new RegExp(`\\$\\{?${name}\\b(:-[^}]*)?`, 'g'))];
      if (reads.every(([, fallback]) => fallback && fallback !== ':-')) continue;
      if (!assignedBefore(name, index) && !needs.has(name)) needs.set(name, index + 1);
    }
  });
  return needs;
}
const assignsVariable = (text, name) => new RegExp(`(?:^|[\\s;(])(?:export\\s+|local\\s+)?${name}=|^\\s*export\\s[^=\\n]*\\b${name}\\b`, 'm').test(text);
function unprovidedMarkers(controllerText, exported) {
  const missing = [];
  for (const phase of controllerPhases) {
    const others = controllerPhases.filter(other => other !== phase).map(renderedPhase).join('\n');
    for (const [name, line] of gatePreconditions(renderedPhase(phase))) {
      // A phase's own later assignments never satisfy its entry gate.
      if (exported.has(name) || assignsVariable(controllerText, name) || assignsVariable(others, name)) continue;
      missing.push(`${phase}:${line}:${name}`);
    }
  }
  return missing;
}

test('every handoff marker a sourced phase gates on is provided by its caller', t => {
  const { exported } = realInputs(t);
  // The documented close plan's exports are part of the controller's shell.
  const plan = template.match(/```json\n(\{"auditDetailsFile"[^\n]*)\n```/)[1];
  const runDir = mkdtempSync(join(tmpdir(), 'hamconflictsync-plan-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  writeFileSync(join(runDir, JSON.parse(plan).auditDetailsFile), '**Findings addressed**\n');
  for (const [, name] of renderClosePlanExports(parseClosePlan(plan, { planPath: join(runDir, 'close-plan.json'), runDir }))
    .matchAll(/^export (\w+)=/gm)) exported.add(name);
  const merge = gatePreconditions(renderedPhase('hammer-merge'));
  assert.ok(merge.has('HAM_VERDICT_READY_FILE'), 'the merge phase gates on the verdict-ready marker');
  assert.deepEqual(unprovidedMarkers(controller, exported), []);
  // HAMVERDICTREADY-01: the controller as first ported never set the marker.
  const dropped = controller.split('\n').filter(line => !/^\s*(?:export )?HAM_VERDICT_READY_FILE\b/.test(line)).join('\n');
  assert.deepEqual(unprovidedMarkers(dropped, exported).filter(item => item.endsWith('HAM_VERDICT_READY_FILE')),
    [`hammer-merge:${merge.get('HAM_VERDICT_READY_FILE')}:HAM_VERDICT_READY_FILE`]);
});

test('the shared bounded fetch helpers are the rendered verify-head definitions', () => {
  const verify = read('bin/hammer-verify-head.sh');
  const copy = verify.slice(verify.indexOf('ham_update_branch_transient() {'), verify.indexOf('ham_bounded_submodule_sync() {'))
    .trimEnd().replace(/<<ROOT_DIR>>(\/bin\/[\w.-]+)/g, '"${HAM_ROOT_DIR}$1"').replaceAll('<<PR_NUMBER>>', '${HAM_PR_NUMBER}');
  const helpers = read('bin/hammer-shell-helpers.sh');
  assert.equal(helpers.slice(helpers.indexOf('ham_update_branch_transient() {')).trimEnd(), copy);
});

test('bounded fetch leaves caller variables intact on success, failure and retry', t => {
  const { run } = realInputs(t);
  const timeoutNode = join(run, 'timeout-node');
  writeFileSync(timeoutNode, '#!/bin/sh\necho 30\n', { mode: 0o755 });
  for (const status of [0, 1, 76, 124]) {
    const result = spawnSync('/bin/bash', ['-c', `
source ${shellQuote(join(run, 'inputs.sh'))} || exit 9
ham_bounded_git_operation() { return ${status}; }
sleep() { :; }
check_sync() {
  local result=0
  ham_bounded_git_sync main || result=$?
  [ "$result" -eq ${status === 124 ? 1 : status} ] || exit 10
}
names=(ham_git_sync_attempt ham_git_sync_timeout ham_git_sync_stderr ham_git_sync_exit)
unset "\${names[@]}"
check_sync
for name in "\${names[@]}"; do
  ! declare -p "$name" >/dev/null 2>&1 || exit 11
  printf -v "$name" '%s' "caller-$name"
done
check_sync
for name in "\${names[@]}"; do
  [ "\${!name}" = "caller-$name" ] || exit 12
done
`], {
      encoding: 'utf8', timeout: 10_000,
      env: { PATH: '/usr/bin:/bin', HOME: run, TMPDIR: run, HAM_NODE_BIN: timeoutNode },
    });
    assert.equal(result.status, 0, `sync status ${status}: ${result.stderr}`);
  }
});

// --- A synthetic CONFLICTING PR through the real shipped conflict repair.
const fakeNode = realNode => `#!/bin/bash
log() { printf '%s\\n' "$*" >> "$FIXTURE_LOG"; }
path="$1"; shift
case "$(basename "$path")" in
  hammer-helper-step.mjs) shift 4; exec "$@" ;;
  metered-gh.mjs) [ "$1" = exec-git ] || exit 97; shift; log "git $1"; exec git "$@" ;;
  hammer-pr-read.mjs)
    case " $* " in
      *' baseRefName '*) echo main ;;
      *' headRefName '*) echo author ;;
      *) exit 97 ;;
    esac ;;
  load-aware-timeout.mjs) echo 30 ;;
  hammer-terminal-audit.mjs) log "terminal-audit $*" ;;
  *) exec ${shellQuote(realNode)} "$path" "$@" ;;
esac
`;

function conflictFixture(t, { conflict = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hamconflictsync-pr-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fakeBin = join(dir, 'fake-bin');
  const run = join(dir, 'run');
  const work = join(dir, 'work');
  const author = join(dir, 'author');
  mkdirSync(fakeBin); mkdirSync(run, { mode: 0o700 });
  writeFileSync(join(dir, 'gitconfig'), '');
  const log = join(dir, 'events.log');
  const env = {
    PATH: `${fakeBin}:/usr/bin:/bin`, HOME: dir, TMPDIR: run, FIXTURE_LOG: log,
    GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true',
    GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'author@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture Author', GIT_COMMITTER_EMAIL: 'author@example.invalid',
  };
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(fakeBin, 'git'), `#!/bin/sh\nexec ${shellQuote(realGit)} "$@"\n`, { mode: 0o755 });
  writeFileSync(join(fakeBin, 'node'), fakeNode(process.execPath), { mode: 0o755 });
  // The shared GENCONFLICT-01 resolver belongs to another repository; with no
  // registered outputs it continues the rebase under the caller's comment char.
  writeFileSync(join(fakeBin, 'hq'), `#!/bin/bash
printf 'hq %s commentChar=%s\\n' "$*" "$(git config core.commentChar)" >> "$FIXTURE_LOG"
[ "$1 $2 $3" = "generated-conflicts resolve --worktree" ] || exit 97
exec git -C "$4" rebase --continue
`, { mode: 0o755 });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  const origin = join(dir, 'origin.git');
  git(dir, 'clone', '-q', origin, 'author');
  writeFileSync(join(author, 'example.txt'), 'one\ntwo\nthree\n');
  git(author, 'add', 'example.txt'); git(author, 'commit', '-qm', 'Synthetic base');
  git(author, 'push', '-q', 'origin', 'main');
  git(author, 'checkout', '-qb', 'author');
  if (conflict) writeFileSync(join(author, 'example.txt'), 'one\ntwo author\nthree\n');
  else writeFileSync(join(author, 'author.txt'), 'author\n');
  git(author, 'add', '.');
  git(author, 'commit', '-qm', 'Synthetic author change\n\n# Heading kept by the rebase');
  git(author, 'push', '-q', 'origin', 'author');
  const reviewed = git(author, 'rev-parse', 'HEAD');
  git(author, 'checkout', '-q', 'main');
  writeFileSync(join(author, 'example.txt'), 'one\ntwo\nthree upstream\n');
  git(author, 'commit', '-qam', 'Synthetic upstream change');
  git(author, 'push', '-q', 'origin', 'main');
  const base = git(author, 'rev-parse', 'HEAD');
  // The hammer worktree: on the PR branch at the reviewed head, base stale.
  git(dir, 'clone', '-q', '-b', 'author', origin, 'work');
  git(work, 'update-ref', 'refs/remotes/origin/main', `${base}^`);
  const bound = { ...values(root), RUN_DIR: run, REVIEWED_SHA: reviewed, TARGET_REMEDIATION_SHA: reviewed };
  const inputs = template.match(/cat > '<<RUN_DIR>>\/inputs\.sh' <<'HAM_INPUTS'\n([\s\S]*?)\nHAM_INPUTS/)[1]
    .replace(/<<([A-Z_]+)>>/g, (_, key) => bound[key]);
  writeFileSync(join(run, 'inputs.sh'), `${inputs}\n`);
  writeFileSync(join(run, 'base-head'), reviewed);
  // The documented command, rendered with this run's values.
  const command = template.match(/^\/bin\/bash "<<ROOT_DIR>>\/bin\/hammer-conflict-repair\.sh" "<<RUN_DIR>>\/inputs\.sh"$/m)[0]
    .replace(/<<([A-Z_]+)>>/g, (_, key) => bound[key]);
  const repair = (...extra) => spawnSync('/bin/bash', ['-c', `${command} ${extra.join(' ')}`], {
    cwd: work, encoding: 'utf8', timeout: 60_000, env: { ...env, HAM_NODE_BIN: join(fakeBin, 'node') },
  });
  const events = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  return { dir, run, work, author, origin, reviewed, base, git, repair, events };
}

test('a conflicting synthetic PR is rebased by the shipped conflict repair, preserving the author change', t => {
  const f = conflictFixture(t);
  const first = f.repair();
  assert.equal(first.status, 22, first.stderr);
  assert.match(first.stderr, /conflict-markers-pending/);
  assert.match(first.stderr, /^example\.txt$/m, 'the unmerged hand-written source is listed');
  assert.match(f.events(), /^git fetch$/m, 'the fetch ran through the bounded sync helper');
  assert.doesNotMatch(first.stderr, /command not found/);
  // The closer's source resolution: keep both sides, then stage.
  assert.match(readFileSync(join(f.work, 'example.txt'), 'utf8'), /<<<<<<< /);
  writeFileSync(join(f.work, 'example.txt'), 'one\ntwo author\nthree upstream\n');
  f.git(f.work, 'add', 'example.txt');
  const second = f.repair('--continue');
  assert.equal(second.status, 0, second.stderr);
  assert.match(f.events(), /^hq generated-conflicts resolve --worktree \S+ commentChar=;$/m);
  const head = f.git(f.work, 'rev-parse', 'HEAD');
  assert.notEqual(head, f.reviewed);
  assert.equal(f.git(f.work, 'rev-parse', 'HEAD^'), f.base, 'rebased onto the live base');
  // No squash or amend: the author's message (with its heading) and identity remain.
  assert.equal(f.git(f.work, 'log', '-1', '--format=%an <%ae>%n%B'),
    'Fixture Author <author@example.invalid>\nSynthetic author change\n\n# Heading kept by the rebase');
  assert.equal(JSON.parse(readFileSync(join(f.run, 'conflict-primary.json'), 'utf8')).proof, 'conflict-primary-preserved');
  assert.equal(existsSync(join(f.run, 'conflict-repair.env')), false);
  assert.doesNotMatch(f.events(), /terminal-audit/);
  assert.match(second.stderr, /rerun the close command/);
});

test('a clean replay finishes in one invocation with the reviewed-head proof', t => {
  const f = conflictFixture(t, { conflict: false });
  const result = f.repair();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.git(f.work, 'rev-parse', 'HEAD^'), f.base);
  assert.doesNotMatch(f.events(), /^hq /m, 'no resolver for a clean replay');
  assert.equal(JSON.parse(readFileSync(join(f.run, 'conflict-primary.json'), 'utf8')).proof, 'conflict-primary-preserved');
});

test('a rebase precondition failure reports failure without requesting conflict resolution', t => {
  const f = conflictFixture(t);
  writeFileSync(join(f.work, 'example.txt'), 'uncommitted local edit\n');
  const result = f.repair();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /conflict-rebase-failed/);
  assert.doesNotMatch(result.stderr, /conflict-markers-pending|merge and stage|rerun with --continue/);
  assert.equal(f.git(f.work, 'rev-parse', 'HEAD'), f.reviewed, 'no author commit was changed');
  assert.equal(f.git(f.work, 'diff', '--name-only', '--diff-filter=U'), '');
  assert.equal(existsSync(join(f.work, '.git/rebase-merge')), false);
  assert.equal(existsSync(join(f.work, '.git/rebase-apply')), false);
  assert.doesNotMatch(f.events(), /^hq |terminal-audit/m);
});

test('conflict repair refuses a head that is not the fetched PR head, and --continue without a capture', t => {
  const f = conflictFixture(t);
  const early = f.repair('--continue');
  assert.equal(early.status, 1);
  assert.match(early.stderr, /conflict-state-missing/);
  // The PR head moves after this worktree's branch was checked out.
  f.git(f.author, 'checkout', '-q', 'author');
  writeFileSync(join(f.author, 'later.txt'), 'later\n');
  f.git(f.author, 'add', 'later.txt'); f.git(f.author, 'commit', '-qm', 'Synthetic later author change');
  f.git(f.author, 'push', '-q', 'origin', 'author');
  const moved = f.repair();
  assert.equal(moved.status, 1, moved.stderr);
  assert.match(moved.stderr, /conflict-source-not-fetched-head/);
  assert.equal(f.git(f.work, 'rev-parse', 'HEAD'), f.reviewed, 'nothing was rebased');
  assert.equal(existsSync(join(f.work, '.git/rebase-merge')), false);
});

test('conflict repair refuses inputs from another checkout or a missing inputs.sh', t => {
  const f = conflictFixture(t);
  const script = join(root, 'bin/hammer-conflict-repair.sh');
  const missing = spawnSync('/bin/bash', [script, join(f.dir, 'nowhere/inputs.sh')], { cwd: f.work, encoding: 'utf8', timeout: 10_000 });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /dispatch-inputs-missing/);
  const usage = spawnSync('/bin/bash', [script], { cwd: f.work, encoding: 'utf8', timeout: 10_000 });
  assert.equal(usage.status, 64);
  writeFileSync(join(f.run, 'inputs.sh'), readFileSync(join(f.run, 'inputs.sh'), 'utf8')
    .replaceAll(`HAM_ROOT_DIR='${root}'`, `HAM_ROOT_DIR='${f.dir}'`));
  const foreign = f.repair();
  assert.equal(foreign.status, 1);
  assert.match(foreign.stderr, /names another checkout or run directory/);
});

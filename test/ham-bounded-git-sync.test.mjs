import './helpers/load-aware-timeout-fixture.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const PROMPT = readFileSync(new URL('../bin/hammer-verify-head.sh', import.meta.url), 'utf8');
const RUNTIME_SETUP = `source "${resolve('bin/hammer-node-runtime.sh')}" || exit 1;\n`;
const SYNC_FUNCTIONS = RUNTIME_SETUP + PROMPT.slice(
  PROMPT.indexOf('ham_update_branch_transient() {'),
  PROMPT.indexOf('ham_fetch_base_with_retries() {'),
).replaceAll('<<ROOT_DIR>>', resolve('.')).replaceAll('<<PR_NUMBER>>', '1234');

function runSync(mode, nodeBin = process.execPath) {
  const root = mkdtempSync(join(tmpdir(), 'ham-bounded-git-sync-'));
  try {
    const binDir = join(root, 'bin');
    const countPath = join(root, 'calls');
    const lockPath = join(root, 'FETCH_HEAD.lock');
    mkdirSync(binDir);
    const fakeGit = join(binDir, 'git');
    writeFileSync(fakeGit, `#!/bin/bash
[ "$1" = fetch ] || exit 0
printf 'call\\n' >> "$HAM_TEST_COUNT"
case "$HAM_TEST_MODE" in
  fatal) echo 'fatal: repository not found' >&2; exit 128 ;;
  transient)
    if [ "$(wc -l < "$HAM_TEST_COUNT")" -eq 1 ]; then
      echo 'connection reset by peer' >&2
      exit 1
    fi
    exit 0 ;;
esac
touch "$HAM_TEST_LOCK"
trap 'rm -f "$HAM_TEST_LOCK"; exit 143' TERM
while :; do /bin/sleep 0.1; done
`);
    chmodSync(fakeGit, 0o755);
    const fakeSleep = join(binDir, 'sleep');
    writeFileSync(fakeSleep, '#!/bin/sh\nexit 0\n');
    chmodSync(fakeSleep, 0o755);
    const result = spawnSync('/bin/bash', ['-c', `${nodeBin === null ? 'unset HAM_NODE_BIN' : ''}
${SYNC_FUNCTIONS}\nham_bounded_git_sync main`], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env, AGENT_OS_NODE_BIN: '',
        PATH: `${binDir}:${process.env.PATH}`,
        HAM_NODE_BIN: nodeBin ?? '',
        HAM_GIT_SYNC_NOMINAL_SECONDS: '1',
        HAM_TEST_MODE: mode,
        HAM_TEST_COUNT: countPath,
        HAM_TEST_LOCK: lockPath,
        TMPDIR: root,
      },
    });
    const calls = existsSync(countPath) ? readFileSync(countPath, 'utf8').trim().split('\n').length : 0;
    return { ...result, calls, lockExists: existsSync(lockPath) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('bounded git sync gives a timed-out fetch SIGTERM and waits for lock cleanup before retry', () => {
  const result = runSync('timeout');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.calls, 2);
  assert.equal(result.lockExists, false);
  assert.match(result.stderr, /git fetch timed out/);
});

for (const nodeBin of ['', null]) {
  test(`bounded git sync falls back to node with ${nodeBin === null ? 'unset' : 'empty'} HAM_NODE_BIN`, () => {
    const result = runSync('transient', nodeBin);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls, 2);
    assert.doesNotMatch(result.stderr, /command not found|exec failed/);
  });
}

test('bounded git sync retries transient fetch errors but returns immediately on fatal errors', () => {
  const transient = runSync('transient');
  assert.equal(transient.status, 0, transient.stderr);
  assert.equal(transient.calls, 2);
  const fatal = runSync('fatal');
  assert.equal(fatal.status, 1, fatal.stderr);
  assert.equal(fatal.calls, 1, fatal.stderr);
  assert.match(fatal.stderr, /repository not found/);
});


for (const nodeBin of ['', null]) {
  test(`bounded submodule sync gives its outer deadline ownership with ${nodeBin === null ? 'unset' : 'empty'} node`, t => {
    const root = mkdtempSync(join(tmpdir(), 'ham-submodule-bound-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'bin'));
    const node = join(root, 'bin/node');
    writeFileSync(node, '#!/bin/sh\nprintf "%s\\n" "${HAM_GIT_SYNC_BOUNDED:-missing}" "$@"\n', {mode: 0o755});
    const env = {...process.env, AGENT_OS_NODE_BIN: '', PATH: `${join(root, 'bin')}:${process.env.PATH}`};
    if (nodeBin === null) delete env.HAM_NODE_BIN; else env.HAM_NODE_BIN = nodeBin;
    const result = spawnSync('/bin/bash', ['-c', `${SYNC_FUNCTIONS}
ham_bounded_submodule_sync`], {env, cwd: root, encoding: 'utf8', timeout: 5000});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.split('\n')[0], '1', 'the child must disable its shorter metered timeout');
    assert.match(result.stdout, /exec-git\nsubmodule\nupdate\n--recursive/);
  });

  test(`settled snapshot proof uses a real fallback node with ${nodeBin === null ? 'unset' : 'empty'} runtime`, t => {
    const root = mkdtempSync(join(tmpdir(), 'ham-settle-node-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'bin'));
    symlinkSync(process.execPath, join(root, 'bin/node'));
    writeFileSync(join(root, 'bin/hammer-rebase-result.mjs'), `import assert from 'node:assert/strict';
assert.deepEqual(process.argv.slice(2), ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)]);
console.log(JSON.stringify({proof:'fixture-exact-head'}));
`);
    const start = PROMPT.indexOf("/usr/bin/perl -e 'alarm shift; exec @ARGV' 90", PROMPT.indexOf('ham_settle_rebase_snapshot() {'));
    assert.ok(start >= 0);
    const end = PROMPT.indexOf('; then', start);
    const command = PROMPT.slice(start, end).replaceAll('<<ROOT_DIR>>', root).replaceAll('<<RUN_DIR>>', root);
    const env = {...process.env, AGENT_OS_NODE_BIN: '', PATH: `${join(root, 'bin')}:${process.env.PATH}`};
    if (nodeBin === null) delete env.HAM_NODE_BIN; else env.HAM_NODE_BIN = nodeBin;
    const setup = `from=${'a'.repeat(40)}; snapshot_head=${'b'.repeat(40)}; base=${'c'.repeat(40)};
`;
    const result = spawnSync('/bin/bash', ['-c', RUNTIME_SETUP + setup + command], {env, cwd: root, encoding: 'utf8', timeout: 5000});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(join(root, 'rebase-result-proof.json'), 'utf8')).proof, 'fixture-exact-head');
  });
}


test('bounded submodule expiry sends TERM and waits for lock cleanup', t => {
  const root = mkdtempSync(join(tmpdir(), 'ham-submodule-cleanup-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(join(root, 'bin'));
  const lock = join(root, 'submodule.lock');
  writeFileSync(join(root, 'bin/node'), '#!/bin/sh\ntouch "$HAM_TEST_LOCK"\ntrap \'rm -f "$HAM_TEST_LOCK"; exit 143\' TERM\nwhile :; do /bin/sleep 0.1; done\n', {mode: 0o755});
  const functions = SYNC_FUNCTIONS.replace('120 env HAM_GIT_SYNC_BOUNDED=1', '1 env HAM_GIT_SYNC_BOUNDED=1');
  assert.notEqual(functions, SYNC_FUNCTIONS, 'fixture shortens only the production submodule bound');
  const result = spawnSync('/bin/bash', ['-c', `${functions}
ham_bounded_submodule_sync`], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    env: {...process.env, AGENT_OS_NODE_BIN: '', PATH: `${join(root, 'bin')}:${process.env.PATH}`, HAM_NODE_BIN: '', HAM_TEST_LOCK: lock},
  });
  assert.equal(result.status, 124, result.stderr);
  assert.equal(existsSync(lock), false, 'deadline waits for the child cleanup before returning');
});

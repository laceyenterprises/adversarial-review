import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const PROMPT = readFileSync(new URL('../bin/hammer-verify-head.sh', import.meta.url), 'utf8');
const SYNC_FUNCTIONS = PROMPT.slice(
  PROMPT.indexOf('ham_update_branch_transient() {'),
  PROMPT.indexOf('ham_fetch_base_with_retries() {'),
).replaceAll('<<ROOT_DIR>>', '/unavailable').replaceAll('<<PR_NUMBER>>', '1234');

function runSync(mode) {
  const root = mkdtempSync(join(tmpdir(), 'ham-bounded-git-sync-'));
  try {
    const binDir = join(root, 'bin');
    const countPath = join(root, 'calls');
    const lockPath = join(root, 'FETCH_HEAD.lock');
    mkdirSync(binDir);
    const fakeGit = join(binDir, 'git');
    writeFileSync(fakeGit, `#!/bin/bash
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
    const result = spawnSync('/bin/bash', ['-c', `${SYNC_FUNCTIONS}\nham_bounded_git_sync main`], {
      cwd: root,
      encoding: 'utf8',
      timeout: 12_000,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        HAM_NODE_BIN: '/bin/false',
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

test('bounded git sync retries transient fetch errors but returns immediately on fatal errors', () => {
  const transient = runSync('transient');
  assert.equal(transient.status, 0, transient.stderr);
  assert.equal(transient.calls, 2);
  const fatal = runSync('fatal');
  assert.equal(fatal.status, 1, fatal.stderr);
  assert.equal(fatal.calls, 1);
  assert.match(fatal.stderr, /repository not found/);
});

import './helpers/load-aware-timeout-fixture.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve('.');
const stepSource = readFileSync(join(root, 'templates/hammer-prompt.md'), 'utf8').match(/^ham_step\(\).*$/m)[0];

test('an unavailable audit dependency preserves the wrapped failure status and receipt', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-helper-diagnostic-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'src'));
  const helper = join(dir, 'bin/hammer-helper-step.mjs');
  writeFileSync(helper, readFileSync(join(root, 'bin/hammer-helper-step.mjs')));
  writeFileSync(join(dir, 'bin/load-aware-timeout.mjs'), "process.stdout.write('1');\n");
  writeFileSync(join(dir, 'src/load-aware-timeout.mjs'), 'export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;\n');
  for (const name of ['overload-deferral.mjs', 'atomic-write.mjs']) {
    writeFileSync(join(dir, 'src', name), readFileSync(join(root, 'src', name)));
  }
  const result = spawnSync(process.execPath, [
    helper, 'mutation:report', 'publication', '1', '1', '/bin/sh', '-c', 'echo receipt; exit 76',
  ], { env: process.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 76, result.stderr);
  assert.equal(result.stdout, 'receipt\n');
  assert.match(result.stderr, /HAM helper failure audit unavailable/);
});

test('helper executable runs through a symlinked deployment with spaces and preserves wrapped argv', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer helper launch '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const deployment = join(dir, 'deployed root');
  symlinkSync(root, deployment);
  const wrapped = join(dir, 'wrapped runtime');
  const receipt = join(dir, 'receipt');
  const gitCalls = join(dir, 'git-calls');
  writeFileSync(join(dir, 'git'), '#!/bin/sh\necho unexpected >> "$GIT_CALLS"\nexit 1\n', { mode: 0o755 });
  writeFileSync(wrapped, '#!/bin/sh\nprintf "%s\\n" "$@" > "$RECEIPT"\nprintf \'{"published":true}\\n\'\n', { mode: 0o755 });
  const result = spawnSync('/bin/bash', ['-euc', `
${stepSource.replaceAll('<<ROOT_DIR>>', deployment)}
ham_step mutation pushed-attestation 90 540 "$HAM_NODE_BIN" "helper path with spaces" "run path with spaces"
`], {
    env: { ...process.env, HAM_ROOT_DIR: deployment, HAM_NODE_BIN: wrapped, RECEIPT: receipt,
      PATH: `${dir}:${process.env.PATH}`, GIT_CALLS: gitCalls },
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '{"published":true}\n');
  assert.equal(readFileSync(receipt, 'utf8'), 'helper path with spaces\nrun path with spaces\n');
  assert.equal(existsSync(gitCalls), false, 'successful helpers add no Git provenance probes');
});

for (const [mode, status, attempts] of [
  ['read', 20, 1], ['read', 76, 1], ['read', 142, 2],
  ['mutation', 142, 1], ['mutation', 143, 1],
]) {
  test(`${mode} helper retains exit ${status}, receipts and ${attempts} attempt(s) under errexit`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'hammer-helper-status-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const calls = join(dir, 'calls');
    const result = spawnSync('/bin/bash', ['-euc', `
${stepSource.replaceAll('<<ROOT_DIR>>', root)}
trap 'echo lease-released >&2' EXIT
ham_step "$MODE" publication 1 1 /bin/sh -c 'echo called >> "$CALLS"; echo receipt; if [ "$STATUS" -eq 143 ]; then kill -TERM $$; fi; exit "$STATUS"'
echo continued-after-failure
`], {
      env: { ...process.env, HAM_ROOT_DIR: root, HAM_NODE_BIN: process.execPath,
        MODE: mode, STATUS: String(status), CALLS: calls, HAM_HQ_ROOT: dir,
        HAM_REPO: 'fixture/repo', HAM_PR_NUMBER: '42', HAM_REVIEWED_SHA: 'a'.repeat(40),
        HQ_LAUNCH_REQUEST_ID: 'lrq_synthetic', HQ_WORKER_RUN_ID: 'wrun_synthetic' },
      encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stdout, 'receipt\n');
    assert.match(result.stderr, /lease-released/);
    assert.equal(readFileSync(calls, 'utf8'), 'called\n'.repeat(attempts));
  });
}

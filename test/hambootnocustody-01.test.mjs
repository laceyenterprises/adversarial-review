import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HAMMER_PHASES, renderHammerBootstrap } from '../src/hammer-procedure.mjs';

const head = 'a'.repeat(40);
const context = { head };

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hammer boot-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "deployment's checkout");
  const run = join(dir, 'run');
  const bin = join(root, 'bin');
  const log = join(dir, 'log');
  const gate = join(dir, 'gate');
  const script = join(run, 'hammer-bootstrap.sh');
  const node = join(bin, 'node');
  mkdirSync(bin, { recursive: true });
  mkdirSync(run);
  for (const phase of HAMMER_PHASES) writeFileSync(join(run, `${phase}.sh`), 'exit 99\n');
  for (const helper of ['hammer-base-head.mjs', 'hammer-controller.mjs', 'hammer-context.mjs',
    'hammer-helper-step.mjs', 'hammer-terminal-audit.mjs', 'hammer-shell-helpers.sh']) {
    writeFileSync(join(bin, helper), '');
  }
  symlinkSync(new URL('../bin/hammer-node-runtime.sh', import.meta.url).pathname, join(bin, 'hammer-node-runtime.sh'));
  writeFileSync(node, `#!/bin/bash
if read -r unexpected; then exit 96; fi
case "\${1##*/}" in
  hammer-helper-step.mjs)
    printf '%s\\n' "$3" >> "$LOG"
    test "$2 $4 $5" = 'read:report 90 540' || exit 97
    case "$3" in
      base-head)
        test "$7" = "\${0%/*}/hammer-base-head.mjs" && test "$8" = "$PR_URL" || exit 97
        printf '%s\\n' '${head}'; exit "\${BASE_STATUS:-0}" ;;
      context)
        if [ -n "$GATE" ]; then
          printf 'context-entered\\n' >&2
          read -r release < "$GATE" || exit 98
        fi
        printf '%s\\n' '${JSON.stringify(context)}'; exit "\${CONTEXT_STATUS:-0}" ;;
    esac ;;
  hammer-controller.mjs)
    printf '%s\\n' "$2" >> "$LOG"
    exit "\${ENV_STATUS:-0}" ;;
  hammer-terminal-audit.mjs) printf 'audit:%s\\n' "$2" >> "$LOG" ;;
  *) exit 99 ;;
esac
`, { mode: 0o700 });
  const values = { RUN_DIR: run, ROOT_DIR: root, HQ_ROOT: dir, HQ_OWNER: 'fixture',
    REPO: 'fixture/repo', PR_NUMBER: 42, PR_URL: 'https://example.invalid/fixture/repo/pull/42',
    REVIEWED_SHA: head, TARGET_REMEDIATION_SHA: head, RISK_CLASS: 'low', MERGE_METHOD: 'squash',
    REVIEWER: 'fixture', AUDIT_PATH: join(dir, 'audit.json'), AMA_TRAILERS_SHELL: "''" };
  writeFileSync(script, renderHammerBootstrap(values));
  const env = { PATH: '/usr/bin:/bin', HOME: dir, LOG: log, HAM_NODE_BIN: node, PR_URL: values.PR_URL };
  const runBootstrap = extra => spawnSync('/bin/bash', [script], {
    env: { ...env, ...extra }, input: 'unexpected tool stdin\n', encoding: 'utf8', timeout: 5000,
  });
  return { run, gate, script, env, runBootstrap, log: () => readFileSync(log, 'utf8').trim().split('\n') };
}

test('bootstrap preflights phase files without sourcing them and pins the starting head once', t => {
  const f = fixture(t);
  for (const phase of HAMMER_PHASES) {
    const file = join(f.run, `${phase}.sh`);
    rmSync(file);
    const missing = f.runBootstrap();
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stderr, /dispatch-phase-scripts-missing/);
    assert.equal(existsSync(join(f.run, 'base-head')), false);
    writeFileSync(file, 'exit 99\n');
  }
  const result = f.runBootstrap();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /HAM bootstrap ready/);
  assert.deepEqual(JSON.parse(readFileSync(join(f.run, 'context.json'))), context);
  assert.equal(readFileSync(join(f.run, 'base-head'), 'utf8').trim(), head);
  assert.ok(existsSync(join(f.run, 'inputs.sh')));
  assert.equal(f.runBootstrap({ BASE_STATUS: '1' }).status, 0);
  assert.deepEqual(f.log(), [
    ...HAMMER_PHASES.map(() => 'audit:dispatch-phase-scripts-missing'),
    'base-head', 'resolve-environment', 'context',
  ]);
});

test('bootstrap preserves failed stage status and never publishes partial inputs or context', t => {
  const f = fixture(t);
  for (const [env, status, baseExists] of [
    [{ BASE_STATUS: '124' }, 124, false],
    [{ ENV_STATUS: '125' }, 125, true],
    [{ CONTEXT_STATUS: '75' }, 75, true],
  ]) {
    const result = f.runBootstrap(env);
    assert.equal(result.status, status, result.stderr);
    assert.doesNotMatch(result.stdout, /HAM bootstrap ready/);
    assert.equal(existsSync(join(f.run, 'base-head')), baseExists);
    assert.equal(existsSync(join(f.run, 'inputs.sh')), false);
    assert.equal(existsSync(join(f.run, 'context.json')), false);
    assert.equal(existsSync(join(f.run, '.bootstrap')), false);
  }
  const result = f.runBootstrap({ BASE_STATUS: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.log(), ['base-head', 'base-head', 'resolve-environment', 'resolve-environment', 'context',
    'resolve-environment', 'context']);
});

test('a slow context child retains exclusive bootstrap custody until the foreground command exits', { timeout: 30000 }, async t => {
  const f = fixture(t);
  execFileSync('/usr/bin/mkfifo', [f.gate]);
  for (let trial = 0; trial < 20; trial++) {
    const child = spawn('/bin/bash', [f.script], {
      env: { ...f.env, GATE: f.gate, CONTEXT_STATUS: '75' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = once(child, 'close');
    try {
      const entered = await Promise.race([once(child.stderr, 'data'), closed]);
      assert.match(String(entered[0]), /context-entered/);
      assert.equal(existsSync(join(f.run, 'inputs.sh')), false);
      const duplicate = f.runBootstrap();
      assert.equal(duplicate.status, 75, duplicate.stderr);
      assert.match(duplicate.stderr, /preserve the existing attempt/);
      assert.doesNotMatch(duplicate.stdout, /HAM bootstrap ready/);
      assert.equal(existsSync(join(f.run, '.bootstrap')), true);
      execFileSync('/bin/bash', ['-c', 'echo release > "$1"', 'bash', f.gate], { timeout: 5000 });
      assert.deepEqual(await closed, [75, null]);
      assert.throws(() => process.kill(-child.pid, 0), { code: 'ESRCH' });
      assert.equal(existsSync(join(f.run, '.bootstrap')), false);
      assert.equal(existsSync(join(f.run, 'inputs.sh')), false);
    } finally {
      if (child.exitCode === null) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
        await closed;
      }
    }
  }
  assert.deepEqual(f.log(), ['base-head', ...Array.from({ length: 20 }, () => ['resolve-environment', 'context']).flat()]);
  assert.equal(f.runBootstrap().status, 0);
});

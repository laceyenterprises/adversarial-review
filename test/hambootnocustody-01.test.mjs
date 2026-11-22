import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HAMMER_PHASES, renderHammerBootstrap } from '../src/hammer-procedure.mjs';
import { readAmaAuditEntry } from '../src/ama/audit.mjs';
import { classifyCloserOutcome } from '../src/ama/closer-inconclusive-retry.mjs';

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
  symlinkSync(new URL('../bin/hammer-bootstrap-lock.mjs', import.meta.url), join(bin, 'hammer-bootstrap-lock.mjs'));
  const auditCli = new URL('../bin/hammer-terminal-audit.mjs', import.meta.url);
  symlinkSync(new URL('../bin/hammer-node-runtime.sh', import.meta.url).pathname, join(bin, 'hammer-node-runtime.sh'));
  writeFileSync(node, `#!/bin/bash
if read -r unexpected; then exit 96; fi
case "\${1##*/}" in
  hammer-bootstrap-lock.mjs) exec '${process.execPath}' "$@" ;;
  hammer-helper-step.mjs)
    printf '%s\\n' "$3" >> "$LOG"
    test "$2 $4 $5" = 'read:report 90 540' || exit 97
    case "$3" in
      base-head)
        test "$7" = "\${0%/*}/hammer-base-head.mjs" && test "$8" = "$PR_URL" || exit 97
        printf '%s' "\${BASE_OUTPUT-$'${head}\\n'}"; exit "\${BASE_STATUS:-0}" ;;
      context)
        if [ -n "$GATE" ]; then
          printf 'context-entered\\n' >&2
          read -r release < "$GATE" || exit 98
        fi
        if [ "\${CONTEXT_EMPTY:-0}" != 1 ]; then
          printf '{"head":"%s"}\\n' "\${CONTEXT_HEAD:-${head}}"
        fi
        exit "\${CONTEXT_STATUS:-0}" ;;
    esac ;;
  hammer-controller.mjs)
    printf '%s\\n' "$2" >> "$LOG"
    exit "\${ENV_STATUS:-0}" ;;
  hammer-terminal-audit.mjs)
    printf 'audit:%s\\n' "$2" >> "$LOG"
    if [ "\${REAL_AUDIT:-0}" = 1 ]; then exec '${process.execPath}' '${auditCli.pathname}' "\${@:2}"; fi ;;
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
  return { dir, run, gate, script, env, runBootstrap, log: () => readFileSync(log, 'utf8').trim().split('\n') };
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

test('initialized bootstrap distinguishes its pinned snapshot from a fresh context read', t => {
  const f = fixture(t);
  assert.equal(f.runBootstrap().status, 0);
  const updated = 'b'.repeat(40);
  const resumed = f.runBootstrap({ CONTEXT_HEAD: updated });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /already initialized: context\.json is the initial snapshot.*ham_read context/);
  assert.deepEqual(f.log(), ['base-head', 'resolve-environment', 'context']);
  const refreshed = spawnSync('/bin/bash', ['-c',
    'source "$1/inputs.sh" && ham_read context "$HAM_NODE_BIN" "$HAM_ROOT_DIR/bin/hammer-context.mjs" "$HAM_REPO" "$HAM_PR_NUMBER"',
    'bash', f.run], { env: { ...f.env, CONTEXT_HEAD: updated }, encoding: 'utf8', timeout: 5000 });
  assert.equal(refreshed.status, 0, refreshed.stderr);
  assert.deepEqual(JSON.parse(refreshed.stdout), { head: updated });
  assert.deepEqual(JSON.parse(readFileSync(join(f.run, 'context.json'))), context);
  assert.equal(readFileSync(join(f.run, 'base-head'), 'utf8').trim(), head);
});

test('an empty or malformed starting head is never pinned and a later read can initialize', t => {
  const f = fixture(t);
  for (const invalid of ['', 'not-a-sha', `${head}\nadditional output`]) {
    const result = f.runBootstrap({ BASE_OUTPUT: invalid });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /controller-setup-failed/);
    for (const name of ['base-head', 'inputs.sh', 'context.json']) {
      assert.equal(existsSync(join(f.run, name)), false, name);
    }
  }
  assert.equal(f.runBootstrap().status, 0);
  assert.equal(readFileSync(join(f.run, 'base-head'), 'utf8').trim(), head);
});

test('empty context records the registered closer failure through the terminal audit CLI', t => {
  const f = fixture(t);
  const result = f.runBootstrap({ CONTEXT_EMPTY: '1', REAL_AUDIT: '1' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /HAM bootstrap failed: context-failed/);
  assert.doesNotMatch(result.stderr, /audit unavailable/);
  const audit = readAmaAuditEntry(f.dir, 'fixture/repo', 42, head);
  const [{ reason, stopOrigin }] = audit.attempts;
  assert.equal(reason, 'context-failed');
  assert.equal(stopOrigin, 'closer');
  assert.deepEqual(classifyCloserOutcome({ reason }), { kind: 'inconclusive', reason, origin: 'closer' });
  assert.equal(existsSync(join(f.run, 'context.json')), false);
  assert.equal(existsSync(join(f.run, 'inputs.sh')), false);
});

test('bootstrap leaves a legacy lock with unknown ownership intact', t => {
  const f = fixture(t);
  const legacy = join(f.run, '.bootstrap');
  mkdirSync(legacy);
  writeFileSync(join(legacy, 'base-head'), 'original staging');
  const result = f.runBootstrap();
  assert.equal(result.status, 73, result.stderr);
  assert.match(result.stderr, /ownership is unknown/);
  assert.equal(readFileSync(join(legacy, 'base-head'), 'utf8'), 'original staging');
  assert.equal(existsSync(f.env.LOG), false);
  assert.equal(existsSync(join(f.run, 'inputs.sh')), false);
});

test('bootstrap preserves the attempt when the lock cannot be opened', t => {
  const f = fixture(t);
  mkdirSync(join(f.run, '.bootstrap.lock'));
  const result = f.runBootstrap();
  assert.equal(result.status, 73, result.stderr);
  assert.match(result.stderr, /ownership is unknown/);
  assert.equal(existsSync(f.env.LOG), false);
  assert.equal(existsSync(join(f.run, 'inputs.sh')), false);
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
    assert.equal(existsSync(join(f.run, '.bootstrap-pending')), false);
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
      assert.equal(duplicate.status, 73, duplicate.stderr);
      assert.match(duplicate.stderr, /preserve the existing attempt/);
      assert.doesNotMatch(duplicate.stdout, /HAM bootstrap ready/);
      execFileSync('/bin/bash', ['-c', 'echo release > "$1"', 'bash', f.gate], { timeout: 5000 });
      assert.deepEqual(await closed, [75, null]);
      // The next invocation acquiring the lock proves custody has drained.
      assert.equal(existsSync(join(f.run, '.bootstrap-pending')), false);
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

for (const signal of ['SIGKILL', 'SIGTERM']) {
  test(`bootstrap retains an orphaned read after ${signal} and recovers after it drains`, async t => {
    const outcomes = [];
    for (let trial = 0; trial < 5; trial++) {
      const f = fixture(t);
      execFileSync('/usr/bin/mkfifo', [f.gate]);
      const leader = spawn('/bin/bash', [f.script], {
        env: { ...f.env, GATE: f.gate }, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
      });
      const exited = once(leader, 'exit');
      const closed = once(leader, 'close');
      let drained = false;
      try {
        const entered = await Promise.race([once(leader.stderr, 'data'), exited]);
        assert.match(String(entered[0]), /context-entered/);
        assert.equal(leader.kill(signal), true);
        assert.deepEqual(await exited, [null, signal]);
        const overlap = f.runBootstrap();
        assert.ifError(overlap.error);
        const contextReads = f.log().filter(step => step === 'context').length;
        const readyDuringOverlap = existsSync(join(f.run, 'inputs.sh'));
        // This FIFO write requires the orphaned read to still be waiting.
        execFileSync('/bin/bash', ['-c', 'echo release > "$1"', 'bash', f.gate], { timeout: 5000 });
        await closed;
        drained = true;
        const recovered = f.runBootstrap();
        assert.ifError(recovered.error);
        outcomes.push({ busy: overlap.status, contextReads, readyDuringOverlap, recovered: recovered.status });
      } finally {
        if (!drained) {
          try { process.kill(-leader.pid, 'SIGKILL'); }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
          await closed;
        }
      }
    }
    t.diagnostic(`${signal} ${JSON.stringify(outcomes)}`);
    assert.deepEqual(outcomes, Array.from({ length: 5 }, () => ({
      busy: 73, contextReads: 1, readyDuringOverlap: false, recovered: 0,
    })));
  });
}

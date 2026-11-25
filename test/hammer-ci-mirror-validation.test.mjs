import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const wrapper = new URL('../bin/hammer-ci-mirror-validation.py', import.meta.url).pathname;
const fixture = readFileSync(new URL('./fixtures/ci-mirror-budget.py', import.meta.url), 'utf8');
const diagnostics = JSON.parse(readFileSync(new URL('./fixtures/hammer-socket-diagnostics.json', import.meta.url)));
const contractFixture = readFileSync(new URL('./fixtures/ci-mirror-contract.py', import.meta.url), 'utf8');

for (const [name, lane, status, exact] of [
  ['telegram-responder-guard', 'python', 'pass', true],
  ['Telegram responder guard', 'node', 'inconclusive', true],
  ['Telegram responder guard', 'python', 'pass', false],
  ['unrelated-test', 'node', 'pass', true],
]) {
  test(`mirror classifies ${name} ${lane} ${status} reason with exact=${exact}`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'ham-mirror-inspection-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'scripts/ci-mirror'), { recursive: true });
    writeFileSync(join(dir, 'scripts/ci-mirror/checks.json'), JSON.stringify({
      'path-glob': { 'src/**': [name, 'later'].map(name => ({ name, command: name })) },
    }));
    const text = `telegram guard lane ${lane}: ps unusable in this sandbox: no verdict`;
    const reason = `earlier diagnostic; ${exact ? text : `prefix ${text}`}; later diagnostic`;
    const script = join(dir, 'mirror.py');
    writeFileSync(script, contractFixture.replace('return CheckResult(check, "pass", 0.0)',
      `return CheckResult(check, "${status}", 0.0, output="decorated output", reason=${JSON.stringify(reason)})`));
    const plan = join(dir, 'plan.json');
    const receipt = join(dir, 'receipt.json');
    writeFileSync(plan, '{"manifests":{},"reason":"fixture"}');
    const result = spawnSync('python3', [wrapper, plan, receipt, script, '--', 'src/example.mjs'], {
      cwd: dir, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, FIXTURE_LOCAL_CHECKS: join(dir, 'local-checks') },
    });
    assert.ifError(result.error);
    const refused = exact && name !== 'unrelated-test';
    assert.equal(result.status, refused ? 75 : 0, result.stderr);
    const { checks } = JSON.parse(readFileSync(receipt, 'utf8'));
    assert.equal(checks.length, refused ? 1 : 2, 'a typed refusal stops before the later check');
    assert.equal(checks[0].localReason, refused ? 'process-inspection-unavailable' : reason);
    assert.equal(checks[0].result, refused ? 'inconclusive' : 'pass');
  });
}

for (const { name, output, stdout = '', socketPathFault } of diagnostics) {
  test(`failed mirror checks classify buffered output for ${name}`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'ham-mirror-socket-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const script = join(dir, 'mirror.py');
    const receipt = join(dir, 'receipt.json');
    writeFileSync(join(dir, 'check.py'), `import sys\nsys.stdout.write(${JSON.stringify(stdout)})\nsys.exit(${JSON.stringify(output)})\n`);
    writeFileSync(join(dir, 'plan.json'), '{"manifests":{},"reason":"fixture"}');
    writeFileSync(script, fixture);
    const result = spawnSync('python3', [wrapper, join(dir, 'plan.json'), receipt, script],
      { cwd: dir, encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 42, result.stderr);
    const { checks, selectedCheckCount, selectionSizeReason } = JSON.parse(readFileSync(receipt, 'utf8'));
    assert.equal(selectedCheckCount, undefined);
    assert.equal(selectionSizeReason, 'selection-size-unavailable');
    assert.match(result.stderr, /selection-size-unavailable/);
    assert.ok(checks.length > 0);
    assert.ok(checks.every(check => check.result === 'fail'
      && check.socketPathFault === (socketPathFault ? true : undefined)));
  });
}

for (const [name, signature, extraCall, compatible] of [
  ['annotated production contract',
    'command: str, *, cwd: Path, env: dict[str, str], timeout: float | None', '', true],
  ['additional keyword', 'command, *, cwd, env, timeout, encoding="utf-8"', ', encoding="utf-8"', false],
  ['positional parameters', 'command, cwd, env, timeout', '', false],
  ['default timeout', 'command, *, cwd, env, timeout=None', '', false],
  ['variadic keywords', 'command, *, cwd, env, timeout, **kwargs', ', encoding="utf-8"', false],
]) {
  test(`mirror shell runner preserves ${name}`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'ham-mirror-signature-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const script = join(dir, 'mirror.py');
    const receipt = join(dir, 'receipt.json');
    writeFileSync(join(dir, 'check.py'), 'print("combined output")\n');
    writeFileSync(join(dir, 'plan.json'), '{"manifests":{},"reason":"fixture"}');
    writeFileSync(script, fixture
      .replace('def run_shell_command(command, *, cwd, env, timeout):',
        `def run_shell_command(${signature}):\n    print("original-runner", file=sys.stderr)`)
      .replace('timeout=float(os.environ.get("FIXTURE_CHECK_TIMEOUT", "8")),',
        `timeout=float(os.environ.get("FIXTURE_CHECK_TIMEOUT", "8"))${extraCall},`)
      .replace('    return CheckResult("fail"',
        '    assert result.stderr is None\n    assert isinstance(result.stdout, str)\n    return CheckResult("fail"'));
    const result = spawnSync('python3', [wrapper, join(dir, 'plan.json'), receipt, script],
      { cwd: dir, encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /combined output/);
    const checks = JSON.parse(readFileSync(receipt, 'utf8')).checks;
    assert.equal(checks.length, 2);
    assert.ok(checks.every(row => row.result === 'pass'));
    if (compatible) {
      assert.doesNotMatch(result.stderr, /original-runner|unsupported shell runner/);
    } else {
      assert.match(result.stderr, /unsupported shell runner signature/);
      assert.equal(result.stderr.match(/original-runner/g)?.length, 2);
    }
  });
}

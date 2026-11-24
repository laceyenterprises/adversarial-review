import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const wrapper = new URL('../bin/hammer-ci-mirror-validation.py', import.meta.url).pathname;
const fixture = readFileSync(new URL('./fixtures/ci-mirror-budget.py', import.meta.url), 'utf8');
const diagnostics = JSON.parse(readFileSync(new URL('./fixtures/hammer-socket-diagnostics.json', import.meta.url)));

for (const { name, output, socketPathFault } of diagnostics) {
  test(`failed mirror checks classify buffered output for ${name}`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'ham-mirror-socket-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const script = join(dir, 'mirror.py');
    const receipt = join(dir, 'receipt.json');
    writeFileSync(join(dir, 'check.py'), `import sys\nsys.exit(${JSON.stringify(output)})\n`);
    writeFileSync(join(dir, 'plan.json'), '{"manifests":{},"reason":"fixture"}');
    writeFileSync(script, fixture);
    const result = spawnSync('python3', [wrapper, join(dir, 'plan.json'), receipt, script],
      { cwd: dir, encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 42, result.stderr);
    const { checks } = JSON.parse(readFileSync(receipt, 'utf8'));
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

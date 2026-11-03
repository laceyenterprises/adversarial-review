import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

// Pair synthetic kill(0) evidence with raw ps producer output. Leaving ps real
// lets an unrelated host PID look reused relative to the fixture's fake clock.
// The real captureCloserProcessSync parser and lease predicates still run.
export function closerProcessFixture(t, {
  pid = 123, stdout = 'Wed Dec 31 23:59:00 2025\n', error = null,
} = {}) {
  const calls = [];
  const original = childProcess.execFileSync;
  const mock = t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
    if (command !== 'ps' || !args.includes(String(pid))) return original(command, args, options);
    assert.deepEqual(args, ['-o', 'lstart=', '-p', String(pid)]);
    assert.equal(options.env.TZ, 'UTC');
    assert.equal(options.env.LC_ALL, 'C');
    calls.push({ command, args });
    if (error) throw error;
    return stdout;
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  return calls;
}

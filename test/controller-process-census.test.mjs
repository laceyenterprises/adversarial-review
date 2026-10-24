import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nativeControllerIdentity } from '../src/controller-process-census.mjs';
import { currentProcessGroupId } from '../src/process-group-identity.mjs';

const python = process.env.HQ_PYTHON3 || process.env.AGENT_OS_PY || 'python3';

test('native census validates the wire shape and retains timeout and isolation budgets', () => {
  const result = nativeControllerIdentity('group', 42, { execFileSyncImpl(bin, args, options) {
    assert.equal(bin, python);
    assert.deepEqual(args.slice(0, 2), ['-I', '-B']);
    assert.deepEqual(args.slice(-2), ['group', '42']);
    assert.equal(options.timeout, 2000);
    assert.equal(options.maxBuffer, 1024 * 1024);
    return '[{"pid":42,"birth":"123.000001"}]';
  } });
  assert.deepEqual(result, [{ pid: 42, birth: '123.000001' }]);
  for (const value of ['', 'null', '{}', '[{"pid":42}]', '[{"pid":0,"birth":"123.000001"}]',
    '[{"pid":42,"birth":"123.000001"},{"pid":42,"birth":"123.000001"}]']) {
    assert.throws(() => nativeControllerIdentity('group', 42, { execFileSyncImpl: () => value }));
  }
  for (const code of ['EPERM', 'ETIMEDOUT', 'ENOENT']) {
    assert.throws(() => nativeControllerIdentity('group', 42, { execFileSyncImpl() {
      throw Object.assign(new Error('denied'), { code });
    } }), { code });
  }
});

test('native libproc allowed, denied, partial, reused and truncated fixtures', () => {
  execFileSync(python, ['-I', '-B', fileURLToPath(new URL('./fixtures/controller-census.py', import.meta.url))],
    { timeout: 5000, stdio: 'pipe' });
});

test('Darwin current PGID uses the available native path in the declared boundary', { skip: process.platform !== 'darwin' }, () => {
  const expected = nativeControllerIdentity('pgid', process.pid);
  assert.equal(currentProcessGroupId({ useCache: false }), expected);
});

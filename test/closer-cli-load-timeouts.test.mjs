import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mockCloserLoad } from './helpers/closer-load-fixture.mjs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { helperBudget } from '../bin/hammer-helper-step.mjs';

for (const multiplier of [1, 6]) {
  test(`helper sizing subprocess receives its ${multiplier}x load-scaled budget`, t => {
    mockCloserLoad(t, multiplier);
    const calls = [];
    t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
      if (command === '/bin/ps') return '100000\n';
      calls.push({ args, options });
      return '42\n';
    });
    syncBuiltinESMExports();
    assert.equal(helperBudget(10, 60), 42);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(-2), ['10', '60']);
    assert.equal(calls[0].options.timeout, 5000 * multiplier);
  });

  test(`pushed attestation CLI passes a ${multiplier}x scaled API budget`, () => {
    // Install the fake child transport before gh-cli captures promisify(execFile).
    // The first API call deliberately stops; no GitHub reads or writes occur.
    const script = `
      import assert from 'node:assert/strict';
      import os from 'node:os';
      import cp from 'node:child_process';
      import { promisify } from 'node:util';
      import { syncBuiltinESMExports } from 'node:module';
      os.platform = () => 'linux';
      os.loadavg = () => [${multiplier === 1 ? '0' : 'os.cpus().length * 3'}, 0, 0];
      cp.execFileSync = command => {
        assert.equal(command, '/bin/ps');
        return '100000\\n';
      };
      const calls = [];
      const stop = new Error('synthetic API stop');
      cp.execFile = () => { throw stop; };
      cp.execFile[promisify.custom] = async (command, args, options) => {
        assert.equal(command, 'gh');
        calls.push(options.timeout);
        throw stop;
      };
      syncBuiltinESMExports();
      process.env.MERGE_AGENT_GH_TOKEN = 'synthetic-token';
      process.argv = [process.execPath, 'hammer-pushed-attestation.mjs', 'fixture/repo', '7',
        'a'.repeat(40), 'b'.repeat(40)];
      await assert.rejects(import(${JSON.stringify(new URL('../bin/hammer-pushed-attestation.mjs', import.meta.url).href)}),
        /synthetic API stop/);
      assert.deepEqual(calls, [15000 * ${multiplier}]);
    `;
    const result = spawnSync(process.execPath, ['--preserve-symlinks', '--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 30_000,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
        HOME: process.env.HOME, HQ_ROOT: process.env.HQ_ROOT,
        ADVERSARIAL_REVIEW_STATE_DIR: process.env.ADVERSARIAL_REVIEW_STATE_DIR,
        GHO_RATE_LIMIT_SHARED_STATE_PATH: process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH,
        AGENT_OS_CONFIG_PATH: process.env.AGENT_OS_CONFIG_PATH },
    });
    assert.equal(result.status, 0, result.stderr);
  });
}

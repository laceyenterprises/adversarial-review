import os from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { resetLoadAwareTimeoutCachesForTesting } from '../../src/load-aware-timeout.mjs';

// Synthetic readings only; never create CPU contention to test a budget.
export function mockCloserLoad(t, multiplier) {
  resetLoadAwareTimeoutCachesForTesting();
  t.mock.method(os, 'loadavg', () => [multiplier === 1 ? 0 : os.cpus().length * 3, 0, 0]);
  t.mock.method(os, 'platform', () => 'linux');
  t.mock.method(childProcess, 'execFileSync', command => {
    if (command !== '/bin/ps') throw new Error('unexpected synthetic load probe');
    return `${os.cpus().length * 100}\n`;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    resetLoadAwareTimeoutCachesForTesting();
  });
}

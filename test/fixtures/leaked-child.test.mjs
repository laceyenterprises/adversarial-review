import test from 'node:test';
import { spawn } from 'node:child_process';
import { fixtureLifetime } from '../helpers/fixture-child.mjs';

test('deliberately leaked detached child', () => {
  const child = spawn(process.execPath, ['-e', `${fixtureLifetime} setInterval(() => {}, 1_000);`], {
    detached: true,
    stdio: 'ignore',
  });
  console.log(`LEAKED_FIXTURE_PID=${child.pid}`);
});

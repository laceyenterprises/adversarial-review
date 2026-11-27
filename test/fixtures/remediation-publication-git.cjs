const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { connect } = require('node:net');

const [mode, ...args] = process.argv.slice(2);
const scenario = process.env.FAKE_PUBLICATION_SCENARIO;

if (mode === 'nested') {
  // With no inherited capture pipes, Git's exit does not wait for this child.
  process.on('SIGTERM', () => {});
  const socket = connect(Number(process.env.FAKE_PUBLICATION_PORT), '127.0.0.1');
  socket.on('connect', () => process.send('ready'));
  // Also lets the test supervisor clean up the before-fix behavior by closing
  // its own fixture socket, with no signal to a potentially recycled PID.
  socket.on('close', () => process.exit(0));
} else if (mode === 'hook') {
  spawn(process.execPath, [__filename, 'nested'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    .on('message', () => process.send('ready'));
} else {
  assert.equal(mode, 'git');
  assert.equal(process.env.PPH_WORKER_FAST_ONLY, '1');
  assert.equal(process.env.PPH_STRICT, '1');
  assert.equal(process.env.PPH_SKIP, '0');
  assert.equal(process.env.PPH_TOTAL_BUDGET_SECONDS, '45');
  assert.equal(process.env.WORKER_ID, undefined);
  assert.equal(process.env.HQ_WORKER_ID, undefined);
  const push = () => execFileSync('git', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (['success', 'stale-lease', 'timeout-after-update'].includes(scenario)) {
    try { push(); }
    catch (error) { process.exit(error.status ?? 1); }
  }
  if (scenario === 'success' || scenario === 'false-success') process.exit(0);
  if (scenario === 'auth-refused') {
    process.stderr.write('fatal: Authentication failed\n', () => process.exit(128));
  } else {
    spawn(process.execPath, [__filename, 'hook'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
      .on('message', () => {
        if (scenario === 'fast-check-red') process.exit(42);
        if (scenario === 'overflow') process.stdout.write('x'.repeat(5 * 1024 * 1024));
      });
  }
}

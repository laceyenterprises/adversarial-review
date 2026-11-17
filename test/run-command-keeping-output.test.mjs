import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommandKeepingOutput } from '../src/run-command-keeping-output.mjs';

for (const exitsBeforeTimeout of [true, false]) {
  test(`timeout bounds inherited pipes when the child exits ${exitsBeforeTimeout ? 'before' : 'after'} expiry`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'runner-pipes-'));
    const pidFile = join(root, 'descendant.pid');
    let watchdog;
    try {
      const body = `
        const { spawn } = require('node:child_process');
        const { writeFileSync } = require('node:fs');
        const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(`
          process.stdout.write('descendant-out\\n');
          process.stderr.write('descendant-err\\n');
          setInterval(() => {}, 1000);
        `)}], { stdio: ['ignore', 1, 2] });
        writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid));
        descendant.unref();
        ${exitsBeforeTimeout ? 'process.exit(0);' : `
          process.on('SIGTERM', () => process.exit(0));
          setInterval(() => {}, 1000);
        `}
      `;
      const result = await Promise.race([
        runCommandKeepingOutput(process.execPath, ['-e', body], { timeout: 1000, killGraceMs: 100 }),
        new Promise((_, reject) => {
          watchdog = setTimeout(() => reject(new Error('runner did not settle after timeout and pipe drain')), 6000);
        }),
      ]);
      assert.deepEqual(result, {
        stdout: 'descendant-out\n', stderr: 'descendant-err\n', timedOut: true, timeoutMs: 1000,
      });
    } finally {
      clearTimeout(watchdog);
      try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); }
      catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('each stream may emit exactly maxBuffer bytes successfully', async () => {
  const result = await runCommandKeepingOutput(process.execPath, ['-e', `
    process.stdout.write('o'.repeat(1024));
    process.stderr.write('e'.repeat(1024));
  `], { maxBuffer: 1024 });
  assert.deepEqual(result, { stdout: 'o'.repeat(1024), stderr: 'e'.repeat(1024) });
});

for (const stream of ['stdout', 'stderr']) {
  for (const laterChunk of [false, true]) {
    test(`${stream} exceeding maxBuffer ${laterChunk ? 'in a later chunk' : 'in one write'} rejects and retains the limit`, async () => {
      const other = stream === 'stdout' ? 'stderr' : 'stdout';
      const body = laterChunk ? `
        process.${stream}.write('x'.repeat(1024), () => setTimeout(() => {
          process.${other}.write('extra-byte-sent');
          process.${stream}.write('x');
        }, 100));
      ` : `process.${stream}.write('x'.repeat(1025));`;
      await assert.rejects(
        runCommandKeepingOutput(process.execPath, ['-e', body], { maxBuffer: 1024 }),
        error => {
          assert.equal(error.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
          assert.equal(error[stream], 'x'.repeat(1024));
          if (laterChunk) assert.equal(error[other], 'extra-byte-sent');
          return true;
        },
      );
    });
  }
}

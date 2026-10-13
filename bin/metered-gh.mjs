#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { meteredExecFile } from '../src/metered-gh.mjs';
import { awaitThrottleIfNeeded, recordResponseRateLimit } from '../src/rate-limit-throttle.mjs';

const [action, ...args] = process.argv.slice(2);
if (action === 'wait' || action === 'record') {
  const payload = JSON.parse(readFileSync(0, 'utf8'));
  for (const item of payload) {
    if (action === 'wait') await awaitThrottleIfNeeded(item);
    else await recordResponseRateLimit(item);
  }
} else if (action === 'exec') {
  const execute = (command, argv, options) => new Promise((resolve, reject) => {
    const child = execFile(command, argv, options, (err, stdout, stderr) => {
      for (const signal of ['SIGTERM', 'SIGINT']) process.removeListener(signal, cancel);
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    const cancel = () => child.kill('SIGKILL');
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, cancel);
  });
  try {
    const result = await meteredExecFile(execute, 'gh', args, {
      timeout: 30_000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
  } catch (err) {
    process.stdout.write(err.stdout || '');
    process.stderr.write(err.stderr || err.message || '');
    process.exitCode = Number.isInteger(err.code) ? err.code : 1;
  }
} else {
  process.stderr.write('usage: metered-gh.mjs exec <gh arguments>\n');
  process.exitCode = 64;
}

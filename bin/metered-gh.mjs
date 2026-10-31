#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { constants } from 'node:os';
import { meteredExecFile } from '../src/metered-gh.mjs';
import { reportHammerProgress } from '../src/ama/hammer-progress.mjs';
import { awaitThrottleIfNeeded, recordResponseRateLimit, recordRateLimitedCall } from '../src/rate-limit-throttle.mjs';

function isPrMerge(argv) {
  // Skip repository options without mistaking option values or another
  // command's positional arguments for a merge subcommand.
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === '-R' || arg === '--repo') index += 2;
    else if (arg.startsWith('--repo=') || (arg.startsWith('-R') && arg.length > 2)) index += 1;
    else break;
  }
  return argv[index] === 'pr' && argv[index + 1] === 'merge';
}

const [action, ...args] = process.argv.slice(2);
if (action === 'wait' || action === 'record' || action === 'limited') {
  const payload = JSON.parse(readFileSync(0, 'utf8'));
  for (const item of payload) {
    if (action === 'wait') await awaitThrottleIfNeeded(item.resource || item, item.credential);
    else if (action === 'limited') await recordRateLimitedCall(item.resource || item, item.credential);
    else await recordResponseRateLimit(item);
  }
} else if (action === 'exec' || action === 'exec-hammer' || action === 'exec-git') {
  let terminationSignal;
  const execute = (command, argv, options) => new Promise((resolve, reject) => {
    if (action === 'exec-hammer' && command === 'gh' && isPrMerge(argv)) {
      reportHammerProgress('merge-attempted');
    }
    const child = execFile(command, argv, options, (err, stdout, stderr) => {
      for (const [signal, cancel] of cancellations) process.removeListener(signal, cancel);
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    const cancellations = ['SIGTERM', 'SIGINT'].map(signal => [signal, () => {
      // Preserve the interruption cause even though cleanup escalates to SIGKILL.
      terminationSignal ||= signal;
      child.kill('SIGKILL');
    }]);
    for (const [signal, cancel] of cancellations) process.on(signal, cancel);
  });
  try {
    const result = await meteredExecFile(execute, action === 'exec-git' ? 'git' : 'gh', args, {
      ...(action !== 'exec' ? { hammerToken: true } : {}),
      timeout: 30_000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
  } catch (err) {
    process.stdout.write(err.stdout || '');
    process.stderr.write(err.stderr || err.message || '');
    const signalNumber = constants.signals[terminationSignal || err.signal];
    process.exitCode = signalNumber ? 128 + signalNumber : Number.isInteger(err.code) ? err.code : Number.isInteger(err.status) ? err.status : 1;
  }
} else {
  process.stderr.write('usage: metered-gh.mjs exec|exec-hammer <gh arguments> | exec-git <git arguments>\n');
  process.exitCode = 64;
}

// Explicit, bounded offline experiment. No CI job or new merge gate.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const output = resolve(process.argv[2] || '/tmp/leaseciproof-trials');
mkdirSync(output, { recursive: true });
const preload = fileURLToPath(new URL('./helpers/leaseciproof-trial-preload.mjs', import.meta.url));
const records = [];
for (const mode of ['absent', 'present']) {
  for (let trial = 1; trial <= 5; trial++) {
    const result = spawnSync(process.execPath, ['test/run-tests.mjs',
      'ama-closer-dispatch-priority.test.mjs', 'noowner-01.test.mjs'], {
      env: { ...process.env, LEASECIPROOF_PS: mode,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(' ') },
      encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    });
    const text = `${result.stdout || ''}${result.stderr || ''}`;
    writeFileSync(resolve(output, `${mode}-${trial}.log`), text);
    const count = label => Number(text.match(new RegExp(`(?:ℹ|#) ${label} (\\d+)`))?.[1] ?? NaN);
    const row = { mode, trial, exit: result.status, signal: result.signal,
      error: result.error?.code || null, tests: count('tests'), pass: count('pass'), fail: count('fail') };
    records.push(row);
    console.log(JSON.stringify(row));
    if (result.error || result.signal) throw result.error || Error(`trial terminated: ${result.signal}`);
    if (row.tests !== 3 || row.pass + row.fail !== 3) {
      throw Error('trial must execute all three target cases; inspect the saved log');
    }
  }
}
writeFileSync(resolve(output, 'trials.json'), `${JSON.stringify({
  node: process.version, platform: process.platform, records,
}, null, 2)}\n`);
if (records.some(row => row.exit !== 0)) process.exitCode = 1;

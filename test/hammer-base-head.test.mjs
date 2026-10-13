import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/hammer-base-head.mjs', import.meta.url));
const head = 'a'.repeat(40);

for (const [scenario, attempts] of [['recover', 2], ['exhaust', 3], ['permanent', 1], ['malformed', 1]]) {
  test(`starting head lookup ${scenario} uses ${attempts} bounded GitHub attempts`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'hammer-base-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const callsPath = join(dir, 'calls.json');
    writeFileSync(callsPath, '[]');
    writeFileSync(join(dir, 'gh'), `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const path = ${JSON.stringify(callsPath)};
const calls = JSON.parse(readFileSync(path, 'utf8'));
calls.push(process.argv.slice(2));
writeFileSync(path, JSON.stringify(calls));
const scenario = ${JSON.stringify(scenario)};
if (scenario === 'exhaust' || (scenario === 'recover' && calls.length === 1)) {
  process.stderr.write('TLS handshake timeout'); process.exit(1);
}
if (scenario === 'permanent') { process.stderr.write('HTTP 403 Forbidden'); process.exit(1); }
process.stdout.write(scenario === 'malformed' ? 'null\\n' : '${head}\\n');
`, { mode: 0o755 });
    const run = () => execute(process.execPath, [cli, 'https://github.com/fixture/repo/pull/42'], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, timeout: 10_000,
    });
    if (scenario === 'recover') assert.equal((await run()).stdout, `${head}\n`);
    else await assert.rejects(run(), error => error.code === 1 && error.stdout === '');
    const calls = JSON.parse(readFileSync(callsPath, 'utf8'));
    assert.equal(calls.length, attempts);
    for (const args of calls) assert.deepEqual(args,
      ['api', 'repos/fixture/repo/pulls/42', '--jq', '.head.sha']);
  });
}

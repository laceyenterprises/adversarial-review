import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/hammer-head-context.mjs', import.meta.url));

function fixture(t, scenario) {
  const root = mkdtempSync(join(tmpdir(), 'hammer-head-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const callsFile = join(root, 'calls.json');
  writeFileSync(callsFile, '[]');
  writeFileSync(join(root, 'gh'), `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const scenario = ${JSON.stringify(scenario)};
const callsFile = ${JSON.stringify(callsFile)};
const args = process.argv.slice(2);
const calls = JSON.parse(readFileSync(callsFile, 'utf8'));
const attempt = calls.filter(call => JSON.stringify(call) === JSON.stringify(args)).length + 1;
calls.push(args);
writeFileSync(callsFile, JSON.stringify(calls));
const fail = message => { process.stderr.write(message); process.exit(1); };
if (scenario === 'recover' && attempt === 1) fail('TLS handshake timeout');
if (scenario === 'exhaust') fail('HTTP 503 Service Unavailable');
if (scenario === 'permanent') fail('HTTP 403 Forbidden');
if (scenario === 'malformed') { process.stdout.write('{'); process.exit(0); }
if (args[0] === 'pr') {
  if (args.join(' ') !== 'pr view https://github.com/fixture/repo/pull/1 --json baseRefName --jq .baseRefName') fail('unexpected PR call');
  process.stdout.write('release\\n');
} else if (args[1] === 'repos/fixture/repo/commits/release') {
  process.stdout.write(JSON.stringify({ sha: 'base' }));
} else if (['repos/fixture/repo/compare/base...head', 'repos/fixture/repo/compare/reviewed...head'].includes(args[1])) {
  process.stdout.write(JSON.stringify({ status: 'ahead', total_commits: 1, commits: [{ sha: 'head',
    author: { login: 'lacey-codex-agent[bot]' }, committer: { login: scenario === 'spoof' ? 'foreign-person' : 'lacey-codex-agent[bot]' },
    commit: { verification: { verified: false, reason: 'unsigned' } } }] }));
} else fail('unexpected API call');
`, { mode: 0o755 });
  return {
    run: (baseArgs = ['--pr', 'https://github.com/fixture/repo/pull/1']) => exec(process.execPath,
      [cli, 'fixture/repo', 'reviewed', 'head', ...baseArgs], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH}` }, timeout: 15000,
      }),
    calls: () => JSON.parse(readFileSync(callsFile, 'utf8')),
  };
}

test('head context retries transient PR-base and every ancestry read without live GitHub', async t => {
  const f = fixture(t, 'recover');
  const { stdout } = await f.run();
  assert.equal(JSON.parse(stdout).verified, true);
  assert.equal(f.calls().length, 8);
});

test('head context retains the explicit-base interface', async t => {
  const f = fixture(t, 'success');
  assert.equal(JSON.parse((await f.run(['release'])).stdout).verified, true);
  assert.equal(f.calls().length, 3);
  assert.ok(f.calls().every(args => args[0] === 'api'));
});

for (const [scenario, count] of [['exhaust', 3], ['permanent', 1], ['malformed', 1]]) {
  test(`head context fails closed for ${scenario} with a bounded subprocess count`, async t => {
    const f = fixture(t, scenario);
    await assert.rejects(f.run(['release']), error => error.code === 1 && !error.stdout);
    assert.equal(f.calls().length, count);
  });
}

test('head context distinguishes spoofed fleet ancestry from read failures', async t => {
  const f = fixture(t, 'spoof');
  await assert.rejects(f.run(), error => error.code === 65 && !error.stdout);
  assert.equal(f.calls().length, 4);
});

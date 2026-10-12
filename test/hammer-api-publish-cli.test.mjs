import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/hammer-api-publish.mjs', import.meta.url));

function fixture(t, scenario, target = 'pr') {
  const root = mkdtempSync(join(tmpdir(), 'hammer-api-publish-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const callsFile = join(root, 'calls.json');
  writeFileSync(callsFile, '[]');
  for (const command of ['gh', 'git']) {
    writeFileSync(join(root, command), `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const command = ${JSON.stringify(command)};
const scenario = ${JSON.stringify(scenario)};
const target = ${JSON.stringify(target)};
const callsFile = ${JSON.stringify(callsFile)};
const args = process.argv.slice(2);
const input = args.includes('--input') ? JSON.parse(readFileSync(0, 'utf8')) : undefined;
const key = command === 'gh' ? (args[0] === 'pr' ? 'pr' : args[1] === 'graphql' ? 'mutation' : 'verification')
  : args[0] === 'fetch' ? 'fetch-' + args[2] : args[0];
const calls = JSON.parse(readFileSync(callsFile, 'utf8'));
const attempt = calls.filter(call => call.key === key).length + 1;
calls.push({ key, args, input });
writeFileSync(callsFile, JSON.stringify(calls));
const fail = message => { process.stderr.write(message); process.exit(1); };
if (scenario === 'recover' && ['pr', 'mutation', 'verification', 'fetch-before', 'fetch-published'].includes(key) && attempt === 1)
  fail(command === 'git' ? 'fatal: early EOF' : 'TLS handshake timeout');
if (key === target) {
  if (scenario === 'exhaust') fail('HTTP 503 Service Unavailable');
  if (scenario === 'permanent') fail(command === 'git' ? 'fatal: Authentication failed' : 'HTTP 403 Forbidden');
  if (scenario === 'ambiguous' && attempt === 1) fail('TLS handshake timeout');
  if (scenario === 'ambiguous') fail('HTTP 422 expected head does not match');
  if (scenario === 'malformed') { process.stdout.write('{'); process.exit(0); }
}
if (command === 'gh') {
  if (key === 'pr') process.stdout.write(JSON.stringify({ headRefName: 'worker', headRefOid: 'before' }));
  else if (key === 'mutation') process.stdout.write(JSON.stringify({ data: { createCommitOnBranch: { commit: { oid: 'published' } } } }));
  else if (key === 'verification') process.stdout.write(JSON.stringify({ commit: { tree: { sha: 'tree' } } }));
  else fail('unexpected gh call');
} else {
  if (key === 'status' || key.startsWith('fetch-') || key === 'reset') process.exit(0);
  if (key === 'ls-tree') process.stdout.write('100644 blob ' + (args[2] === 'HEAD' ? 'new' : 'old') + '\\tfile\\0');
  else if (key === 'cat-file') process.stdout.write('a');
  else if (key === 'rev-parse') process.stdout.write('tree\\n');
  else if (key === 'log') process.stdout.write('HAM\\ntrailers\\n');
  else fail('unexpected git call');
}
`, { mode: 0o755 });
  }
  return {
    run: async () => JSON.parse((await exec(process.execPath, [cli, 'fixture/repo', '1'], {
      env: { ...process.env, PATH: `${root}:${process.env.PATH}` }, timeout: 20000,
    })).stdout),
    calls: () => JSON.parse(readFileSync(callsFile, 'utf8')),
  };
}

test('API publisher retries every network subprocess and preserves mutation CAS and contents', async t => {
  const f = fixture(t, 'recover');
  assert.deepEqual(await f.run(), { route: 'published', head: 'published', tree: 'tree' });
  for (const key of ['pr', 'mutation', 'verification', 'fetch-before', 'fetch-published']) {
    assert.equal(f.calls().filter(call => call.key === key).length, 2, key);
  }
  const mutations = f.calls().filter(call => call.key === 'mutation');
  assert.deepEqual(mutations[0].input, mutations[1].input);
  assert.equal(mutations[0].input.variables.input.expectedHeadOid, 'before');
  assert.deepEqual(mutations[0].input.variables.input.fileChanges.additions, [{ path: 'file', contents: 'YQ==' }]);
  assert.equal(f.calls().at(-1).key, 'reset');
});

for (const target of ['pr', 'mutation', 'verification', 'fetch-before', 'fetch-published']) {
  for (const [scenario, attempts] of [['exhaust', 3], ['permanent', 1]]) {
    test(`API publisher ${target} fails closed after ${scenario}`, async t => {
      const f = fixture(t, scenario, target);
      const result = await f.run();
      assert.equal(result.route, 're-review');
      assert.equal(f.calls().filter(call => call.key === target).length, attempts);
      assert.ok(!f.calls().some(call => call.key === 'reset'));
      if (target !== 'pr') assert.equal(result.fallbackHead,
        ['verification', 'fetch-published'].includes(target) ? 'published' : 'before');
    });
  }
}

test('an ambiguous mutation retains the original CAS and rejects unsafe publication', async t => {
  const f = fixture(t, 'ambiguous', 'mutation');
  const result = await f.run();
  assert.equal(result.route, 're-review');
  assert.equal(result.fallbackHead, 'before');
  const mutations = f.calls().filter(call => call.key === 'mutation');
  assert.equal(mutations.length, 2);
  assert.deepEqual(mutations[0].input, mutations[1].input);
  assert.ok(!f.calls().some(call => call.key === 'reset'));
});

test('malformed successful responses fall back without transport retries', async t => {
  const f = fixture(t, 'malformed');
  assert.equal((await f.run()).route, 're-review');
  assert.equal(f.calls().filter(call => call.key === 'pr').length, 1);
});

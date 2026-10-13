import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const key = command === 'gh' ? (args[0] === 'pr' || args[1]?.endsWith('/pulls/1') ? 'pr' : args[1] === 'graphql' ? 'mutation' : 'verification')
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
  if (key === 'pr') process.stdout.write(JSON.stringify({ head: { ref: 'worker', sha: 'before' } }));
  else if (key === 'mutation') process.stdout.write(JSON.stringify({ data: { createCommitOnBranch: { commit: { oid: 'published' } } } }));
  else if (key === 'verification') process.stdout.write(JSON.stringify({ commit: { tree: { sha: 'tree' } } }));
  else fail('unexpected gh call');
} else {
  if (key === 'merge-base') process.exit(scenario === 'rebased' ? 1 : 0);
  if (key === 'rev-list') { process.stdout.write(args.includes('--count') ? (scenario === 'multiple' ? '2' : '1') : (scenario === 'merge' ? 'local before other' : 'local before')); process.exit(0); }
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
  assert.deepEqual(await f.run(), { route: 'published', head: 'published', tree: 'tree', previousHead: 'before' });
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

for (const scenario of ['rebased', 'multiple', 'merge']) {
  test(`API publisher refuses ${scenario} history before mutation or reset`, async t => {
    const f = fixture(t, scenario);
    const result = await f.run();
    assert.equal(result.route, 're-review');
    assert.equal(result.fallbackHead, 'before');
    assert.equal(result.branch, 'worker');
    assert.ok(!f.calls().some(call => ['mutation', 'reset'].includes(call.key)));
  });
}

test('a real rebase onto a moved base retains local ancestry and refuses the API route', async t => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-rebased-history-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, 'work'), remote = join(root, 'remote.git'), bin = join(root, 'bin');
  mkdirSync(work); mkdirSync(bin);
  const git = (...args) => exec('git', args, { cwd: work, timeout: 10000 });
  await git('init', '--bare', remote);
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('remote', 'add', 'origin', remote);
  writeFileSync(join(work, 'base'), 'old base\n');
  await git('add', '.'); await git('commit', '-m', 'base');
  await git('checkout', '-b', 'worker');
  writeFileSync(join(work, 'feature'), 'remediation\n');
  await git('add', '.'); await git('commit', '-m', 'HAM remediation');
  await git('push', 'origin', 'worker');
  const remoteHead = (await git('rev-parse', 'HEAD')).stdout.trim();
  await git('checkout', 'main');
  writeFileSync(join(work, 'base'), 'moved base\n');
  await git('add', '.'); await git('commit', '-m', 'move base');
  const baseHead = (await git('rev-parse', 'HEAD')).stdout.trim();
  await git('checkout', 'worker'); await git('rebase', 'main');
  const localHead = (await git('rev-parse', 'HEAD')).stdout.trim();
  const callsFile = join(root, 'gh-calls');
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(callsFile)}, process.argv.slice(2).join(' ') + '\\n');
if (process.argv[2] !== 'api' || !process.argv[3].endsWith('/pulls/1')) process.exit(1);
console.log(JSON.stringify({ head: { ref: 'worker', sha: ${JSON.stringify(remoteHead)} } }));
`, { mode: 0o755 });
  const result = JSON.parse((await exec(process.execPath, [cli, 'fixture/repo', '1'], {
    cwd: work, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 20000,
  })).stdout);
  assert.equal(result.route, 're-review');
  assert.match(result.reason, /does not descend/);
  assert.equal(result.fallbackHead, remoteHead);
  assert.equal(readFileSync(callsFile, 'utf8'), 'api repos/fixture/repo/pulls/1\n');
  assert.equal((await git('rev-parse', 'HEAD')).stdout.trim(), localHead);
  await git('merge-base', '--is-ancestor', baseHead, 'HEAD');
  assert.equal((await git('ls-remote', 'origin', 'refs/heads/worker')).stdout.split(/\s/)[0], remoteHead);
});

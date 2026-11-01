import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveReviewCli } from '../src/review-cli-resolver.mjs';
import { checkAgyReviewerAuth } from '../src/agy-reviewer-auth.mjs';
import { __test__ as reviewer } from '../src/reviewer-harness.mjs';
import {
  resolveClaudeCodeCliPath, resolveCodexCliPath, resolveGeminiCliPath,
} from '../src/adapters/agent-runtime/local/remediation.mjs';
import { resolveCliBinary } from '../src/adapters/reviewer-runtime/cli-direct/discovery.mjs';
import { serviceFixtureExec, writeDummyCodexAuth } from './helpers/codex-service-fixture.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hup-review-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hq = join(root, 'fake-hq.mjs');
  const responseFile = join(root, 'response.json');
  const requestFile = join(root, 'request.json');
  const binary = join(root, 'version-1');
  writeFileSync(binary, '#!/bin/sh\nprintf \'synthetic tool event v1\\n\'\n', { mode: 0o700 });
  const selected = join(root, 'current');
  symlinkSync(binary, selected);
  const response = {
    schemaVersion: 1, cli: 'codex', source: 'managed', selectedPath: selected,
    realPath: binary, version: 'synthetic-1',
    binarySha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
  };
  const set = (doc) => writeFileSync(responseFile, JSON.stringify(doc));
  set(response);
  writeFileSync(hq, `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(requestFile)}, JSON.stringify({
  args, override: process.env.CODEX_CLI_PATH, path: process.env.PATH
}));
const doc = JSON.parse(readFileSync(${JSON.stringify(responseFile)}, 'utf8'));
if (doc.mode === 'timeout') setInterval(() => {}, 1000);
else if (doc.mode === 'error') { console.error('synthetic selection invalid'); process.exit(3); }
else if (doc.mode === 'invalid-json') console.log('{broken');
else console.log(JSON.stringify({...doc, cli: args[3]}));
`, { mode: 0o700 });
  const events = [];
  const log = { error: (line) => events.push(JSON.parse(line.slice(line.indexOf('{')))) };
  return { root, hq, binary, selected, response, requestFile, events, log, set, env: { HQ_BIN: hq, PATH: '/synthetic/bin' } };
}

test('protocol uses argv and delegates managed, explicit override and review fallback to hq', (t) => {
  const f = fixture(t);
  for (const source of ['managed', 'override', 'fallback']) {
    f.set({ ...f.response, source });
    const env = { ...f.env, CODEX_CLI_PATH: '/synthetic/override ; $(never-execute)' };
    const result = resolveReviewCli('codex', { env, log: f.log });
    assert.equal(result.source, source);
    assert.equal(result.realPath, f.binary);
    assert.ok(Object.isFrozen(result));
    const request = JSON.parse(readFileSync(f.requestFile, 'utf8'));
    assert.deepEqual(request.args, ['cli', 'resolve', '--cli', 'codex', '--consumer', 'review', '--json']);
    assert.equal(request.override, env.CODEX_CLI_PATH);
    assert.equal(request.path, env.PATH);
    assert.equal(f.events.at(-1).binarySha256, f.response.binarySha256);
    assert.ok(Number.isFinite(Date.parse(result.timestamp)));
  }
});

test('rejects every invalid required protocol field without a legacy retry', (t) => {
  const f = fixture(t);
  const invalid = {
    schemaVersion: [null, 2, '1'], cli: ['claude', null],
    source: ['', 'current', null], selectedPath: ['', 'relative', null],
    realPath: ['', 'relative', '/bad\npath', null],
    version: ['', 1, null], binarySha256: ['', 'g'.repeat(64), null],
  };
  for (const [key, values] of Object.entries(invalid)) {
    for (const value of values) {
      assert.throws(() => resolveReviewCli('codex', {
        env: f.env, log: f.log,
        execFileSyncImpl: () => JSON.stringify({ ...f.response, [key]: value }),
      }), (err) => err.binaryResolution.status === 'unknown');
    }
  }
  assert.ok(f.events.every((event) => event.status === 'unknown' && !event.source));
});

test('missing command, invalid JSON, failed selection and timeout remain unknown', (t) => {
  const f = fixture(t);
  for (const mode of ['invalid-json', 'error', 'timeout']) {
    f.set({ mode });
    assert.throws(() => resolveReviewCli('codex', {
      env: f.env, log: f.log, timeoutMs: mode === 'timeout' ? 200 : 5000,
    }), (err) => err.binaryResolution.status === 'unknown');
  }
  assert.throws(() => resolveReviewCli('codex', {
    env: { HQ_BIN: join(f.root, 'absent') }, log: f.log,
  }), (err) => err.binaryResolution.reason === 'ENOENT');
  assert.ok(f.events.every((event) => event.status === 'unknown'));
});

test('all reviewer, remediation and discovery resolvers share the review profile and claude registry key', async (t) => {
  const f = fixture(t);
  const old = process.env.HQ_BIN;
  process.env.HQ_BIN = f.hq;
  t.after(() => { if (old === undefined) delete process.env.HQ_BIN; else process.env.HQ_BIN = old; });
  for (const [cli, resolver] of [
    ['claude', reviewer.resolveClaudeCliPath], ['codex', reviewer.resolveCodexCliPath],
    ['gemini', reviewer.resolveGeminiCliPath], ['agy', reviewer.resolveAgyCliPath],
    ['claude', resolveClaudeCodeCliPath], ['codex', resolveCodexCliPath],
    ['gemini', resolveGeminiCliPath],
  ]) {
    assert.equal(resolver(f.env), f.binary);
    assert.equal(JSON.parse(readFileSync(f.requestFile, 'utf8')).args[3], cli);
  }
  for (const cli of ['claude', 'codex', 'gemini']) {
    assert.equal(await resolveCliBinary({ binaryName: cli, env: f.env }), f.binary);
    assert.equal(JSON.parse(readFileSync(f.requestFile, 'utf8')).args[5], 'review');
  }
  const probes = [];
  assert.equal((await checkAgyReviewerAuth({
    env: f.env, cacheSuccess: false,
    execFileImpl: async (command) => { probes.push(command); return { stdout: 'synthetic models' }; },
  })).ok, true);
  assert.deepEqual(probes, ['security', f.binary]);
  assert.equal(JSON.parse(readFileSync(f.requestFile, 'utf8')).args[3], 'agy');
});

test('Codex auth, direct-tools catalog and exec keep the resolved version after current flips; failures retain evidence', async (t) => {
  const f = fixture(t);
  const authPath = writeDummyCodexAuth(join(f.root, 'auth.json'));
  const env = { ...f.env, CODEX_AUTH_PATH: authPath };
  const nextBinary = join(f.root, 'version-2');
  writeFileSync(nextBinary, '#!/bin/sh\nprintf \'synthetic tool event v2\\n\'\n', { mode: 0o700 });
  const calls = [];
  const savedError = console.error;
  console.error = f.log.error;
  t.after(() => { console.error = savedError; });
  const run = (fail) => reviewer.spawnCodexReview({
    env, model: 'synthetic-model', cwd: f.root, prompt: 'synthetic prompt',
    outputPath: join(f.root, 'reply.txt'),
    execFileSyncImpl: (command, args, options) => {
      calls.push({ command, args });
      if (args[0] === 'login') {
        unlinkSync(f.selected);
        symlinkSync(nextBinary, f.selected);
      }
      return serviceFixtureExec(command, args, options);
    },
    spawnCapturedImpl: async (command) => {
      calls.push({ command, args: ['exec'] });
      if (fail) throw new Error('synthetic spawn failure');
      return execFileSync(command, [], { encoding: 'utf8' });
    },
  });
  assert.equal(await run(false), 'synthetic tool event v1\n');
  assert.deepEqual(calls.map((call) => call.command), [f.binary, f.binary, f.binary]);
  assert.deepEqual(calls.map((call) => call.args[0]), ['login', 'debug', 'exec']);
  assert.equal(f.events[0].version, 'synthetic-1');
  assert.equal(f.events[0].realPath, f.binary);
  const nextDigest = createHash('sha256').update(readFileSync(nextBinary)).digest('hex');
  f.set({ ...f.response, realPath: nextBinary, version: 'synthetic-2', binarySha256: nextDigest });
  await assert.rejects(run(true), /synthetic spawn failure/);
  assert.equal(f.events.at(-1).binarySha256, nextDigest);
  assert.equal(f.events.at(-1).version, 'synthetic-2');
  assert.equal(f.events.at(-1).selectedPath, f.selected);
});

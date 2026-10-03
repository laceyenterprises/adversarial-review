import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPrimaryChange } from '../src/ama/primary-change.mjs';
import { primaryChangeFixture } from './helpers/primary-change.mjs';

const head = 'c'.repeat(40);
const cli = fileURLToPath(new URL('../bin/primary-change-context.mjs', import.meta.url));
const prPath = 'repos/fixture/repo/pulls/1208';
const evidence = primaryChangeFixture(head);
const comparePath = `repos/fixture/repo/compare/${evidence.mergeBase}...${head}`;
const primaryPath = `repos/fixture/repo/compare/${evidence.mergeBase}...${evidence.primaryHead}`;
const pr = { head: { sha: head }, base: { sha: evidence.mergeBase } };
const history = { total_commits: 1, commits: [{ sha: head,
  parents: [{ sha: evidence.primaryHead }], commit: { message: 'Worker-Class: hammer' } }] };
const compare = { merge_base_commit: { sha: evidence.mergeBase }, files: evidence.primaryFiles };

function runCli(t, plan, argv = ['fixture/repo', '1208', head]) {
  const root = mkdtempSync(join(tmpdir(), 'primary-change-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const callsFile = join(root, 'calls.json');
  writeFileSync(callsFile, '[]');
  // A PATH-local gh fixture makes the real CLI and retry helper run offline.
  writeFileSync(join(root, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const callsFile = ${JSON.stringify(callsFile)};
const plan = ${JSON.stringify(plan)};
const calls = JSON.parse(fs.readFileSync(callsFile, 'utf8'));
const entry = plan[calls.length];
calls.push(process.argv.slice(2));
fs.writeFileSync(callsFile, JSON.stringify(calls));
if (!entry || process.argv[2] !== 'api' || process.argv[3] !== entry.path) {
  process.stderr.write('unexpected fixture call'); process.exit(1);
}
if (entry.error) { process.stderr.write(entry.error); process.exit(1); }
process.stdout.write(entry.raw ?? JSON.stringify(entry.data));
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [cli, ...argv], {
    encoding: 'utf8', timeout: 15_000,
    env: { PATH: root, HOME: root, GH_CONFIG_DIR: root },
  });
  assert.ifError(result.error);
  return { ...result, calls: JSON.parse(readFileSync(callsFile, 'utf8')) };
}

test('primary-change CLI recovers TLS and HTTP 502 reads and emits complete evidence', (t) => {
  const result = runCli(t, [
    { path: prPath, error: 'TLS handshake timeout' },
    { path: prPath, error: 'gh: Bad Gateway (HTTP 502)' },
    { path: prPath, data: pr },
    { path: comparePath, data: history },
    { path: primaryPath, error: 'gh: Bad Gateway (HTTP 502)' },
    { path: primaryPath, data: compare },
    { path: comparePath, data: compare },
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { ...evidence, testRegionsChanged: [] });
  assert.deepEqual(result.calls, [prPath, prPath, prPath, comparePath,
    primaryPath, primaryPath, comparePath].map(path => ['api', path]));
});

test('primary-change CLI exhausts transient reads after three attempts and fails closed', (t) => {
  const result = runCli(t, Array.from({ length: 3 }, () => ({
    path: prPath, error: 'gh: Bad Gateway (HTTP 502)',
  })));
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed, { headSha: head, hasHammerCommits: null, readFailed: true });
  assert.equal(checkPrimaryChange(parsed, head).reason, 'primary-change-read-failed');
  assert.deepEqual(result.calls, Array.from({ length: 3 }, () => ['api', prPath]));
});

test('primary-change CLI does not retry permanent permission errors', (t) => {
  const result = runCli(t, [{ path: prPath,
    error: 'gh: Resource not accessible by integration (HTTP 403)' }]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(checkPrimaryChange(JSON.parse(result.stdout), head).reason, 'primary-change-unknown');
  assert.deepEqual(result.calls, [['api', prPath]]);
});

test('primary-change CLI fails closed on malformed JSON without retrying the successful read', (t) => {
  const result = runCli(t, [{ path: prPath, raw: '{invalid' }]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(checkPrimaryChange(JSON.parse(result.stdout), head).reason, 'primary-change-unknown');
  assert.deepEqual(result.calls, [['api', prPath]]);
});

test('primary-change CLI rejects invalid arguments before any GitHub read', (t) => {
  const result = runCli(t, [], ['fixture/repo', '0', head]);
  assert.equal(result.status, 64);
  assert.match(result.stderr, /usage:/);
  assert.equal(result.stdout, '');
  assert.deepEqual(result.calls, []);
});

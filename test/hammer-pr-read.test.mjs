import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchHammerPr } from '../src/hammer-pr-read.mjs';
import { classifyCheckRollup } from '../src/checks-summary.mjs';
import { renderHammerProcedure } from '../src/hammer-procedure.mjs';

const head = 'a'.repeat(40);
const label = { id: 123, node_id: 'LA_fixture', name: 'operator-hold', color: 'ff0000' };
const pr = { state: 'open', head: { sha: head }, labels: [label], mergeable: true };

test('REST mergeCommit represents a completed merge, never an open PR test merge', async () => {
  const mergeSha = 'b'.repeat(40);
  for (const mergedAt of [null, '2026-10-13T12:00:00Z']) {
    const snapshot = await fetchHammerPr('fixture/repo', 42, { withChecks: false,
      read: async () => ({ ...pr, merged_at: mergedAt, merge_commit_sha: mergeSha }),
    });
    assert.equal(snapshot.state, mergedAt ? 'MERGED' : 'OPEN');
    assert.deepEqual(snapshot.mergeCommit, mergedAt ? { oid: mergeSha } : null);
  }
  const snapshot = await fetchHammerPr('fixture/repo', 42, { withChecks: false,
    read: async () => ({ ...pr, state: 'closed', merged_at: null, merge_commit_sha: mergeSha }),
  });
  assert.equal(snapshot.state, 'CLOSED');
  assert.equal(snapshot.mergeCommit, null);
});

test('REST snapshot preserves the lease green assertion for runs and contexts', async t => {
  const snapshot = await fetchHammerPr('fixture/repo', 42, { read: async path => {
    if (path.includes('/check-runs?')) return { check_runs: ['success', 'neutral', 'skipped'].map(conclusion => ({
      name: conclusion, status: 'completed', conclusion,
    })) };
    if (path.includes('/statuses?')) return [{ context: 'external', state: 'success' }];
    assert.equal(path, 'repos/fixture/repo/pulls/42');
    return pr;
  } });
  assert.equal(classifyCheckRollup(snapshot.checks), 'SUCCESS');
  assert.deepEqual(snapshot.labels, [{ id: label.node_id, name: label.name, color: label.color }]);
  const dir = mkdtempSync(join(tmpdir(), 'hammer-green-snapshot-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = renderHammerProcedure('hammer-verify-head', {
    ROOT_DIR: fileURLToPath(new URL('..', import.meta.url)), RUN_DIR: dir, HQ_ROOT: dir,
    REPO: 'fixture/repo', PR_NUMBER: '42', PR_URL: 'fixture-url', REVIEWED_SHA: head,
    TARGET_REMEDIATION_SHA: head, MERGE_METHOD: 'squash', REVIEWER: 'fixture', RISK_CLASS: 'low',
  });
  const start = source.indexOf('  ham_lease_snapshot_green() {');
  const end = source.indexOf('\n  if ham_lease_snapshot_green; then', start);
  assert.ok(start >= 0 && end > start, 'extract the actual rendered lease snapshot helper');
  const helper = source.slice(start, end);
  const green = value => {
    writeFileSync(join(dir, 'pre-acquire-checks.json'), JSON.stringify(value));
    return spawnSync('/bin/bash', ['-c', `${helper}\nham_lease_snapshot_green`], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, HAM_NODE_BIN: process.execPath, POST_REMEDIATION_SHA: head },
    });
  };
  assert.equal(green(snapshot).status, 0);
  for (const value of [{ ...snapshot, headRefOid: 'b'.repeat(40) }, { ...snapshot, statusCheckRollup: [] },
    { ...snapshot, statusCheckRollup: [{ __typename: 'CheckRun', status: 'QUEUED', conclusion: null }] },
    { ...snapshot, statusCheckRollup: [{ __typename: 'StatusContext', state: 'FAILURE' }] }]) {
    assert.equal(green(value).status, 1);
  }
});

test('commit statuses paginate individual contexts past 100 entries', async () => {
  const calls = [];
  const snapshot = await fetchHammerPr('fixture/repo', 42, { read: async path => {
    calls.push(path);
    assert.ok(calls.length <= 4, 'pagination must terminate');
    if (path.includes('/check-runs?')) return { check_runs: [] };
    if (path.endsWith('/statuses?per_page=100&page=1')) return Array.from({ length: 100 }, (_, i) => ({ context: `context-${i}`, state: 'success' }));
    if (path.endsWith('/statuses?per_page=100&page=2')) return [{ context: 'last', state: 'pending' }];
    assert.equal(path, 'repos/fixture/repo/pulls/42');
    return pr;
  } });
  assert.equal(snapshot.checks.length, 101);
  assert.equal(snapshot.checks.at(-1).state, 'PENDING');
  assert.equal(classifyCheckRollup(snapshot.checks), 'PENDING');
  assert.equal(calls.length, 4);
});

for (const args of [[], ['--jq', '.statusCheckRollup[0].conclusion'], ['--json', 'statusCheckRollup', '--jq', '.statusCheckRollup[0].conclusion'], ['--json', 'headRefOid'], ['--json', 'labels', '--jq', '.labels[].name']]) {
  test(`hammer PR CLI includes checks by default and honors explicit fields: ${args}`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'hammer-pr-cli-checks-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'gh'), `#!${process.execPath}
const path = process.argv[3];
if (path === 'repos/fixture/repo/pulls/42') console.log(${JSON.stringify(JSON.stringify(pr))});
else if (path.includes('/check-runs?')) console.log(JSON.stringify({check_runs:[{name:'ci',status:'completed',conclusion:'success'}]}));
else if (path.includes('/statuses?')) console.log('[]');
else process.exit(1);
`, { mode: 0o755 });
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/hammer-pr-read.mjs', import.meta.url)), 'fixture/repo', '42', ...args], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GHO_RATE_LIMIT_SHARED_STATE_PATH: join(dir, 'budget.json') },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    if (args.includes('labels')) assert.equal(result.stdout.trim(), label.name);
    else if (args.includes('--jq')) assert.equal(result.stdout.trim(), 'SUCCESS');
    else if (args.includes('--json')) assert.equal(JSON.parse(result.stdout).statusCheckRollup, undefined);
    else assert.equal(JSON.parse(result.stdout).statusCheckRollup[0].conclusion, 'SUCCESS');
  });
}

test('hammer PR CLI preserves synchronous jq exit status', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-pr-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(pr)}'\n`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/hammer-pr-read.mjs', import.meta.url)),
    'fixture/repo', '42', '--json', 'headRefOid', '--jq', 'halt_error(7)'], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GHO_RATE_LIMIT_SHARED_STATE_PATH: join(dir, 'budget.json') },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 7, result.stderr);
});

test('hammer PR CLI preserves alarm status for bounded visibility retries', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-pr-alarm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\nkill -ALRM $$\n', { mode: 0o755 });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/hammer-pr-read.mjs', import.meta.url)),
    'fixture/repo', '42', '--json', 'headRefOid'], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GHO_RATE_LIMIT_SHARED_STATE_PATH: join(dir, 'budget.json') },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 142, result.stderr);
});

// QCP-08: a synthetic GitHub for conditional reads. It models the documented
// rule that a 304 answer to If-None-Match is not charged to the primary rate
// limit, and answers 304 the way gh does: headers on stdout, non-zero exit.
function conditionalGitHub(resources) {
  const requests = [];
  let remaining = 5000;
  const execImpl = async args => {
    const [, path, ...flags] = args;
    assert.equal(args[0], 'api');
    assert.ok(flags.includes('-i'), 'every read asks for the ETag header');
    const sent = flags[flags.indexOf('-H') + 1];
    const ifNoneMatch = flags.includes('-H') ? sent.replace(/^If-None-Match: /, '') : null;
    const resource = resources[path];
    requests.push({ path, ifNoneMatch });
    if (resource instanceof Error) { remaining -= 1; throw resource; }
    if (!resource) throw Object.assign(new Error(`unexpected ${path}`), { stderr: 'gh: Not Found (HTTP 404)' });
    if (ifNoneMatch && ifNoneMatch === resource.etag) {
      throw Object.assign(new Error('Command failed: gh api'), { code: 1, stderr: 'gh: HTTP 304',
        stdout: `HTTP/2.0 304 Not Modified\r\nEtag: ${resource.etag}\r\nX-Ratelimit-Remaining: ${remaining}\r\n\r\n` });
    }
    remaining -= 1;
    return { stdout: `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\nEtag: ${resource.etag}\r\n`
      + `X-Ratelimit-Remaining: ${remaining}\r\n\r\n${JSON.stringify(resource.body)}` };
  };
  return { execImpl, requests, charged: () => 5000 - remaining };
}
const prPath = 'repos/fixture/repo/pulls/42';
const checksPath = sha => `repos/fixture/repo/commits/${sha}/check-runs?per_page=100&page=1&filter=all`;
const statusesPath = sha => `repos/fixture/repo/commits/${sha}/statuses?per_page=100&page=1`;
function headResources(sha, conclusion = 'success', { etagSuffix = '' } = {}) {
  return {
    [prPath]: { etag: `W/"pr-${sha.slice(0, 4)}${etagSuffix}"`, body: { ...pr, head: { sha } } },
    [checksPath(sha)]: { etag: `W/"runs-${sha.slice(0, 4)}-${conclusion}"`,
      body: { check_runs: [{ name: 'ci', status: 'completed', conclusion }] } },
    [statusesPath(sha)]: { etag: `"statuses-${sha.slice(0, 4)}"`, body: [] },
  };
}

test('QCP-08: a 304 reuses the body stored with its ETag and is not charged', async t => {
  const runDir = mkdtempSync(join(tmpdir(), 'hammer-pr-etag-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const github = conditionalGitHub(headResources(head));
  const read = () => fetchHammerPr('fixture/repo', 42, { env: { HAM_RUN_DIR: runDir }, execImpl: github.execImpl });
  const first = await read();
  assert.equal(github.charged(), 3);
  assert.deepEqual(github.requests.map(request => request.ifNoneMatch), [null, null, null]);
  // A later poll starts a new process; the run directory carries the ETags.
  github.requests.length = 0;
  const second = await read();
  assert.deepEqual(second, first);
  assert.deepEqual(github.requests, [
    { path: prPath, ifNoneMatch: `W/"pr-${head.slice(0, 4)}"` },
    { path: checksPath(head), ifNoneMatch: `W/"runs-${head.slice(0, 4)}-success"` },
    { path: statusesPath(head), ifNoneMatch: `"statuses-${head.slice(0, 4)}"` },
  ]);
  assert.equal(github.charged(), 3, 'three 304 answers cost nothing in the modelled primary limit');
  assert.equal(classifyCheckRollup(second.checks), 'SUCCESS');
});

test('QCP-08: a head change retires the old head entries and reads the new head unconditionally', async t => {
  const runDir = mkdtempSync(join(tmpdir(), 'hammer-pr-etag-head-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const next = 'b'.repeat(40);
  const resources = headResources(head, 'success');
  const github = conditionalGitHub(resources);
  const read = () => fetchHammerPr('fixture/repo', 42, { env: { HAM_RUN_DIR: runDir }, execImpl: github.execImpl });
  await read();
  Object.assign(resources, headResources(next, 'failure'));
  github.requests.length = 0;
  const moved = await read();
  assert.equal(moved.headRefOid, next);
  assert.equal(classifyCheckRollup(moved.checks), 'FAILURE');
  assert.deepEqual(github.requests, [
    { path: prPath, ifNoneMatch: `W/"pr-${head.slice(0, 4)}"` },
    { path: checksPath(next), ifNoneMatch: null }, { path: statusesPath(next), ifNoneMatch: null },
  ]);
  const [file] = readdirSync(runDir).filter(name => name.startsWith('pr-read-etags-'));
  const stored = JSON.parse(readFileSync(join(runDir, file), 'utf8'));
  assert.equal(stored.head, next);
  assert.deepEqual(Object.keys(stored.entries).sort(), [checksPath(next), prPath, statusesPath(next)].sort());
});

test('QCP-08: a non-304 failure drops its entry so the next read is unconditional', async t => {
  const runDir = mkdtempSync(join(tmpdir(), 'hammer-pr-etag-error-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const resources = headResources(head);
  const github = conditionalGitHub(resources);
  const read = () => fetchHammerPr('fixture/repo', 42, { env: { HAM_RUN_DIR: runDir }, execImpl: github.execImpl });
  await read();
  const healthy = resources[checksPath(head)];
  resources[checksPath(head)] = Object.assign(new Error('Command failed: gh api'), { code: 1, stderr: 'gh: HTTP 502',
    stdout: 'HTTP/2.0 502 Bad Gateway\r\n\r\n' });
  await assert.rejects(read(), error => error.stderr === 'gh: HTTP 502');
  resources[checksPath(head)] = healthy;
  github.requests.length = 0;
  await read();
  assert.deepEqual(github.requests.map(request => [request.path, Boolean(request.ifNoneMatch)]),
    [[prPath, true], [checksPath(head), false], [statusesPath(head), true]]);
});

test('QCP-08: ETags never leave as a malformed header and a headerless reader stays unconditional', async () => {
  for (const etag of ['"has space"', 'unquoted', `"${'x'.repeat(300)}"`]) {
    const resources = headResources(head);
    resources[prPath].etag = etag;
    const github = conditionalGitHub(resources);
    for (let poll = 0; poll < 2; poll += 1) {
      await fetchHammerPr('fixture/malformed-etag', 42, { env: {}, withChecks: false,
        execImpl: args => github.execImpl(['api', prPath, ...args.slice(2)]) });
    }
    assert.deepEqual(github.requests.map(request => request.ifNoneMatch), [null, null], etag);
  }
  const headerless = conditionalGitHub(headResources(head));
  for (let poll = 0; poll < 2; poll += 1) {
    await fetchHammerPr('fixture/headerless', 42, { env: {}, withChecks: false, execImpl: async args => {
      await headerless.execImpl(['api', prPath, ...args.slice(2)]);
      return { stdout: JSON.stringify(pr) };
    } });
  }
  assert.deepEqual(headerless.requests.map(request => request.ifNoneMatch), [null, null]);
  // Without a run directory, ETags live for the process: a second read in the
  // same process is conditional.
  const memory = conditionalGitHub(headResources(head));
  for (let poll = 0; poll < 2; poll += 1) {
    await fetchHammerPr('fixture/in-process', 42, { env: {}, withChecks: false, execImpl: args =>
      memory.execImpl(['api', prPath, ...args.slice(2)]) });
  }
  assert.deepEqual(memory.requests.map(request => request.ifNoneMatch), [null, `W/"pr-${head.slice(0, 4)}"`]);
});

test('QCP-08: the hammer PR CLI revalidates through gh, records the 304 budget and prints the same snapshot', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-pr-cli-etag-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runDir = join(dir, 'run'); mkdirSync(runDir);
  writeFileSync(join(dir, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const [, , verb, path, ...flags] = process.argv;
const resources = ${JSON.stringify(headResources(head))};
const resource = resources[path];
const sent = flags.includes('-H') ? flags[flags.indexOf('-H') + 1].replace(/^If-None-Match: /, '') : null;
fs.appendFileSync(${JSON.stringify(join(dir, 'requests.log'))}, JSON.stringify({ path, sent, include: flags.includes('-i') }) + '\\n');
if (verb !== 'api' || !resource) process.exit(1);
const ledger = ${JSON.stringify(join(dir, 'charged'))};
let charged = 0; try { charged = Number(fs.readFileSync(ledger, 'utf8')); } catch {}
const notModified = sent === resource.etag;
if (!notModified) fs.writeFileSync(ledger, String(++charged));
const status = notModified ? '304 Not Modified' : '200 OK';
const headers = 'Etag: ' + resource.etag + '\\r\\nX-Ratelimit-Remaining: ' + (5000 - charged) + '\\r\\nX-Ratelimit-Reset: 1999999999\\r\\nX-Ratelimit-Resource: core\\r\\n';
if (process.env.GH_DEBUG) process.stderr.write('* Request at fixture\\n< HTTP/2.0 ' + status + '\\n'
  + headers.replace(/\\r\\n$/, '').split('\\r\\n').map(line => '< ' + line).join('\\n') + '\\n* Request took 1ms\\n');
process.stdout.write('HTTP/2.0 ' + status + '\\r\\n' + headers + '\\r\\n' + (notModified ? '' : JSON.stringify(resource.body)));
if (notModified) { process.stderr.write('gh: HTTP 304\\n'); process.exit(1); }
`, { mode: 0o755 });
  const budget = join(dir, 'budget.json');
  const run = () => spawnSync(process.execPath, [fileURLToPath(new URL('../bin/hammer-pr-read.mjs', import.meta.url)),
    'fixture/repo', '42'], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, HAM_RUN_DIR: runDir, GHO_RATE_LIMIT_SHARED_STATE_PATH: budget } });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, first.stdout);
  const requests = readFileSync(join(dir, 'requests.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(requests.length, 6);
  assert.ok(requests.every(request => request.include));
  assert.deepEqual(requests.slice(3).map(request => request.sent), Object.values(headResources(head)).map(resource => resource.etag));
  assert.equal(readFileSync(join(dir, 'charged'), 'utf8'), '3');
  // The meter read the 304s' own headers: the shared budget still shows 4997.
  const buckets = JSON.parse(readFileSync(budget, 'utf8'));
  assert.deepEqual(Object.values(buckets.buckets || buckets).map(bucket => bucket.remaining), [4997]);
});

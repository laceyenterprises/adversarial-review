import './helpers/dispatch-read-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { reconcileBuilderClass, resolveBuilderProvenanceRouting } from '../src/builder-provenance-routing.mjs';
import { routeSubject } from '../src/adapters/subject/github-pr/routing.mjs';
import { readPrBuilderProvenance } from '../src/session-ledger-read-adapter.mjs';
import { fetchPrState, main as reroute } from '../bin/reroute-builder-review.mjs';

const headSha = 'a'.repeat(40);
const hermeticEnv = { AGENT_OS_CONFIG_PATH: '/dev/null' };

for (const [title, actual, reviewer] of [
  ['claude-code', 'codex', 'claude'],
  ['codex', 'claude-code', 'codex'],
]) {
  test(`${title} title with ${actual} ledger routes by actual builder`, () => {
    const result = reconcileBuilderClass({ builderClass: title }, { ok: true, actualHarness: actual, launchRequestId: 'lrq_fixture' });
    assert.equal(result.finding.name, 'builder_class_mismatch');
    const route = routeSubject(result.subject, {
      loaderImpl: () => ({ get: (_key, fallback) => fallback }),
      env: {}, geminiReviewerMode: 'off',
    });
    assert.equal(route.reviewerModel, reviewer);
  });
}
test('absent provenance preserves title routing and records inconclusive', () => {
  const subject = { builderClass: 'codex' };
  const result = reconcileBuilderClass(subject, { ok: false, reason: 'missing-builder-provenance' });
  assert.equal(result.subject, subject);
  assert.equal(result.deferClaim, false);
  assert.equal(result.finding.name, 'builder_class_inconclusive');
});
test('an unexpected provenance read exception defers the claim', () => {
  const reconciled = resolveBuilderProvenanceRouting({ builderClass: 'codex' }, {
    readProvenance: () => { throw new Error('fixture read failure'); },
  });
  assert.equal(reconciled.deferClaim, true);
  assert.equal(reconciled.finding.reason, 'ledger-read-failed');
});
test('invalid PR selectors do not read provenance', () => {
  for (const prNumber of [0, -1, 1.5, 'invalid']) {
    assert.deepEqual(readPrBuilderProvenance({ repo: 'org/repo', prNumber, headSha }),
      { ok: false, reason: 'missing-pr-identity' });
  }
});
test('operator PR lookup retries transient CLI failures and awaits recovery before rerouting', async () => {
  let attempts = 0;
  const delays = [];
  const live = { state: 'OPEN', headRefOid: headSha, title: '[claude-code] fixture' };
  const fetchPr = (repo, pr) => fetchPrState(repo, pr, {
    env: hermeticEnv,
    sleep: async ms => { delays.push(ms); },
    execFileImpl: async (cmd, args, options) => {
      assert.equal(cmd, 'gh');
      assert.deepEqual(args, ['pr', 'view', '12', '--repo', 'org/repo', '--json', 'state,headRefOid,title']);
      assert.equal(options.timeout, 30_000);
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('TLS handshake timeout'), { stderr: 'TLS handshake timeout' });
      if (attempts === 2) throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
      return { stdout: JSON.stringify(live) };
    },
  });
  let retriggers = 0;
  await reroute(['--repo', 'org/repo', '--pr', '12', '--apply', '--reason', 'fixture'], {
    fetchPr,
    readProvenance: () => { assert.equal(attempts, 3); return { ok: true, actualHarness: 'codex' }; },
    retrigger: () => { retriggers += 1; return 0; },
    stdout: { write: () => {} },
  });
  assert.equal(retriggers, 1);
  assert.deepEqual(delays, [500, 1000]);
});
for (const [name, stderr, expectedAttempts] of [
  ['transient exhaustion', 'HTTP 503 Service Unavailable', 3],
  ['permanent permission error', 'HTTP 403 Forbidden', 1],
]) {
  test(`operator PR lookup stops on ${name} without rerouting`, async () => {
    let attempts = 0;
    const error = Object.assign(new Error(stderr), { stderr });
    await assert.rejects(reroute(['--repo', 'org/repo', '--pr', '12', '--apply', '--reason', 'fixture'], {
      fetchPr: (repo, pr) => fetchPrState(repo, pr, { env: hermeticEnv, sleep: async () => {},
        execFileImpl: async () => { attempts += 1; throw error; },
      }),
      readProvenance: () => assert.fail('failed lookup must not read ledger'),
      retrigger: () => assert.fail('failed lookup must not reroute'),
    }), thrown => thrown === error);
    assert.equal(attempts, expectedAttempts);
  });
}
test('operator PR lookup rejects malformed JSON without retrying a successful command', async () => {
  let attempts = 0;
  await assert.rejects(fetchPrState('org/repo', 12, { env: hermeticEnv,
    execFileImpl: async () => { attempts += 1; return { stdout: '{malformed' }; },
  }), SyntaxError);
  assert.equal(attempts, 1);
});
test('operator reroute defaults to preview, apply uses existing exact-head retrigger', async () => {
  const calls = [];
  const deps = {
    fetchPr: () => ({ state: 'OPEN', headRefOid: headSha, title: '[claude-code] fixture' }),
    readProvenance: () => ({ ok: true, actualHarness: 'codex' }),
    stdout: { write: () => {} },
    retrigger: args => { calls.push(args); return 0; },
  };
  await reroute(['--repo', 'org/repo', '--pr', '12'], deps);
  assert.equal(calls.length, 0);
  await reroute(['--repo', 'org/repo', '--pr', '12', '--apply', '--reason', 'fixture'], deps);
  assert.ok(calls[0].includes('--exact-head-now'));
  assert.ok(calls[0].includes(headSha));
  assert.ok(calls[0].includes('--no-bump-budget'));
  await assert.rejects(reroute(['--repo', 'org/repo', '--pr', '12', '--apply', '--reason', 'fixture'], {
    ...deps, fetchPr: () => ({ state: 'MERGED' }),
  }), /terminal PR/);
  assert.equal(calls.length, 1);
});

test('operator reroute passes root-dir to ledger lookup and exact-head retrigger', async () => {
  const reads = [];
  const retriggers = [];
  const rootDir = '/fixture/alternate-checkout';
  const deps = {
    fetchPr: () => ({ state: 'OPEN', headRefOid: headSha, title: '[claude-code] fixture' }),
    readProvenance: options => { reads.push(options); return { ok: true, actualHarness: 'codex' }; },
    stdout: { write: () => {} },
    retrigger: args => { retriggers.push(args); return 0; },
  };
  await reroute(['--repo', 'org/repo', '--pr', '12', '--root-dir', rootDir], deps);
  await reroute(['--repo', 'org/repo', '--pr', '12', '--root-dir', rootDir,
    '--apply', '--reason', 'fixture'], deps);
  assert.deepEqual(reads, Array(2).fill({ repo: 'org/repo', prNumber: 12, headSha, rootDir }));
  assert.equal(retriggers.length, 1);
  assert.equal(retriggers[0][retriggers[0].indexOf('--root-dir') + 1], rootDir);
});

test('CLOSERINTENT-01: thrown ledger read detail is retained and repeated findings are quiet', async t => {
  const { resolveBuilderProvenanceRoutingAsync } = await import('../src/builder-provenance-routing.mjs');
  const rootDir = mkdtempSync(join(tmpdir(), 'routing-failure-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const warnings = [];
  t.mock.method(console, 'warn', text => warnings.push(text));
  const subject = { builderClass: 'codex', headSha };
  const options = { rootDir, repo: 'fixture/repo', prNumber: 8,
    readProvenance: () => { throw Error('synthetic spawn failure'); } };
  for (const resolve of [resolveBuilderProvenanceRouting, resolveBuilderProvenanceRoutingAsync]) {
    const result = await resolve(subject, options);
    assert.equal(result.finding.detail, 'synthetic spawn failure');
    assert.equal(result.deferClaim, true);
  }
  assert.equal(warnings.length, 1);
  await resolveBuilderProvenanceRoutingAsync(subject, { ...options,
    readProvenance: () => ({ ok: false, reason: 'ledger-read-failed', detail: 'changed synthetic failure' }) });
  assert.equal(warnings.length, 2);
  const auditPath = join(rootDir, 'data', 'builder-routing', `fixture%2Frepo-8-${headSha}.json`);
  assert.equal(JSON.parse(readFileSync(auditPath)).detail, 'changed synthetic failure');
  await resolveBuilderProvenanceRoutingAsync(subject, { ...options, readProvenance: () => ({ ok: true, actualHarness: 'codex' }) });
  await resolveBuilderProvenanceRoutingAsync(subject, options);
  assert.equal(warnings.length, 3, 'a recovered reader can report a new failure episode');
});

test('unchanged on-disk finding warms the shared routing cache', async t => {
  const { resolveBuilderProvenanceRoutingAsync } = await import('../src/builder-provenance-routing.mjs');
  const rootDir = mkdtempSync(join(tmpdir(), 'routing-cold-cache-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const warnings = [];
  t.mock.method(console, 'warn', text => warnings.push(text));
  const subject = { builderClass: 'codex', headSha };
  const provenance = { ok: false, reason: 'ledger-read-failed', detail: 'synthetic failure' };
  const options = { rootDir, repo: 'fixture/repo', prNumber: 8, readProvenance: () => provenance };
  const expected = reconcileBuilderClass(subject, provenance);
  const auditPath = join(rootDir, 'data', 'builder-routing', `fixture%2Frepo-8-${headSha}.json`);
  mkdirSync(dirname(auditPath), { recursive: true });
  writeFileSync(auditPath, JSON.stringify({ repo: options.repo, prNumber: options.prNumber,
    headSha, ...expected.finding }, null, 2));
  assert.deepEqual(resolveBuilderProvenanceRouting(subject, options), expected);
  rmSync(auditPath);
  // A second disk read would observe absence, recreate the audit and warn.
  assert.deepEqual(await resolveBuilderProvenanceRoutingAsync(subject, options), expected);
  assert.equal(existsSync(auditPath), false);
  assert.deepEqual(warnings, []);
});


test('builder reader consumes public actual-harness provenance independently of head movement',()=>{
  const args={repo:'example/repo',prNumber:42,env:{},workerObservationSyncImpl:selector=>{
    assert.equal(selector.builder_identity,true);
    assert.equal(selector.pr_number,42);
    assert.equal(selector.head_sha,undefined);
    return {schema_version:1,observation:'provenance',status:'found',complete:true,next_offset:null,
      scope_complete:false,mutation_authority:false,items:[{launch_request_id:'launch',
        worker_class:'worker',actual_harness:'codex'}]};
  }};
  const expected={ok:true,launchRequestId:'launch',workerClass:'worker',actualHarness:'codex'};
  assert.deepEqual(readPrBuilderProvenance({...args,headSha:'original'}),expected);
  assert.deepEqual(readPrBuilderProvenance({...args,headSha:'current'}),expected);
});
for(const reply of [null, {}, {schema_version:1,observation:'provenance',status:'not_found',complete:true,
  next_offset:null,scope_complete:false,mutation_authority:false,items:[]}]) {
  test('unavailable or grant-filtered empty provenance defers builder routing',()=>{
    const provenance=readPrBuilderProvenance({repo:'example/repo',prNumber:42,env:{},
      workerObservationSyncImpl:()=>reply});
    assert.equal(provenance.ok,false);
    assert.equal(provenance.deferClaim,true);
    assert.equal(reconcileBuilderClass({builderClass:'codex'},provenance).deferClaim,true);
  });
}

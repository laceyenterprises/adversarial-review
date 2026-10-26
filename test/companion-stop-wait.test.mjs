import { assertHoldRecord } from '../src/ama/hold-record.mjs';
import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateHammerStopHold, readHammerStopForHead } from '../src/ama/hammer-stop-hold.mjs';
import { COMPANION_FLOAT_WAIT_MS, companionOnlyStop, probeCompanionWait } from '../src/ama/companion-stop-wait.mjs';
import { recordHammerRetryDispatch, readHammerRetryCapLedger } from '../src/ama/hammer-retry-cap.mjs';

const head = 'a'.repeat(40), base = 'b'.repeat(40), merge = 'c'.repeat(40), link = 'd'.repeat(40);
const companion = { repo: 'example/component', prNumber: 7, submodulePath: 'tools/component' };
const start = Date.parse('2026-01-01T00:00:00Z');
const at = ms => new Date(start + ms).toISOString();
const logger = { log() {}, warn() {}, error() {} };

function fixture(t, { structured = true } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'companion-wait-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const pages = [], calls = [];
  const live = { state: 'open', merged: false, link: base, compare: 'behind', fail: null,
    submoduleUrl: 'https://github.com/example/component.git', comparisonBase: merge };
  const attempts = [{ outcome: 'failed-without-merge', reason: 'companion-submodule-pr-unmerged', head,
    path: 'hammer', launchRequestId: 'wait-1', startedAt: at(0),
    closingStatus: 'Await companion https://github.com/example/component/pull/7',
    ...(structured ? { companionWait: companion } : {}) }];
  const args = { rootDir, hqRoot: rootDir, repo: 'example/project', prNumber: 3, headSha: head,
    now: at(0), logger, prMetadata: { isOpen: true, headSha: head, baseSha: base },
    readAuditImpl: () => ({ attempts }),
    deliverAlertImpl: async (text, options) => pages.push({ text, options }),
    execFileImpl: async (cmd, argv, options) => {
      assert.equal(cmd, 'gh');
      assert.ok(options.timeout <= 15_000);
      const endpoint = argv[1];
      calls.push(endpoint);
      if (live.fail && endpoint.includes(live.fail)) throw new Error('synthetic read failure');
      let value;
      if (endpoint === 'repos/example/project/pulls/3') value = { state: 'open', head: { sha: head }, base: { sha: base } };
      else if (endpoint.includes('/contents/.gitmodules')) value = { content: Buffer.from(`[submodule "component"]\n path = tools/component\n url = ${live.submoduleUrl}\n`).toString('base64') };
      else if (endpoint === 'repos/example/component/pulls/7') value = { state: live.state,
        merged_at: live.merged ? at(60_000) : null, merge_commit_sha: live.merged ? merge : null };
      else if (endpoint.includes('/contents/tools/component?ref=')) value = { sha: live.link, submodule_git_url: live.submoduleUrl };
      else if (endpoint.includes('/compare/')) value = { status: live.compare, merge_base_commit: { sha: live.compare === 'ahead' ? live.comparisonBase : base } };
      else assert.fail(`unexpected API: ${endpoint}`);
      return { stdout: JSON.stringify(value) };
    } };
  const evaluate = overrides => evaluateHammerStopHold({ ...args, ...overrides });
  const entry = () => JSON.parse(readFileSync(join(rootDir, 'data/follow-up-jobs/hammer-stop-hold/example-project-pr-3.json'), 'utf8')).heads[head];
  return { args, attempts, live, calls, pages, evaluate, entry };
}

test('COMPANIONFLOAT-01 open companion ignores unrelated inputs and refunds only exact pure-wait charges once', async t => {
  const f = fixture(t);
  const id = { repo: f.args.repo, prNumber: 3 };
  for (const [launchRequestId, reason] of [['real-1', 'ci-not-green'], ['wait-1', 'companion-submodule-pr-unmerged'], ['wait-2', 'companion-float-pending']]) {
    recordHammerRetryDispatch(f.args.rootDir, id, { jobKey: head, headSha: head, launchRequestId, now: at(0) });
    if (launchRequestId !== 'wait-1') f.attempts.push({ ...f.attempts[0], reason, launchRequestId });
  }
  for (const ms of [0, 600_000, 3600_000]) {
    const result = await f.evaluate({ now: at(ms), prMetadata: { ...f.args.prMetadata,
      baseSha: link, mergeableState: 'CONFLICTING', statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }] } });
    assert.equal(result.action, 'hold');
    assert.equal(result.hammerStop.owner, 'closure-recovery');
    assert.match(result.hammerStop.closingStatus, /awaiting companion-merge.*example\/component PR 7/);
    assert.doesNotMatch(result.hammerStop.closingStatus, /operator follow-through|terminal HAM/);
    const ledger = readHammerRetryCapLedger(f.args.rootDir, id);
    assert.equal(ledger.attemptCount, 1);
    assert.equal(ledger.targetAttemptCount, 1);
    assert.equal(ledger.lifetimeAttemptCount, 1);
    assert.equal(ledger.dispatchCharges['real-1'].companionWaitRefund, undefined);
  }
  assertHoldRecord(f.entry());
  assert.equal(f.entry().mode, 'companion');
  assert.equal(f.entry().retryAfter, undefined);
  assert.equal(f.pages.length, 0);
  assert.equal(f.calls.some(call => call.includes('/contents/tools/')), false);
});

test('COMPANIONFLOAT-01 observes merge, waits for ancestry in base, persists both events across restart', async t => {
  const f = fixture(t);
  await f.evaluate();
  f.live.merged = true;
  f.live.state = 'closed';
  assert.equal((await f.evaluate({ now: at(120_000) })).action, 'hold');
  assert.equal(f.entry().companionWait.mergeCommit, merge);
  assert.equal(f.entry().events.companionMergedAt, at(120_000));
  assert.equal(f.entry().awaitedEvent, 'base-gitlink-contains-merge');
  f.live.link = link;
  f.live.compare = 'ahead';
  assert.deepEqual((await f.evaluate({ now: at(180_000) })).changed, ['companion-floated']);
  assert.equal(f.entry().events.companionFloatedAt, at(180_000));
  assert.equal((await f.evaluate({ now: at(240_000) })).action, 'release');
  assert.equal(f.entry().releasedAt, at(180_000));
  f.live.fail = '/compare/';
  assert.equal((await f.evaluate({ now: at(300_000) })).action, 'hold', 'unreadable current base cannot reuse stale release');
  assert.equal(f.entry().companionWait.mergeCommit, merge, 'merge identity survives a failed ancestry read');
});

for (const gitlink of [merge, link]) test(`COMPANIONFLOAT-01 git protocol releases a floated companion at ${gitlink === merge ? 'merge' : 'descendant'}`, async t => {
  const f = fixture(t);
  f.live.submoduleUrl = 'git://github.com/example/component.git';
  f.live.merged = true;
  f.live.state = 'closed';
  f.live.link = gitlink;
  f.live.compare = 'ahead';
  assert.equal((await f.evaluate({ now: at(120_000) })).action, 'release');
  assert.equal(f.entry().companionWait.containsMerge, true);
  assert.equal(f.entry().probeError, undefined);
  assert.deepEqual(f.entry().releasedBy, ['companion-floated']);
});

for (const cause of ['closed', 'late', 'unreadable']) test(`COMPANIONFLOAT-01 ${cause} escalates once with companion and automated owner`, async t => {
  const f = fixture(t);
  await f.evaluate();
  if (cause === 'closed') f.live.state = 'closed';
  else if (cause === 'late') { f.live.merged = true; f.live.state = 'closed'; }
  else f.live.fail = '/pulls/7';
  const deadline = cause === 'closed' ? 60_000 : COMPANION_FLOAT_WAIT_MS + (cause === 'late' ? 60_000 : 0);
  await f.evaluate({ now: at(deadline - 1) });
  if (cause !== 'closed') assert.equal(f.pages.length, 0);
  await f.evaluate({ now: at(deadline) });
  await f.evaluate({ now: at(deadline + 600_000) });
  assert.equal(f.pages.length, 1);
  assert.match(f.pages[0].text, /Automated owner: closure-recovery.*example\/component PR 7/);
  assert.doesNotMatch(f.pages[0].text, /operator follow-through/);
});

test('COMPANIONFLOAT-01 legacy note resolves only a unique companion mapped by base .gitmodules', async t => {
  const f = fixture(t, { structured: false });
  assert.equal((await f.evaluate()).action, 'hold');
  assert.equal(f.entry().companionWait.repo, companion.repo);
  assert.equal(f.entry().companionWait.submodulePath, companion.submodulePath);
  assert.equal(f.calls.filter(call => call.includes('.gitmodules')).length, 1);
  await f.evaluate();
  assert.equal(f.calls.filter(call => call.includes('.gitmodules')).length, 1, 'persisted dependency avoids rediscovery');
});

test('COMPANIONFLOAT-01 legacy note resolves a git protocol base submodule', async t => {
  const f = fixture(t, { structured: false });
  f.live.submoduleUrl = 'git://github.com/example/component.git';
  assert.equal((await f.evaluate()).action, 'hold');
  assert.equal(f.entry().companionWait.repo, companion.repo);
  assert.equal(f.entry().probeError, undefined);
});

for (const mismatch of ['wrong-repository', 'wrong-merge-base', 'unknown-comparison']) {
  test(`COMPANIONFLOAT-01 ${mismatch} cannot release a merged companion`, async t => {
    const f = fixture(t);
    f.live.merged = true;
    f.live.state = 'closed';
    f.live.link = link;
    f.live.compare = 'ahead';
    if (mismatch === 'wrong-repository') f.live.submoduleUrl = 'https://github.com/example/other.git';
    if (mismatch === 'wrong-merge-base') f.live.comparisonBase = base;
    if (mismatch === 'unknown-comparison') f.live.compare = null;
    assert.equal((await f.evaluate()).action, 'hold');
    assert.equal(f.entry().companionWait.mergeCommit, merge);
    assert.equal(f.entry().releasedAt, undefined);
  });
}

test('COMPANIONFLOAT-01 mixed stops, unknown references and stale parent stay fail closed', async t => {
  assert.equal(companionOnlyStop({ reason: 'companion-float-pending', eligibilityTrace: { reasons: ['ci-not-green'] } }), false);
  const f = fixture(t, { structured: false });
  f.attempts[0].closingStatus = 'companion not identified';
  assert.equal((await f.evaluate()).action, 'hold');
  assert.equal(f.entry().probeError, 'companion evidence unreadable');
  await assert.rejects(probeCompanionWait({ ...f.args, stop: {}, prior: null,
    execFileImpl: async () => ({ stdout: JSON.stringify({ state: 'closed', head: { sha: head } }) }) }), /changed or terminal/);
  const stop = readHammerStopForHead(f.args);
  assert.equal(stop.companionWait, null);
});

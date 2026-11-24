import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fsExt from 'fs-ext';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withHammerPublication, activeHammerPublication, retireHammerPublication, settleHammerRebasePublication, hammerPublicationPath } from '../src/ama/hammer-publication-ownership.mjs';
import { getHeadCloserCommitSuppression } from '../src/head-closer-commit-suppression.mjs';
import { hammerHeadOwnership } from '../src/hammer-head-ownership.mjs';
import { requestCloserSuccessor, settleCloserSuccessor, readCloserSuccessor, closerSuccessorPath } from '../src/ama/closer-successor.mjs';
import { acquireMergeLease, releaseMergeLease } from '../src/ama/merge-lease.mjs';

const NOW = '2030-01-01T00:00:00.000Z';
const HEAD = 'a'.repeat(40), OTHER = 'b'.repeat(40);
function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'closer-race-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const controllerRecord = join(rootDir, 'controller.json');
  const controller = { schemaVersion: 1, state: 'running', controllerPid: 12345, startedAt: NOW, token: 'synthetic' };
  const save = () => writeFileSync(controllerRecord, JSON.stringify(controller));
  save();
  const identity = { rootDir, repo: 'fixture/repo', prNumber: 1 };
  return { ...identity, controller, save, env: { HAM_CONTROLLER_RECORD: controllerRecord,
    HAM_CONTROLLER_PID: '12345', HAM_CONTROLLER_TOKEN: 'synthetic' }, now: NOW };
}
const probe = f => activeHammerPublication({ ...f, headSha: HEAD, now: Date.parse(NOW), isAlive: () => true });

test('an unavailable local Git head refuses publication before any remote mutation', async t => {
  const f = fixture(t);
  for (const headSha of ['', 'not-a-head']) {
    await assert.rejects(withHammerPublication({ ...f, headSha },
      async () => assert.fail('must establish the local head before publishing')), /hammer-publication-head-unavailable/);
  }
});

test('publication intent precedes a trailerless git push and suppresses only its exact head', async t => {
  const f = fixture(t);
  await withHammerPublication({ ...f, headSha: HEAD }, async () => {
    assert.equal(probe(f).reason, 'closer-publication-in-progress');
    return { head: HEAD };
  });
  assert.equal(probe(f).reason, 'active-closer-published-head');
  assert.ok(hammerHeadOwnership(probe(f), HEAD));
  assert.equal(activeHammerPublication({ ...f, headSha: OTHER, now: Date.parse(NOW), isAlive: () => true }), null);
  const suppression = await getHeadCloserCommitSuppression({ repoPath: f.repo, prNumber: f.prNumber, headSha: HEAD,
    rootDir: f.rootDir, activeHammerPublicationImpl: () => probe(f),
    fetchVerifiedCommitFromLocalGitImpl: () => assert.fail('must suppress before reading worker trailers') });
  assert.equal(suppression.reason, 'active-closer-published-head');
  retireHammerPublication(f.rootDir, f);
  assert.equal(probe(f), null, 'confirmed merged release ends custody before controller exit');
  f.controller.state = 'quiescent'; f.save();
  assert.equal(probe(f), null, 'merged/exited controller leaves no stale deferral');
});

test('server-generated head is recorded before releasing the publication barrier', async t => {
  const f = fixture(t);
  await withHammerPublication(f, async () => {
    assert.equal(probe(f).reason, 'closer-publication-in-progress');
    return { head: HEAD };
  });
  assert.equal(probe(f).reason, 'active-closer-published-head');
  assert.equal(hammerHeadOwnership({ suppressed: true, reason: 'closer-publication-in-progress', headSha: HEAD }, HEAD), null);
});

test('fallback CAS input grants no publication custody; a returned partial publication does', async t => {
  const f = fixture(t);
  await withHammerPublication(f, async () =>
    ({ route: 'git-fallback', fallbackHead: OTHER }));
  assert.deepEqual(JSON.parse(readFileSync(hammerPublicationPath(f.rootDir, f), 'utf8')).heads, []);
  await withHammerPublication(f, async () =>
    ({ route: 'refused', observedHead: HEAD, mutationUncertain: true }));
  const record = JSON.parse(readFileSync(hammerPublicationPath(f.rootDir, f), 'utf8'));
  assert.deepEqual(record.heads, [HEAD]);
  assert.equal(probe(f).reason, 'active-closer-published-head');
  assert.equal(activeHammerPublication({ ...f, headSha: OTHER, now: Date.parse(NOW), isAlive: () => true }), null);
});

test('dead or expired controller never retains publication custody', async t => {
  const f = fixture(t);
  await withHammerPublication({ ...f, headSha: HEAD }, async () => ({}));
  assert.equal(activeHammerPublication({ ...f, headSha: HEAD, now: Date.parse(NOW), isAlive: () => false }), null);
  assert.equal(activeHammerPublication({ ...f, headSha: HEAD, now: Date.parse(NOW) + 7 * 3600_000, isAlive: () => true }), null);
});

test('exact merge lease suppresses trailerless head; another push and merged release do not', t => {
  const f = fixture(t);
  const acquired = acquireMergeLease({ ...f, base: 'main', holderPr: 1, holderHead: HEAD,
    holderPid: process.pid, holderRole: 'closer', now: NOW, acquiredAt: NOW });
  assert.equal(acquired.acquired, true);
  const inspectLeaseImpl = () => ({ holder: acquired.lease, pastDeadline: false, holderLiveness: 'live' });
  assert.equal(activeHammerPublication({ ...f, headSha: HEAD, now: Date.parse(NOW), inspectLeaseImpl }).reason, 'active-closer-merge-lease');
  assert.equal(activeHammerPublication({ ...f, headSha: OTHER, now: Date.parse(NOW), inspectLeaseImpl }), null);
  releaseMergeLease({ ...f, base: 'main', leaseId: acquired.lease.leaseId, holderPr: 1,
    holderHead: HEAD, acquiredAt: acquired.lease.acquiredAt, merged: true, now: NOW, requestWatcherWakeImpl: () => {} });
  assert.equal(activeHammerPublication({ ...f, headSha: HEAD, now: Date.parse(NOW), inspectLeaseImpl }), null);
});

test('exhausted no-merge enrolls exactly one successor with the refusing review', async t => {
  const f = fixture(t);
  const reviewBody = '## Non-blocking issues\n- [P2] Preserve the original error.\n\n## Verdict\nComment only';
  const input = { ...f, headSha: HEAD, reviewBody, refusingReasons: ['non-blocking-findings-present'], source: 'closer-ended-without-merge' };
  let enrollments = 0;
  const handoffImpl = async args => { enrollments++; assert.equal(args.reviewBody, reviewBody);
    return { remediation: { jobId: 'synthetic-successor' } }; };
  requestCloserSuccessor(input);
  const first = await settleCloserSuccessor({ ...input, handoffImpl });
  requestCloserSuccessor(input);
  const second = await settleCloserSuccessor({ ...input, handoffImpl });
  assert.equal(first.status, 'successor-enrolled');
  assert.equal(second.successorJobId, first.successorJobId);
  assert.equal(enrollments, 1);
});

test('a successor request recreates a receipt removed before the locked read', t => {
  const f = fixture(t);
  const input = { ...f, headSha: HEAD, reviewBody: 'Current refusing findings.',
    refusingReasons: ['findings-present'], source: 'follow-up-pre-claim-cap' };
  const flockSync = fsExt.flockSync;
  let removed = false;
  const lock = t.mock.method(fsExt, 'flockSync', (fd, mode) => {
    flockSync(fd, mode);
    rmSync(closerSuccessorPath(f.rootDir, input));
    removed = true;
  });
  const record = requestCloserSuccessor(input);
  lock.mock.restore();
  assert.equal(removed, true);
  assert.equal(record.status, 'successor-pending');
  assert.equal(record.reviewBody, input.reviewBody);
  assert.deepEqual(record.refusingReasons, input.refusingReasons);
  assert.equal(record.requestedAt, NOW);
  assert.deepEqual(readCloserSuccessor(f.rootDir, input), record);
});

test('successor settlement defers if its receipt disappears before the locked read', async t => {
  const f = fixture(t);
  const input = { ...f, headSha: HEAD, reviewBody: 'Current refusing findings.', source: 'follow-up-pre-claim-cap' };
  requestCloserSuccessor(input);
  const flockSync = fsExt.flockSync;
  const lock = t.mock.method(fsExt, 'flockSync', (fd, mode) => {
    flockSync(fd, mode);
    rmSync(closerSuccessorPath(f.rootDir, input));
  });
  const result = await settleCloserSuccessor({ ...input,
    handoffImpl: async () => assert.fail('an absent receipt cannot dispatch'),
    observeWaitImpl: async () => assert.fail('an absent receipt cannot publish a refusal') });
  lock.mock.restore();
  assert.deepEqual(result, { status: 'successor-pending' });
  assert.equal(readCloserSuccessor(f.rootDir, input), null);
  assert.equal(requestCloserSuccessor(input).status, 'successor-pending', 'the receipt lock was released');
});

for (const disabled of [false, true]) test(`successor ${disabled ? 'disabled' : 'refused'} records typed ownerless state and alerts`, async t => {
  const f = fixture(t), pages = [];
  const input = { ...f, headSha: HEAD, reviewBody: 'Synthetic refusing review', source: 'follow-up-pre-claim-cap' };
  requestCloserSuccessor(input);
  const result = await settleCloserSuccessor({ ...input, enabled: !disabled,
    handoffImpl: async () => ({ action: 'fallback' }), observeWaitImpl: async args => pages.push(args) });
  assert.equal(result.status, 'needs-closer');
  assert.equal(readCloserSuccessor(f.rootDir, input).status, result.status);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].immediate, true);
});

test('a pending cap request uses the current refusing findings without another enrollment', async t => {
  const f = fixture(t), input = { ...f, headSha: HEAD, source: 'follow-up-pre-claim-cap' };
  requestCloserSuccessor({ ...input, reviewBody: 'Earlier findings.' });
  requestCloserSuccessor({ ...input, reviewBody: 'Current refusing findings.', refusingReasons: ['findings-present'] });
  let jobs = 0;
  const handoffImpl = async args => {
    jobs++;
    assert.equal(args.reviewBody, 'Current refusing findings.');
    return { remediation: { jobId: 'synthetic-successor' } };
  };
  await settleCloserSuccessor({ ...input, handoffImpl });
  requestCloserSuccessor({ ...input, reviewBody: 'A repeated request.' });
  await settleCloserSuccessor({ ...input, handoffImpl });
  assert.equal(jobs, 1);
});

test('a dispatch exception still persists and alerts typed ownerlessness', async t => {
  const f = fixture(t), input = { ...f, headSha: HEAD, source: 'closer-ended-without-merge' };
  requestCloserSuccessor({ ...input, reviewBody: 'Synthetic refusing finding.' });
  const alerts = [];
  const result = await settleCloserSuccessor({ ...input, handoffImpl: async () => { throw null; },
    observeWaitImpl: async args => alerts.push(args) });
  assert.equal(result.status, 'needs-closer');
  assert.equal(result.reason, 'successor-dispatch-failed');
  assert.equal(readCloserSuccessor(f.rootDir, input).status, result.status);
  assert.equal(alerts.length, 1);
});

test('ambiguous publication retains a typed probe deferral only until controller exit', async t => {
  const f = fixture(t);
  await assert.rejects(withHammerPublication(f, async beginMutation => { beginMutation(); throw new Error('synthetic transport failure'); }));
  assert.equal(probe(f).reason, 'closer-publication-unconfirmed');
  assert.equal(hammerHeadOwnership(probe(f), HEAD), null, 'uncertainty grants no head authority');
  f.controller.state = 'quiescent'; f.save();
  assert.equal(probe(f), null);
});

test('a publisher crash leaves durable intent deferred until its controller ends', async t => {
  const f = fixture(t);
  await withHammerPublication(f, async () => ({}));
  const path = hammerPublicationPath(f.rootDir, f);
  const record = JSON.parse(readFileSync(path, 'utf8'));
  // Simulate process death after durable intent but before mutation settlement;
  // the OS releases flock without executing the publisher's finally block.
  writeFileSync(path, JSON.stringify({ ...record, publishing: true, heads: [] }));
  assert.equal(probe(f).reason, 'closer-publication-unconfirmed');
  f.controller.state = 'quiescent'; f.save();
  assert.equal(probe(f), null);
});


test('old-head server acknowledgment stays behind the barrier through fake-clock visibility and full-tree proof', async t => {
  const f = fixture(t), events = [], base = 'c'.repeat(40);
  let reads = 0;
  await withHammerPublication(f, async () => {
    const result = { data: { updatePullRequestBranch: { pullRequest: { headRefOid: OTHER } } } };
    const head = await settleHammerRebasePublication({ result, oldHead: OTHER, base,
      readHead: async () => {
        assert.equal(probe(f).reason, 'closer-publication-in-progress');
        return ++reads === 1 ? OTHER : HEAD;
      },
      git: async () => { throw new Error('base not yet contained'); },
      fetchHead: async value => events.push(['fetch', value]),
      proveImpl: async input => { events.push(['proof', input.oldHead, input.head, input.base]); return {}; },
      sleep: async ms => events.push(['sleep', ms]) });
    assert.equal(result.data.updatePullRequestBranch.pullRequest.headRefOid, HEAD);
    return { head };
  });
  assert.deepEqual(events, [['sleep', 5000], ['fetch', HEAD], ['proof', OTHER, HEAD, base]]);
  assert.equal(probe(f).reason, 'active-closer-published-head');
});

test('an unproven asynchronous rebase result never acquires exact-head custody', async t => {
  const f = fixture(t);
  await assert.rejects(withHammerPublication(f, async () => {
    const result = { data: { updatePullRequestBranch: { pullRequest: { headRefOid: OTHER } } } };
    const head = await settleHammerRebasePublication({ result, oldHead: OTHER, base: 'c'.repeat(40),
      readHead: async () => HEAD, fetchHead: async () => {}, git: async () => '',
      proveImpl: async () => null, sleep: async () => assert.fail('no visibility delay needed') });
    return { head };
  }), /rebase-result-unproven/);
  assert.equal(hammerHeadOwnership(probe(f), HEAD), null);
});

test('AMASTRICTROUTE-01: refused successor admission leaves a durable needs-closer receipt', async t => {
  const f = fixture(t), input = { ...f, headSha: HEAD, source: 'closer-ended-without-merge' };
  requestCloserSuccessor({ ...input, reviewBody: 'Synthetic refusing finding.' });
  const result = await settleCloserSuccessor({ ...input, admitted: false,
    handoffImpl: async () => assert.fail('refused admission cannot dispatch'), observeWaitImpl: async () => {} });
  assert.equal(result.reason, 'successor-admission-refused');
  assert.equal(result.status, 'needs-closer');
  assert.deepEqual(readCloserSuccessor(f.rootDir, input), result);
});

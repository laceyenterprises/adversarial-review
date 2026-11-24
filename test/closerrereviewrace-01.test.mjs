import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fsExt from 'fs-ext';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withHammerPublication, activeHammerPublication, retireHammerPublication, settleHammerRebasePublication, hammerPublicationPath } from '../src/ama/hammer-publication-ownership.mjs';
import { getHeadCloserCommitSuppression } from '../src/head-closer-commit-suppression.mjs';
import { hammerHeadOwnership } from '../src/hammer-head-ownership.mjs';
import { requestCloserSuccessor, settleCloserSuccessor, readCloserSuccessor, closerSuccessorPath, createCloserSuccessorDeadlineSweep } from '../src/ama/closer-successor.mjs';
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

test('successor deadline survives repeated poll updates, including during the live-head read', async t => {
  const f = fixture(t), input = { ...f, headSha: HEAD, source: 'closer-ended-without-merge' };
  requestCloserSuccessor(input);
  const start = Date.parse(NOW), pages = [], probes = [];
  const settleAt = elapsed => assert.rejects(settleCloserSuccessor({ ...input, admitted: false,
    now: new Date(start + elapsed).toISOString(),
    observeWaitImpl: async () => { throw new Error('synthetic delivery failure'); } }), /synthetic delivery failure/);
  for (let elapsed = 30_000; elapsed < 1_800_000; elapsed += 30_000) await settleAt(elapsed);
  const sweepAt = async elapsed => {
    const sweep = createCloserSuccessorDeadlineSweep({ rootDir: f.rootDir, now: () => start + elapsed,
      readLive: async () => {
        probes.push(elapsed);
        await settleAt(elapsed); // The locked recheck must use the original request too.
        return { state: 'open', headRefOid: HEAD };
      },
      observeWaitImpl: async args => pages.push(args) });
    try { await sweep.tick(); } finally { await sweep.stop(); }
  };
  await sweepAt(1_799_999);
  assert.deepEqual(probes, []);
  assert.deepEqual(pages, []);
  await sweepAt(1_800_000);
  assert.deepEqual(probes, [1_800_000]);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].reason, 'closer-successor-overdue');
  const receipt = readCloserSuccessor(f.rootDir, input);
  assert.equal(receipt.requestedAt, NOW);
  assert.equal(receipt.updatedAt, new Date(start + 1_800_000).toISOString());
});

test('hammer fallback owns its receipt between launches and at the retry cap', async t => {
  const f = fixture(t), input = { ...f, headSha: HEAD, source: 'closer-ended-without-merge' };
  requestCloserSuccessor(input);
  const result = await settleCloserSuccessor({ ...input, allowHammerFallback: true,
    handoffImpl: async () => ({ action: 'fallback' }) });
  assert.equal(result.action, 'fallback');
  assert.equal(readCloserSuccessor(f.rootDir, input).fallbackAt, NOW);
  let probes = 0;
  const sweep = createCloserSuccessorDeadlineSweep({ rootDir: f.rootDir,
    now: () => Date.parse(NOW) + 86_400_000,
    readLive: async () => { probes++; return { state: 'open', headRefOid: HEAD }; },
    hasLiveCloserImpl: async () => assert.fail('retirement-only probes do not read the ledger'),
    observeWaitImpl: async () => assert.fail('hammer owns retry gaps and cap escalation') });
  try { await sweep.tick(); await sweep.tick(); } finally { await sweep.stop(); }
  assert.equal(probes, 1);
  await settleCloserSuccessor({ ...input, admitted: false, observeWaitImpl: async () => {} });
  const refused = readCloserSuccessor(f.rootDir, input);
  assert.equal(refused.fallbackAt, undefined, 'another disposition returns custody to the successor path');
  assert.equal(refused.escalatedAt, NOW);
});

for (const disposition of ['escalated', 'enrolled', 'fallback']) {
  test(`the sweep retires and prunes ${disposition} receipts after head movement or closure`, async t => {
    const f = fixture(t), input = { ...f, headSha: HEAD, source: 'closer-ended-without-merge' };
    requestCloserSuccessor(input);
    await settleCloserSuccessor({ ...input, allowHammerFallback: true,
      handoffImpl: async () => disposition === 'enrolled' ? { remediation: { jobId: 'synthetic-successor' } }
        : disposition === 'fallback' ? { action: 'fallback' } : { reason: 'synthetic-refusal' },
      observeWaitImpl: async () => {} });
    const day = 86_400_000;
    let elapsed = day, probes = 0;
    let live = { state: 'open', headRefOid: HEAD };
    const sweep = createCloserSuccessorDeadlineSweep({ rootDir: f.rootDir, now: () => Date.parse(NOW) + elapsed,
      readLive: async () => { probes++; return live; },
      hasLiveCloserImpl: async () => assert.fail('retirement does not read custody'),
      observeWaitImpl: async () => assert.fail('retirement does not page') });
    t.after(() => sweep.stop());
    await sweep.tick();
    assert.equal(probes, 1);
    live = disposition === 'fallback' ? { state: 'open', headRefOid: 'b'.repeat(40) } : { state: 'merged' };
    elapsed += day - 1;
    await sweep.tick();
    assert.equal(probes, 1);
    elapsed++;
    await sweep.tick();
    assert.equal(probes, 2);
    assert.equal(Date.parse(readCloserSuccessor(f.rootDir, input).retiredAt), Date.parse(NOW) + elapsed);
    elapsed += 7 * day;
    await sweep.tick();
    assert.equal(readCloserSuccessor(f.rootDir, input), null);
    assert.equal(probes, 2, 'pruning uses the locked receipt, without a network read');
  });
}

test('overdue live or unreadable heads back off for five minutes across sweep restarts', async t => {
  const f = fixture(t), input = { ...f, headSha: HEAD, source: 'closer-ended-without-merge' };
  requestCloserSuccessor(input);
  let elapsed = 1_800_000, probes = 0, ledgerReads = 0, pages = 0;
  const tick = async () => {
    const sweep = createCloserSuccessorDeadlineSweep({ rootDir: f.rootDir, now: () => Date.parse(NOW) + elapsed,
      readLive: async () => {
        if (++probes === 2) throw new Error('synthetic unavailable PR read');
        return { state: 'open', headRefOid: HEAD };
      },
      hasLiveCloserImpl: async () => ++ledgerReads === 1,
      observeWaitImpl: async () => { pages++; },
      logger: { warn() {} },
    });
    try { await sweep.tick(); } finally { await sweep.stop(); }
  };
  await tick();
  assert.deepEqual([probes, ledgerReads, pages], [1, 1, 0]);
  for (const expected of [[2, 1, 0], [3, 2, 1]]) {
    elapsed += 299_999;
    const previous = [probes, ledgerReads, pages];
    await tick();
    assert.deepEqual([probes, ledgerReads, pages], previous);
    elapsed++;
    await tick();
    assert.deepEqual([probes, ledgerReads, pages], expected);
  }
});

test('successful successor pages stop probes across restarts; failed delivery remains retryable', async t => {
  const f = fixture(t), input = { ...f, headSha: HEAD, source: 'closer-ended-without-merge' };
  requestCloserSuccessor(input);
  let pages = 0, probes = 0, fail = true;
  const sweepAt = async () => {
    const sweep = createCloserSuccessorDeadlineSweep({ rootDir: f.rootDir,
      now: () => Date.parse(NOW) + 1_800_000,
      readLive: async () => { probes++; return { state: 'open', headRefOid: HEAD }; },
      hasLiveCloserImpl: async () => false,
      observeWaitImpl: async () => { if (fail) throw new Error('synthetic delivery failure'); pages++; },
      logger: { warn() {} } });
    try { await sweep.tick(); } finally { await sweep.stop(); }
  };
  await sweepAt();
  assert.equal(readCloserSuccessor(f.rootDir, input).escalatedAt, undefined);
  fail = false;
  await sweepAt();
  await sweepAt();
  assert.equal(pages, 1);
  assert.equal(probes, 2);
  assert.equal(readCloserSuccessor(f.rootDir, input).escalatedAt, '2030-01-01T00:30:00.000Z');
  let dispatches = 0;
  await settleCloserSuccessor({ ...input, handoffImpl: async () => {
    dispatches++; return { remediation: { jobId: 'synthetic-successor' } };
  } });
  assert.equal(dispatches, 1, 'escalation does not block later admission');
});

test('retired receipt TTL prunes under the exclusive lock and fresh admission preserves custody', async t => {
  const f = fixture(t), input = { ...f, headSha: HEAD, source: 'closer-ended-without-merge' };
  const record = requestCloserSuccessor(input), path = closerSuccessorPath(f.rootDir, input);
  const sweepAt = async elapsed => {
    const sweep = createCloserSuccessorDeadlineSweep({ rootDir: f.rootDir, now: () => Date.parse(NOW) + elapsed,
      readLive: async () => assert.fail('retired receipts need no GitHub probe') });
    try { await sweep.tick(); } finally { await sweep.stop(); }
  };
  writeFileSync(path, JSON.stringify({ ...record, retiredAt: NOW }));
  const ttl = 7 * 86_400_000;
  await sweepAt(ttl - 1);
  assert.ok(readCloserSuccessor(f.rootDir, input));
  const fd = openSync(`${path}.lock`, 'a');
  try {
    fsExt.flockSync(fd, 'exnb');
    await sweepAt(ttl);
    assert.ok(readCloserSuccessor(f.rootDir, input), 'contended receipts cannot be pruned');
  } finally { closeSync(fd); }
  await settleCloserSuccessor({ ...input, allowHammerFallback: true,
    handoffImpl: async () => ({ action: 'fallback' }) });
  await sweepAt(ttl);
  assert.equal(readCloserSuccessor(f.rootDir, input).retiredAt, undefined);
  writeFileSync(path, JSON.stringify({ ...record, retiredAt: NOW }));
  await sweepAt(ttl);
  assert.equal(readCloserSuccessor(f.rootDir, input), null);
  assert.equal(existsSync(`${path}.lock`), false);
  writeFileSync(`${path}.lock`, ''); // Legacy orphan from a prior cleanup.
  await sweepAt(ttl);
  assert.equal(existsSync(`${path}.lock`), false);
  assert.equal(requestCloserSuccessor(input).status, 'successor-pending');
});

for (const [name, probe] of [
  ['unknown ledger evidence', async () => null],
  ['thrown liveness read', async () => { throw new Error('ledger unavailable'); }],
]) {
  test(`successor deadline backs off on ${name} and pages only after confirmed absence`, async t => {
    const f = fixture(t), input = { ...f, headSha: HEAD, source: 'closer-ended-without-merge' };
    requestCloserSuccessor(input);
    const due = Date.parse(NOW) + 1_800_000;
    let now = due, reads = 0, pages = 0;
    const run = async () => {
      const sweep = createCloserSuccessorDeadlineSweep({ rootDir: f.rootDir, now: () => now,
        readLive: async () => { reads++; return { state: 'open', headRefOid: HEAD }; },
        hasLiveCloserImpl: async () => now === due ? probe() : false,
        observeWaitImpl: async () => { pages++; }, logger: {} });
      try { await sweep.tick(); } finally { await sweep.stop(); }
    };
    await run();
    const receipt = readCloserSuccessor(f.rootDir, input);
    assert.equal(Date.parse(receipt.lastProbedAt), due);
    assert.equal(receipt.escalatedAt, undefined);
    now += 299_999;
    await run();
    assert.deepEqual({ reads, pages }, { reads: 1, pages: 0 });
    now++;
    await run();
    assert.deepEqual({ reads, pages }, { reads: 2, pages: 1 });
  });
}

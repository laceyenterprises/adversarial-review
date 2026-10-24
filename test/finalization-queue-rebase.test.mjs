import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createQueueRebaseService, REBASE_DIVERGENCE_WARNING } from '../src/finalization/queue-rebase.mjs';
import { createQueueAdmissionService } from '../src/finalization/queue-admission.mjs';
import { createQueueOwner } from '../src/finalization/queue-owner.mjs';
import { probeQueueOwner } from '../src/finalization/queue-probe.mjs';
import { foldQueue } from '../src/finalization/ledger-fold.mjs';
import { queueWaitMs } from '../src/finalization/queue-wait.mjs';
import { MAX_TIMER_DELAY_MS } from '../src/load-aware-timeout.mjs';
import { gitFixture, admitted, idle } from './helpers/queue-rebase-fixture.mjs';
import { handoffTime } from './helpers/queue-handoff-fixture.mjs';

function service(f, a, { git = f.adapter, read, owner = a.owner, load = idle, policy } = {}) {
  return createQueueRebaseService({ store: f.store, owner, gitAdapter: git, now: f.now, load, policy,
    liveAdapter: { read: read ?? (async () => {
      a.live.subject.head = f.g(['--git-dir', f.remote, 'rev-parse', 'topic']);
      // The real live reader resolves structural evidence anew for this head.
      a.live.eligibility.primaryChange.headSha = a.live.subject.head;
      return structuredClone(a.live);
    }) } });
}
const run = (s, a) => s.run({ fence: a.fence, entryId: a.ack.entryId });

test('publishes proven candidate with durable intent/source, preserves receipt and resumes same SHA after restart', async t => {
  const f = gitFixture(t), a = await admitted(f);
  let pushes = 0, preparations = 0;
  const git = { ...f.adapter, prepare: async request => { preparations++; return f.adapter.prepare(request); },
    push: async request => {
      pushes++;
      const entry = f.store.readEntry(a.ack.entryId);
      assert.equal(entry.phase, 'publishing'); assert.ok(entry.proof); assert.equal(entry.rebase.warning, REBASE_DIVERGENCE_WARNING);
      const pending = f.store.operations(entry.lane); assert.equal(pending.length, 1);
      assert.equal(JSON.parse(pending[0].intent_json).expectedOldHead, f.oldHead);
      return f.adapter.push(request);
    } };
  const result = await run(service(f, a, { git }), a);
  assert.equal(result.phase, 'waiting-checks'); assert.equal(pushes, 1);
  assert.equal(result.rebase.publication.head, result.candidate);
  assert.equal(result.exactBase, f.base); assert.equal(result.expectedOldHead, f.oldHead);
  const receiptBefore = f.store.db.prepare('SELECT * FROM finalization_queue_clean_review').get();
  f.reopen(); a.owner = createQueueOwner({ store: f.store, now: f.now });
  const resumed = await run(service(f, a, { git }), a);
  assert.equal(resumed.candidate, result.candidate); assert.equal(resumed.phase, 'waiting-checks');
  assert.equal(pushes, 1); assert.equal(preparations, 1); assert.deepEqual(resumed.patience, result.patience);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM finalization_queue_clean_review').get(), receiptBefore);
  assert.deepEqual(foldQueue(f.store.readEvents(a.h.lane)).entries[result.entryId], resumed);
  const before = readFileSync(join(f.root, 'data/reviews.db'));
  const probe = probeQueueOwner({ rootDir: f.root, now: f.now(), load: idle });
  assert.equal(probe.capabilities.rebase.available, true); assert.ok(probe.runtime.build);
  assert.equal(probe.observations.rebase.published, 1); assert.equal(probe.observations.rebase.observations[0].candidate, result.candidate);
  assert.deepEqual(readFileSync(join(f.root, 'data/reviews.db')), before);
});

for (const denied of ['canForcePush', 'canWriteHeadRepository', 'maintainerCanModify', 'rulesSourceRef']) {
  test(`permission/fork preflight parks outside FIFO with named notice: ${denied}`, async t => {
    const f = gitFixture(t), a = await admitted(f);
    a.live.permission.fork = true;
    a.live.permission[denied] = denied === 'rulesSourceRef' ? null : false;
    let prepare = 0, push = 0;
    const git = { ...f.adapter, prepare: async () => { prepare++; }, push: async () => { push++; } };
    const result = await run(service(f, a, { git }), a);
    assert.equal(result.phase, 'parked-permission'); assert.ok(result.rebase.notice.key);
    assert.equal(result.rebase.notice.audience, 'author-and-operator');
    assert.equal(prepare, 0); assert.equal(push, 0);
  });
}

for (const labels of [['no-merge-hold'], null]) test(`fresh ${JSON.stringify(labels)} labels prevent publication after preparation`, async t => {
  const f = gitFixture(t), a = await admitted(f);
  let reads = 0, pushes = 0;
  const result = await run(service(f, a, { read: async () => {
    if (++reads === 2) a.live.subject.labels = labels;
    return structuredClone(a.live);
  }, git: { ...f.adapter, push: async () => { pushes++; } } }), a);
  assert.equal(result.phase, 'parked-hold'); assert.equal(pushes, 0); assert.ok(result.proof);
});

test('concurrent author pushes reject the exact old-head lease in 10 consecutive trials', async t => {
  for (let n = 0; n < 10; n++) {
    const f = gitFixture(t), a = await admitted(f);
    let author;
    const git = { ...f.adapter, push: async request => {
      f.g(['checkout', 'topic']); f.file('author', `author ${n}\n`); author = f.commit('author advanced');
      f.g(['push', f.remote, 'topic']);
      return f.adapter.push(request);
    } };
    const result = await run(service(f, a, { git }), a);
    assert.equal(result.phase, 'returned-to-closer'); assert.equal(result.reason, 'external-head-change');
    assert.equal(f.g(['--git-dir', f.remote, 'rev-parse', 'topic']), author);
    assert.equal(f.store.operations(a.h.lane).length, 0);
  }
  t.diagnostic('10/10 consecutive author-race trials rejected the leased candidate and retained author SHA');
});

for (const pushed of [false, true]) test(`crash ${pushed ? 'after' : 'before'} push keeps intent; takeover requires drain and resumes same candidate`, async t => {
  const f = gitFixture(t), a = await admitted(f);
  let candidate, prepares = 0;
  const crashingOwner = { issue: request => a.owner.issue({ ...request, invoke: async intent => {
    candidate = f.store.readEntry(a.ack.entryId);
    if (pushed) await f.adapter.push({ entry: candidate, intent });
    throw new Error('simulated process exit before result persistence');
  } }) };
  await assert.rejects(run(service(f, a, { owner: crashingOwner, git: { ...f.adapter,
    prepare: async request => { prepares++; return f.adapter.prepare(request); } } }), a), /simulated/);
  assert.equal(f.store.operations(a.h.lane).length, 1);
  await a.owner.renew({ fence: a.fence, expiresAt: handoffTime(50) });
  f.reopen(); f.clock(51);
  const denied = await createQueueOwner({ store: f.store, now: f.now }).claim({ lane: a.h.lane, ownerId: 'successor', expiresAt: handoffTime(5000) });
  assert.equal(denied.reason, 'prior-operation-quiescence-unproven');
  // Recovery's stop/drain proof is an injected external boundary; live head
  // alone is deliberately insufficient to assert quiescence.
  const recoveryAdapter = { stopDrainAndReconcile: async ({ operations }) => ({ quiescent: true, sourceRef: 'fixture:drained',
    results: Object.fromEntries(operations.map(op => [op.operation_id, { outcome: pushed ? 'succeeded' : 'not-applied', sourceRef: 'fixture:live-ref' }])) }) };
  // Owner is already parked; a recovery with outstanding intents can reclaim.
  a.owner = createQueueOwner({ store: f.store, now: f.now, recoveryAdapter });
  const claim = await a.owner.claim({ lane: a.h.lane, ownerId: 'successor', expiresAt: handoffTime(5000) });
  a.fence = claim.fence; assert.ok(a.fence);
  let pushes = 0;
  const git = { ...f.adapter, prepare: async () => { throw new Error('must reuse candidate'); },
    push: async request => { pushes++; return f.adapter.push(request); } };
  const result = await run(service(f, a, { git }), a);
  assert.equal(result.phase, 'waiting-checks'); assert.equal(result.candidate, candidate.candidate);
  assert.equal(result.exactBase, candidate.exactBase); assert.deepEqual(result.patience, candidate.patience);
  assert.equal(pushes, pushed ? 0 : 1); assert.equal(prepares, 1);
});

test('no-op retains head with explicit proof and makes no push', async t => {
  const f = gitFixture(t, { noop: true }), a = await admitted(f);
  const result = await run(service(f, a, { git: { ...f.adapter, push: async () => { throw new Error('no-op cannot push'); } } }), a);
  assert.equal(result.phase, 'waiting-checks'); assert.equal(result.reason, 'no-op-rebase');
  assert.equal(result.candidate, f.oldHead); assert.equal(result.proof.noop, true);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM finalization_queue_operation').get().n, 0);
});

test('live reader wait scales once, clips remaining deadline, has a finite ceiling and no Node overflow', async t => {
  const f = gitFixture(t), a = await admitted(f);
  f.clock(1799);
  const waits = [];
  const result = await run(service(f, a, { load: { enabled: true, loadAvg1m: 1000, cpuCount: 1 }, read: async request => {
    waits.push(request.timeoutMs); return null;
  } }), a);
  assert.equal(result.phase, 'parked-infrastructure'); assert.deepEqual(waits, [1000]);
  const opts = { ceilingMs: 60_000, load: { enabled: true, loadAvg1m: 1000, cpuCount: 1 } };
  assert.equal(queueWaitMs(30_000, opts), 60_000);
  assert.equal(queueWaitMs(2 ** 50, { ceilingMs: 2 ** 50, load: idle }), MAX_TIMER_DELAY_MS);
  assert.throws(() => queueWaitMs(30_000, { ceilingMs: Infinity }), /finite/);
});

test('crash after candidate persistence and before intent resumes same commit/base', async t => {
  const f = gitFixture(t), a = await admitted(f);
  await assert.rejects(run(service(f, a, { owner: { issue: async () => { throw new Error('before intent'); } } }), a), /before intent/);
  const candidate = f.store.readEntry(a.ack.entryId);
  assert.equal(candidate.phase, 'publishing'); assert.equal(f.store.operations(a.h.lane).length, 0);
  f.reopen(); a.owner = createQueueOwner({ store: f.store, now: f.now });
  const result = await run(service(f, a, { git: { ...f.adapter, prepare: async () => { throw new Error('must not recreate'); } } }), a);
  assert.equal(result.candidate, candidate.candidate); assert.equal(result.exactBase, candidate.exactBase);
  assert.equal(result.phase, 'waiting-checks');
});

test('successful push followed by old-head observation never republishes', async t => {
  const f = gitFixture(t), a = await admitted(f);
  const first = await run(service(f, a), a);
  a.live.subject.head = f.oldHead;
  a.live.eligibility.primaryChange.headSha = f.oldHead;
  const result = await run(service(f, a, { read: async () => structuredClone(a.live),
    git: { ...f.adapter, push: async () => { throw new Error('must not repush'); } } }), a);
  assert.equal(result.phase, 'parked-infrastructure'); assert.equal(result.reason, 'publication-success-not-visible');
  assert.equal(result.candidate, first.candidate);
});

test('outside base advance replays from proven candidate, keeps chain and original deadline', async t => {
  const f = gitFixture(t), a = await admitted(f);
  const first = await run(service(f, a), a);
  f.g(['checkout', 'main']); f.file('upstream', 'second base\n'); f.base = f.commit('next base');
  f.g(['push', f.remote, 'main']); a.live.subject.baseSha = f.base;
  const second = await run(service(f, a), a);
  assert.equal(second.phase, 'waiting-checks', second.reason); assert.notEqual(second.candidate, first.candidate);
  assert.equal(second.expectedOldHead, first.candidate); assert.equal(second.exactBase, f.base);
  assert.equal(second.rebase.priorDerivations.length, 1); assert.deepEqual(second.patience, first.patience);
});

test('last live read inside issuance lock can still park a newly denied force-push', async t => {
  const f = gitFixture(t), a = await admitted(f);
  let reads = 0, pushes = 0;
  const result = await run(service(f, a, { read: async () => {
    if (++reads === 3) a.live.permission.canForcePush = false;
    return structuredClone(a.live);
  }, git: { ...f.adapter, push: async () => { pushes++; } } }), a);
  assert.equal(result.phase, 'parked-permission'); assert.equal(pushes, 0);
  const operation = f.store.db.prepare('SELECT result_json FROM finalization_queue_operation').get();
  assert.equal(JSON.parse(operation.result_json).outcome, 'not-applied');
});

test('missing deployed store reports capability unavailable without creating schema', t => {
  const f = gitFixture(t);
  f.store.db.exec('DROP TABLE finalization_queue_clean_review');
  const result = probeQueueOwner({ rootDir: f.root, now: f.now(), load: idle });
  assert.equal(result.capabilities.rebase.available, false);
  assert.equal(f.store.db.prepare("SELECT name FROM sqlite_master WHERE name='finalization_queue_clean_review'").get(), undefined);
});

test('overlapping rebase wakes publish once in 5 consecutive trials', async t => {
  for (let n = 0; n < 5; n++) {
    const f = gitFixture(t), a = await admitted(f);
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    let reads = 0, pushes = 0;
    const s = service(f, a, { read: async () => {
      if (++reads <= 2) { if (reads === 2) release(); await barrier; }
      a.live.subject.head = f.g(['--git-dir', f.remote, 'rev-parse', 'topic']);
      return structuredClone(a.live);
    }, git: { ...f.adapter, push: async request => { pushes++; return f.adapter.push(request); } } });
    const results = await Promise.allSettled([run(s, a), run(s, a)]);
    assert.equal(results.filter(r => r.status === 'fulfilled' && r.value.phase === 'waiting-checks').length, 1);
    assert.equal(results.filter(r => r.status === 'rejected' && /superseded/.test(r.reason.message)).length, 1);
    assert.equal(pushes, 1);
  }
  t.diagnostic('5/5 consecutive overlapping wake trials: one publication, one superseded snapshot, no duplicate push');
});

for (const conflict of [false, true]) test(`${conflict ? 'conflict' : 'proof rejection'} returns to closer without publication`, async t => {
  const f = gitFixture(t, { conflict }), a = await admitted(f);
  let pushes = 0;
  const git = { ...f.adapter, push: async () => { pushes++; },
    ...(conflict ? {} : { verify: async () => null }) };
  const result = await run(service(f, a, { git }), a);
  assert.equal(result.phase, 'returned-to-closer'); assert.equal(pushes, 0);
  assert.equal(f.g(['--git-dir', f.remote, 'rev-parse', 'topic']), f.oldHead);
});

test('owner expiry during the last live read refuses mutation and retains unresolved intent', async t => {
  const f = gitFixture(t), a = await admitted(f);
  await a.owner.renew({ fence: a.fence, expiresAt: handoffTime(50) });
  let reads = 0, pushes = 0;
  await assert.rejects(run(service(f, a, { read: async () => {
    if (++reads === 3) f.clock(51);
    return structuredClone(a.live);
  }, git: { ...f.adapter, push: async () => { pushes++; } } }), a), /stale queue owner fence/);
  assert.equal(pushes, 0); assert.equal(f.store.operations(a.h.lane).length, 1);
});

for (const late of [false, true]) test(`existing execution brake prevents ${late ? 'last-moment publication' : 'local preparation'}`, async t => {
  const f = gitFixture(t), a = await admitted(f), policy = { autonomousExecutionDisabled: !late };
  let reads = 0, prepares = 0, pushes = 0;
  const result = await run(service(f, a, { policy, read: async () => {
    if (++reads === 3) policy.autonomousExecutionDisabled = true;
    return structuredClone(a.live);
  }, git: { ...f.adapter, prepare: async request => { prepares++; return f.adapter.prepare(request); },
    push: async () => { pushes++; } } }), a);
  assert.equal(result.phase, 'parked-hold'); assert.equal(result.reason, 'autonomous-execution-disabled');
  assert.equal(prepares, late ? 1 : 0); assert.equal(pushes, 0);
});

for (const state of ['closed', 'merged']) test(`authoritative ${state} cannot return to closer despite unreadable receipt/workspace`, async t => {
  const f = gitFixture(t), a = await admitted(f);
  await run(service(f, a), a);
  a.live.subject.state = state;
  f.store.db.prepare("UPDATE finalization_queue_clean_review SET evidence_json='unreadable'").run();
  const result = await run(service(f, a, { git: { ...f.adapter,
    verify: async () => { throw new Error('workspace unavailable'); }, push: async () => { throw new Error('terminal must not push'); } } }), a);
  assert.equal(result.phase, 'closed-observed'); assert.equal(result.reason, `live-${state}`);
});

for (const failure of ['hold', 'permission-in-lock', 'unavailable', 'remote-refusal']) {
  test(`parked persisted candidate readmits and publishes once: ${failure}`, async t => {
    const f = gitFixture(t), a = await admitted(f);
    let reads = 0, pushes = 0, preparations = 0;
    const git = { ...f.adapter,
      prepare: async request => { preparations++; return f.adapter.prepare(request); },
      push: async request => {
        if (failure === 'remote-refusal' && reads === 3) return { outcome: 'not-applied', sourceRef: 'fixture:refused' };
        pushes++; return f.adapter.push(request);
      } };
    const parked = await run(service(f, a, { git, read: async () => {
      reads++;
      if (failure === 'hold' && reads === 2) a.live.subject.labels = ['no-merge-hold'];
      if (failure === 'permission-in-lock' && reads === 3) a.live.permission.canForcePush = false;
      if (failure === 'unavailable' && reads === 2) return null;
      return structuredClone(a.live);
    } }), a);
    assert.match(parked.phase, /^parked-/); assert.ok(parked.candidate);
    assert.equal(pushes, 0); assert.equal(f.store.operations(a.h.lane).length, 0);
    a.live.subject.labels = []; a.live.permission.canForcePush = true;
    const ready = await createQueueAdmissionService({ store: f.store, now: f.now, load: idle,
      liveAdapter: { read: async () => structuredClone(a.live) } }).reconcile({ fence: a.fence, entryId: a.ack.entryId });
    assert.equal(ready.phase, 'ready'); assert.ok(ready.readinessSeq > parked.readinessSeq);
    const result = await run(service(f, a, { git }), a);
    assert.equal(result.phase, 'waiting-checks'); assert.equal(pushes, 1); assert.equal(preparations, 1);
    assert.equal(result.candidate, parked.candidate); assert.deepEqual(result.patience, parked.patience);
    assert.deepEqual(foldQueue(f.store.readEvents(a.h.lane)).entries[result.entryId], result);
  });
}

for (const corrupt of [false, true]) test(`admission re-proves queue-published head after hold: corrupt=${corrupt}`, async t => {
  const f = gitFixture(t), a = await admitted(f);
  const first = await run(service(f, a), a);
  f.g(['checkout', 'main']); f.file('upstream', 'next base\n'); f.base = f.commit('next base');
  f.g(['push', f.remote, 'main']); a.live.subject.baseSha = f.base;
  a.live.subject.labels = ['no-merge-hold'];
  const parked = await run(service(f, a), a);
  assert.equal(parked.phase, 'parked-hold'); assert.equal(parked.candidate, first.candidate);
  a.live.subject.labels = [];
  let verifications = 0;
  const ready = await createQueueAdmissionService({ store: f.store, now: f.now, load: idle,
    gitAdapter: { ...f.adapter, verify: async request => { verifications++; return corrupt ? null : f.adapter.verify(request); } },
    liveAdapter: { read: async () => structuredClone(a.live) } }).reconcile({ fence: a.fence, entryId: a.ack.entryId });
  assert.equal(verifications, 1);
  assert.equal(ready.phase, corrupt ? 'returned-to-closer' : 'ready');
  if (!corrupt) {
    assert.ok(ready.readinessSeq > parked.readinessSeq);
    const result = await run(service(f, a), a);
    assert.equal(result.phase, 'waiting-checks'); assert.notEqual(result.candidate, first.candidate);
    assert.deepEqual(result.patience, first.patience);
  }
});

for (const unavailable of [false, true]) test(`successful Git push settles despite lagging/unavailable API: unavailable=${unavailable}`, async t => {
  const f = gitFixture(t), a = await admitted(f);
  let reads = 0, pushes = 0;
  const git = { ...f.adapter, push: async request => { pushes++; return f.adapter.push(request); } };
  const result = await run(service(f, a, { git, read: async () => {
    reads++;
    return unavailable && reads === 4 ? null : structuredClone(a.live);
  } }), a);
  assert.equal(result.phase, unavailable ? 'parked-infrastructure' : 'waiting-checks');
  assert.equal(f.store.operations(a.h.lane).length, 0);
  const operation = f.store.db.prepare('SELECT result_json FROM finalization_queue_operation').get();
  assert.equal(JSON.parse(operation.result_json).outcome, 'succeeded');
  assert.match(JSON.parse(operation.result_json).sourceRef, /^git:push:/);
  if (!unavailable) assert.equal(result.rebase.publication.head, result.candidate);
  else {
    a.live.subject.head = result.candidate; a.live.eligibility.primaryChange.headSha = result.candidate;
    const ready = await createQueueAdmissionService({ store: f.store, now: f.now, load: idle,
      liveAdapter: { read: async () => structuredClone(a.live) } }).reconcile({ fence: a.fence, entryId: a.ack.entryId });
    assert.equal(ready.phase, 'ready');
  }
  const resumed = await run(service(f, a, { git }), a);
  assert.equal(resumed.phase, 'waiting-checks'); assert.equal(pushes, 1);
});

for (const applied of [false, true]) test(`unknown push response requires candidate observation or drain: applied=${applied}`, async t => {
  const f = gitFixture(t), a = await admitted(f);
  const operation = run(service(f, a, { git: { ...f.adapter, push: async request => {
    if (applied) await f.adapter.push(request);
    throw new Error('lost response');
  } } }), a);
  if (applied) {
    assert.equal((await operation).phase, 'waiting-checks');
    assert.equal(f.store.operations(a.h.lane).length, 0);
  } else {
    await assert.rejects(operation, /publication-requires-drain-reconciliation/);
    assert.equal(f.store.operations(a.h.lane).length, 1);
  }
});

for (const failure of ['hold', 'permission-in-lock', 'unavailable']) test(`second derivation readmits retained candidate: ${failure}`, async t => {
  const f = gitFixture(t), a = await admitted(f);
  const first = await run(service(f, a), a);
  f.g(['checkout', 'main']); f.file('upstream', 'second base\n'); f.base = f.commit('next base');
  f.g(['push', f.remote, 'main']); a.live.subject.baseSha = f.base;
  a.live.subject.head = first.candidate; a.live.eligibility.primaryChange.headSha = first.candidate;
  let reads = 0, pushes = 0;
  const parked = await run(service(f, a, { read: async () => {
    reads++;
    if (failure === 'hold' && reads === 2) a.live.subject.labels = ['no-merge-hold'];
    if (failure === 'permission-in-lock' && reads === 3) a.live.permission.canForcePush = false;
    if (failure === 'unavailable' && reads === 2) return null;
    return structuredClone(a.live);
  } }), a);
  assert.match(parked.phase, /^parked-/); assert.notEqual(parked.candidate, first.candidate);
  assert.equal(parked.expectedOldHead, first.candidate);
  a.live.subject.labels = []; a.live.permission.canForcePush = true;
  const ready = await createQueueAdmissionService({ store: f.store, now: f.now, load: idle, gitAdapter: f.adapter,
    liveAdapter: { read: async () => structuredClone(a.live) } }).reconcile({ fence: a.fence, entryId: a.ack.entryId });
  assert.equal(ready.phase, 'ready', ready.reason); assert.ok(ready.readinessSeq > parked.readinessSeq);
  const result = await run(service(f, a, { git: { ...f.adapter,
    prepare: async () => { throw new Error('must retain C2'); },
    push: async request => { pushes++; return f.adapter.push(request); } } }), a);
  assert.equal(result.phase, 'waiting-checks'); assert.equal(result.candidate, parked.candidate);
  assert.equal(pushes, 1); assert.deepEqual(result.patience, first.patience);
});

for (const failure of ['hold', 'permission']) for (const late of [false, true]) test(`published candidate checks fresh ${failure}: late=${late}`, async t => {
  const f = gitFixture(t), a = await admitted(f);
  const first = late ? null : await run(service(f, a), a);
  let reads = 0;
  const result = await run(service(f, a, { read: async () => {
    reads++;
    if (late && reads === 2) {
      const entry = f.store.readEntry(a.ack.entryId);
      a.live.subject.head = entry.candidate; a.live.eligibility.primaryChange.headSha = entry.candidate;
    }
    if (!late || reads === 2) {
      if (failure === 'hold') a.live.subject.labels = ['no-merge-hold'];
      else a.live.permission.canForcePush = false;
    }
    return structuredClone(a.live);
  }, git: { ...f.adapter, push: async () => { throw new Error('must not push'); } } }), a);
  assert.equal(result.phase, failure === 'hold' ? 'parked-hold' : 'parked-permission');
  if (first) assert.equal(result.candidate, first.candidate);
});

for (const corrupt of ['proof', 'chain']) test(`admission refuses corrupted earlier derivation: ${corrupt}`, async t => {
  const f = gitFixture(t), a = await admitted(f);
  await run(service(f, a), a);
  f.g(['checkout', 'main']); f.file('upstream', 'next base\n'); f.base = f.commit('next base');
  f.g(['push', f.remote, 'main']); a.live.subject.baseSha = f.base;
  const second = await run(service(f, a), a);
  a.live.subject.labels = ['no-merge-hold']; await run(service(f, a), a); a.live.subject.labels = [];
  if (corrupt === 'chain') {
    const entry = f.store.readEntry(a.ack.entryId);
    entry.rebase.priorDerivations[0].expectedOldHead = 'f'.repeat(40);
    f.store.db.prepare('UPDATE finalization_queue_entry SET payload_json=? WHERE entry_id=?').run(JSON.stringify(entry), entry.entryId);
  }
  let earlier = 0;
  const ready = await createQueueAdmissionService({ store: f.store, now: f.now, load: idle,
    gitAdapter: { ...f.adapter, verify: request => {
      if (request.entry.candidate !== second.candidate) { earlier++; if (corrupt === 'proof') return null; }
      return f.adapter.verify(request);
    } }, liveAdapter: { read: async () => structuredClone(a.live) } }).reconcile({ fence: a.fence, entryId: a.ack.entryId });
  assert.equal(ready.phase, 'returned-to-closer');
  if (corrupt === 'proof') assert.equal(earlier, 1);
});

for (const stage of ['prepare', 'verify', 'publication-verify', 'admission', 'deadline']) test(`transient proof failure parks: ${stage}`, async t => {
  const f = gitFixture(t), a = await admitted(f);
  const fail = () => { throw Object.assign(new Error('transient'), { reason: 'git-deadline-or-output-limit' }); };
  let result;
  if (['verify', 'admission', 'deadline'].includes(stage)) await run(service(f, a), a);
  if (stage === 'admission') {
    a.live.subject.labels = ['no-merge-hold']; await run(service(f, a), a); a.live.subject.labels = [];
    result = await createQueueAdmissionService({ store: f.store, now: f.now, load: idle,
      gitAdapter: { ...f.adapter, verify: fail }, liveAdapter: { read: async () => structuredClone(a.live) } })
      .reconcile({ fence: a.fence, entryId: a.ack.entryId });
  } else {
    if (stage === 'deadline') f.clock(1800);
    result = await run(service(f, a, { git: { ...f.adapter,
      ...(stage === 'prepare' ? { prepare: fail } : { verify: fail }) } }), a);
  }
  assert.equal(result.phase, 'parked-infrastructure');
  assert.equal(result.reason, stage === 'deadline' ? 'rebase-deadline-expired' : 'rebase-git-unavailable');
  assert.equal(f.store.operations(a.h.lane).length, 0);
});

test('unpublished first candidate does not waive the original head current-review check', async t => {
  const f = gitFixture(t), a = await admitted(f);
  let reads = 0;
  const parked = await run(service(f, a, { read: async () => {
    if (++reads === 2) a.live.subject.labels = ['no-merge-hold'];
    return structuredClone(a.live);
  } }), a);
  assert.equal(parked.phase, 'parked-hold');
  a.live.subject.labels = []; a.live.currentReview.verdict = 'changes-requested';
  const result = await createQueueAdmissionService({ store: f.store, now: f.now, load: idle,
    liveAdapter: { read: async () => structuredClone(a.live) } }).reconcile({ fence: a.fence, entryId: a.ack.entryId });
  assert.equal(result.phase, 'returned-to-closer');
  assert.equal(result.reason, 'current-head-review-not-clean');
});

test('rebase probe orders old entries by recent publication, before limiting sample', async t => {
  const f = gitFixture(t), a = await admitted(f);
  const first = await run(service(f, a), a);
  const insert = f.store.db.prepare('INSERT INTO finalization_queue_entry SELECT ?,repository,base,?,admission_head,admission_generation,?,?,?,phase,? FROM finalization_queue_entry WHERE entry_id=?');
  for (let i = 0; i < 101; i++) {
    const copy = { ...first, entryId: `later-${i}`, rebase: { ...first.rebase,
      publication: { ...first.rebase.publication, observedAt: handoffTime(0) } } };
    insert.run(copy.entryId, 1000 + i, `handoff-${i}`, `ack-${i}`, 1000 + i, JSON.stringify(copy), first.entryId);
  }
  const latest = { ...first, rebase: { ...first.rebase, publication: { ...first.rebase.publication, observedAt: handoffTime(10) } } };
  f.store.db.prepare('UPDATE finalization_queue_entry SET payload_json=? WHERE entry_id=?').run(JSON.stringify(latest), first.entryId);
  const result = probeQueueOwner({ rootDir: f.root, now: f.now(), load: idle });
  assert.equal(result.observations.rebase.observations.length, 100);
  assert.equal(result.observations.rebase.observations[0].entry_id, first.entryId);
});

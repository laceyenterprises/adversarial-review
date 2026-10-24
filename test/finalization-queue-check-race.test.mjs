import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueueChecksService } from '../src/finalization/queue-checks.mjs';
import { createQueueRebaseService } from '../src/finalization/queue-rebase.mjs';
import { gitFixture, admitted, idle } from './helpers/queue-rebase-fixture.mjs';

test('ten successive overlapping polls preserve the newer inconclusive observation', async t => {
  const f = gitFixture(t), a = await admitted(f);
  const liveAdapter = { read: async () => {
    a.live.subject.head = f.g(['--git-dir', f.remote, 'rev-parse', 'topic']);
    a.live.eligibility.primaryChange.headSha = a.live.subject.head;
    return structuredClone(a.live);
  } };
  await createQueueRebaseService({ store: f.store, owner: a.owner, liveAdapter, gitAdapter: f.adapter, now: f.now, load: idle })
    .run({ fence: a.fence, entryId: a.ack.entryId });
  let rejected = 0, overwritten = 0;
  for (let n = 0; n < 10; n++) {
    let started, finish;
    const entered = new Promise(resolve => { started = resolve; });
    const blocked = new Promise(resolve => { finish = resolve; });
    const service = createQueueChecksService({ store: f.store, owner: a.owner, liveAdapter, now: f.now, load: idle,
      checkReader: { read: async ({ entry }) => {
        started(); await blocked;
        return { complete: true, head: entry.candidate, base: entry.exactBase, requiredSet: { contexts: ['unit'], version: 'fixture:1' },
          results: [{ name: 'unit', head: entry.candidate, conclusion: 'SUCCESS' }] };
      } } });
    const polling = service.poll({ fence: a.fence, entryId: a.ack.entryId });
    await entered;
    const entry = f.store.readEntry(a.ack.entryId);
    const newer = f.store.progress({ fence: a.fence, entryId: entry.entryId, at: f.now(), phase: 'waiting-checks',
      patch: { reason: 'newer-inconclusive-observation', checks: { complete: false, sequence: n } } });
    finish();
    try { await polling; overwritten++; }
    catch (error) { assert.match(error.message, /superseded/); rejected++; assert.deepEqual(f.store.readEntry(entry.entryId), newer); }
    if (f.store.readEntry(entry.entryId).phase === 'finalizing') {
      for (const phase of ['rebasing', 'publishing', 'waiting-checks']) f.store.progress({ fence: a.fence, entryId: entry.entryId, at: f.now(), phase });
    }
  }
  t.diagnostic(`${rejected}/10 late snapshots rejected; ${overwritten}/10 newer observations overwritten`);
  assert.equal(rejected, 10); assert.equal(overwritten, 0);
});

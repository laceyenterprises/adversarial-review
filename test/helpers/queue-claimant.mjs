import os from 'node:os';
import assert from 'node:assert/strict';
import { openFinalizationQueueStore } from './queue-fixture-store.mjs';
import { createQueueOwner } from '../../src/finalization/executor-lease-store.mjs';
import { resolveQueueOwnerAdapter } from '../../src/finalization/queue-owner.mjs';
// Independent processes exercise native SQLite/flock contention; fs-ext is not
// context-aware and cannot safely be loaded concurrently in Worker threads.
os.loadavg = () => [0, 0, 0];
const data = JSON.parse(process.argv[2]);
if (data.repeated) {
  let store;
  let inFlight = false;
  process.once('disconnect', () => {
    if (!inFlight) { store?.close(); store = undefined; }
  });
  process.on('message', async lane => {
    if (lane === 'prepare') {
      assert.equal(store, undefined);
      store = openFinalizationQueueStore({ rootDir: data.root });
      process.send('prepared');
      return;
    }
    assert.ok(store);
    let result;
    inFlight = true;
    try {
      const owner = createQueueOwner({ store, now: () => data.now });
      result = await owner.claim({ lane, ownerId: data.id, expiresAt: data.expiry });
    } finally {
      store.close();
      store = undefined;
      inFlight = false;
    }
    if (process.connected) process.send(result);
  });
} else {
  const store = openFinalizationQueueStore({ rootDir: data.root });
  const release = data.lockOnly ? resolveQueueOwnerAdapter(store).tryLock(data.lane) : null;
  process.once('message', () => {
    try {
      if (data.lockOnly) { release(); process.send('released'); return; }
      process.send(store.acknowledge(data.admission));
    } catch (error) { process.send({ error: error.message }); }
    finally { store.close(); process.disconnect(); }
  });
}
process.send('ready');

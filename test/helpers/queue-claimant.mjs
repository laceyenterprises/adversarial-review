import os from 'node:os';
import { openFinalizationQueueStore } from '../../src/finalization/ledger-store.mjs';
import { createQueueOwner } from '../../src/finalization/executor-lease-store.mjs';
// Independent processes exercise native SQLite/flock contention; fs-ext is not
// context-aware and cannot safely be loaded concurrently in Worker threads.
os.loadavg = () => [0, 0, 0];
const data = JSON.parse(process.argv[2]);
const store = openFinalizationQueueStore({ rootDir: data.root });
const owner = createQueueOwner({ store, now: () => data.now });
process.send('ready');
process.once('message', async () => {
  try {
    const result = data.admission
      ? store.acknowledge(data.admission)
      : await owner.claim({ lane: data.lane, ownerId: data.id, expiresAt: data.expiry });
    process.send(result);
  } catch (error) { process.send({ error: error.message }); }
  finally { store.close(); process.disconnect(); }
});

import os from 'node:os';
import { openFinalizationQueueStore } from '../../src/finalization/ledger-store.mjs';
import { createQueueOwner } from '../../src/finalization/executor-lease-store.mjs';
os.loadavg = () => [0, 0, 0];
const data = JSON.parse(process.argv[2]);
const store = openFinalizationQueueStore({ rootDir: data.root });
const owner = createQueueOwner({ store, now: () => data.now });
process.once('message', () => process.exit(0));
await owner.issue({ fence: data.fence, entryId: 'q-101', operationId: 'crash-push', kind: 'push', invoke: async () => {
  process.send('intent-durable');
  await new Promise(() => {});
} });

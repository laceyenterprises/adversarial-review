import { openFinalizationQueueStore } from '../../src/finalization/queue-store.mjs';
import { createQueueHandoffService } from '../../src/finalization/queue-handoff-store.mjs';
import { handoffTime } from './queue-handoff-fixture.mjs';

const { root, h, e, crash } = JSON.parse(process.argv[2]);
const store = openFinalizationQueueStore({ rootDir: root });
let unblock;
const service = createQueueHandoffService({ store, now: () => handoffTime(0), load: { enabled: false },
  evidenceAdapter: { read: async () => {
    process.send('reading');
    await new Promise(resolve => { unblock = resolve; });
    return e;
  } } });
process.on('message', async message => {
  if (message === 'commit') { unblock(); return; }
  if (message !== 'submit') return;
  try {
    const ack = await service.submit(h);
    if (crash) process.exit(23); // Commit succeeded; no acknowledgement delivered.
    process.send(ack);
    store.close(); process.disconnect();
  } catch (error) { process.send({ error: error.message }); store.close(); process.disconnect(); }
});
process.send('ready');

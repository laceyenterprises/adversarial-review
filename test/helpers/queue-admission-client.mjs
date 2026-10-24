import { openFinalizationQueueStore } from '../../src/finalization/queue-store.mjs';
import { createCleanReviewService } from '../../src/finalization/queue-clean-review.mjs';
import { createQueueHandoffService } from '../../src/finalization/queue-handoff-store.mjs';
import { handoffTime } from './queue-handoff-fixture.mjs';
const { root, h, e, kind } = JSON.parse(process.argv[2]);
const store = openFinalizationQueueStore({ rootDir: root });
let unblock;
const service = (kind === 'clean' ? createCleanReviewService : createQueueHandoffService)({ store,
  now: () => handoffTime(0), load: { enabled: false }, evidenceAdapter: { read: async () => {
    process.send('reading'); await new Promise(resolve => { unblock = resolve; }); return e;
  } } });
process.on('message', async message => {
  if (message === 'commit') { unblock(); return; }
  if (message !== 'submit') return;
  try { process.send(await service.submit(h)); }
  catch (error) { process.send({ error: error.message }); }
  store.close(); process.disconnect();
});
process.send('ready');

import assert from 'node:assert/strict';
import { openFinalizationQueueStore } from '../../src/finalization/queue-store.mjs';
import { createQueueHandoffService } from '../../src/finalization/queue-handoff-store.mjs';
import { handoffTime } from './queue-handoff-fixture.mjs';

const input = JSON.parse(process.argv[2]);
const { root, repeated, crash } = input;
let active;
function prepare({ h, e }) {
  assert.equal(active, undefined);
  const store = openFinalizationQueueStore({ rootDir: root });
  const service = createQueueHandoffService({ store, now: () => handoffTime(0), load: { enabled: false },
    evidenceAdapter: { read: async () => {
      await new Promise(resolve => { active.unblock = resolve; process.send('reading'); });
      return e;
    } } });
  active = { store, service, h };
}
if (!repeated) prepare(input);
process.on('message', async message => {
  if (message?.prepare) { prepare(message.prepare); process.send('prepared'); return; }
  if (message === 'commit') { active.unblock(); return; }
  assert.equal(message, 'submit');
  const { store, service, h } = active;
  let response;
  try {
    response = await service.submit(h);
    if (crash) process.exit(23); // Commit succeeded; no acknowledgement delivered.
  } catch (error) { response = { error: error.message }; }
  finally { store.close(); active = undefined; }
  process.send(response);
  if (!repeated) process.disconnect();
});
process.send('ready');

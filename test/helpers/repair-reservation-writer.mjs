import { setTimeout } from 'node:timers/promises';
import { reserveRepairEpoch } from '../../src/repair-epochs.mjs';

const { ownerKey } = JSON.parse(process.argv[2]);
process.on('message', async identity => {
  // Bound by wall time, not attempts: a loaded host can hold the flock
  // past a fixed count of short retries.
  for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
    try {
      process.send({ result: reserveRepairEpoch({ ...identity, ownerKey }) });
      return;
    } catch (error) {
      if (error.code !== 'EBUSY') {
        process.send({ error: error.message });
        return;
      }
      await setTimeout(5);
    }
  }
  process.send({ error: 'reservation never completed' });
});
process.send('ready');

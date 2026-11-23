// MRQ-21: dispatch-time inputs for a queue-v2 hammer. Kept free of store and
// closer imports so the closer route preflight can use it without a cycle.
import { isAbsolute } from 'node:path';

const text = value => typeof value === 'string' && value.trim().length > 0;
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

/** The installed handoff command's argv, from the queue composition. Never a
 * PATH lookup and never a shell string. */
export function parseHammerQueueHandoffCommand(value) {
  let argv = value;
  if (typeof value === 'string') {
    try { argv = JSON.parse(value); } catch { argv = null; }
  }
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every(text) || !isAbsolute(argv[0])) return null;
  return argv;
}

/** One inputs.sh line naming the queue route this launch was dispatched under.
 * Legacy lanes render the empty string, so their bootstrap is unchanged. */
export function hammerQueueInputs({ routeGeneration, handoffCommand, workerId, workerClass }) {
  const command = parseHammerQueueHandoffCommand(handoffCommand);
  if (!Number.isSafeInteger(routeGeneration) || routeGeneration < 0 || !command) {
    throw new Error('queue hammer inputs require a route generation and an installed handoff command');
  }
  return `export HAM_FINALIZATION_EXECUTOR='queue-v2' HAM_QUEUE_ROUTE_GENERATION=${shellQuote(routeGeneration)}`
    + ` HAM_QUEUE_HANDOFF_COMMAND=${shellQuote(JSON.stringify(command))}`
    + ` HAM_QUEUE_CLOSER_WORKER_ID=${shellQuote(workerId ?? '')} HAM_QUEUE_CLOSER_WORKER_CLASS=${shellQuote(workerClass ?? '')}\n`;
}

import { fileURLToPath } from 'node:url';
import { hammerTokenSession } from './hammer-token.mjs';
import { daemonMergeReservationSeconds } from './ama/merge-lease.mjs';
import { WATCHER_POLL_INTERVAL_MS } from './watcher-poll-interval.mjs';

export function reservationEvidence({
  pollIntervalMs = WATCHER_POLL_INTERVAL_MS,
  reservation = daemonMergeReservationSeconds,
} = {}) {
  return { reservationSeconds: reservation(pollIntervalMs), pollSeconds: pollIntervalMs / 1000 };
}

export function main({ argv = process.argv.slice(2), env = process.env,
  write = value => process.stdout.write(value), error = value => process.stderr.write(value) } = {}) {
  try {
    let evidence;
    if (argv.length !== 1) throw new Error('usage');
    if (argv[0] === 'hammer-token') {
      evidence = hammerTokenSession({ credentialEnv: env, hammerToken: true }).checkRefresh();
    } else if (argv[0] === 'daemon-reservation') {
      evidence = reservationEvidence();
    } else throw new Error('usage');
    write(JSON.stringify(evidence) + '\n');
    return 0;
  } catch {
    // Never forward command text, child streams, credentials, or exception text.
    error('activation check unavailable\n');
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();

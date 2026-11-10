import { appendFileSync } from 'node:fs';
import { hammerNetworkClock } from '../../src/ama/hammer-api-network.mjs';

// Imported only by disposable CLI subprocesses. Exercise retry policy without
// waiting on transport backoff; native child-process timeout tests stay real.
hammerNetworkClock.sleep = async ms => {
  if (process.env.HAM_TEST_NETWORK_DELAYS) {
    appendFileSync(process.env.HAM_TEST_NETWORK_DELAYS, `${ms}\n`);
  }
};

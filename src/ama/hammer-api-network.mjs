import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';
import { execFileSync } from 'node:child_process';
import { isTransientGhError } from '../gh-cli.mjs';
import { meteredExecFileSync } from '../metered-gh.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// CLI subprocess fixtures can replace sleep before the entrypoint loads.
// Explicit per-call sleep injection continues to take precedence.
// Production code must not assign to this test seam: doing so removes the
// transport backoff for every caller in the process.
export const hammerNetworkClock = { sleep: pause };

// Retry transport failures only, preserving the entitled token and expected-head
// CAS on every mutation attempt. An ambiguous server-side success stays on
// that transport. A refused retry cannot authorize another publisher.
export async function hammerNetworkCall(command, args, input, { execFileImpl = execFileSync, env = process.env, sleep = ms => hammerNetworkClock.sleep(ms) } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return meteredExecFileSync(execFileImpl, command, args, { input, hammerToken: true, timeout: loadAwareTimeoutMs(15000),
        maxBuffer: 64 * 1024 * 1024, env });
    } catch (error) {
      const transient = isTransientGhError(error) || (command === 'git'
        && /timed out|TLS|SSL|early EOF|RPC failed|remote end hung up unexpectedly|HTTP.*5\d\d/i.test(String(error.stderr || error.message)));
      if (!transient || attempt === 2) throw error;
      await sleep(500 * (2 ** attempt));
    }
  }
}

// Fixed-command view of the entitled, metered transport. GitHub callers cannot
// accidentally choose another executable; retry and credential ownership stay
// in the same boundary as Git publication operations.
export const hammerGhCall = hammerNetworkCall.bind(undefined, 'gh');

// Local publication plumbing shares the same unknown-on-error boundary. The
// caller may classify an ancestry result only after a completed Git exit 1.
export function hammerLocalGit(args, { execFileImpl = execFileSync } = {}) {
  return execFileImpl('git', args, { timeout: loadAwareTimeoutMs(30_000),
    maxBuffer: 64 * 1024 * 1024, stdio: 'pipe' });
}

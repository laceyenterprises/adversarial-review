import { execFileSync } from 'node:child_process';
import { isTransientGhError } from '../gh-cli.mjs';
import { meteredExecFileSync } from '../metered-gh.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Retry transport failures only, preserving the entitled token and expected-head
// CAS on every mutation attempt. An ambiguous server-side success still fails
// closed through the lease-protected git fallback if the CAS rejects a retry.
export async function hammerNetworkCall(command, args, input, { execFileImpl = execFileSync, env = process.env, sleep = pause } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return meteredExecFileSync(execFileImpl, command, args, { input, hammerToken: true, timeout: 15000,
        maxBuffer: 64 * 1024 * 1024, env });
    } catch (error) {
      const transient = isTransientGhError(error) || (command === 'git'
        && /timed out|TLS|SSL|early EOF|RPC failed|remote end hung up unexpectedly|HTTP.*5\d\d/i.test(String(error.stderr || error.message)));
      if (!transient || attempt === 2) throw error;
      await sleep(500 * (2 ** attempt));
    }
  }
}

#!/usr/bin/env node
import { reportHammerEarlyFailure } from '../src/ama/hammer-terminal-audit.mjs';
import { execGhWithRetry } from '../src/gh-cli.mjs';

const [prUrl] = process.argv.slice(2);
let ref;
try {
  ref = new URL(prUrl).pathname.match(/^\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)(?:\/|$)/);
} catch { /* Invalid URLs follow the same usage path as invalid PR paths. */ }
if (!ref) {
  process.stderr.write('usage: hammer-base-head PR_URL\n');
  process.exit(64);
}
try {
  const { stdout } = await execGhWithRetry({ hammerToken: true,
    args: ['api', `repos/${ref[1]}/pulls/${ref[2]}`, '--jq', '.head.sha'],
    timeoutMs: 15_000,
  });
  const headSha = stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(headSha)) throw new Error('hammer starting PR head is missing or malformed');
  process.stdout.write(`${headSha}\n`);
} catch {
  reportHammerEarlyFailure('starting-pr-state-unavailable');
  process.stderr.write('HAM starting PR state unavailable\n');
  process.exitCode = 1;
}

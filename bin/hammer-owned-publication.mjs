#!/usr/bin/env node
import { hammerNetworkCall, hammerLocalGit } from '../src/ama/hammer-api-network.mjs';
import { withHammerPublication, settleHammerRebasePublication } from '../src/ama/hammer-publication-ownership.mjs';
const [repo, prNumber, mode, headSha, command, ...args] = process.argv.slice(2);
try {
  let output;
  await withHammerPublication({ repo, prNumber, headSha: mode === 'head' ? headSha : null }, async () => {
    output = await hammerNetworkCall(command, args);
    if (mode === 'rebase') {
      const result = JSON.parse(output.toString());
      const head = await settleHammerRebasePublication({ result, oldHead: headSha, base: process.env.HAM_PUBLICATION_BASE,
        readHead: async () => JSON.parse((await hammerNetworkCall('gh', ['pr', 'view', prNumber, '--repo', repo,
          '--json', 'headRefOid'])).toString()).headRefOid,
        fetchHead: head => hammerNetworkCall('git', ['-c', 'fetch.recurseSubmodules=false', 'fetch', '--no-tags', 'origin', head]),
        git: async args => hammerLocalGit(args).toString() });
      output = Buffer.from(JSON.stringify(result));
      return { head };
    }
    return { head: headSha };
  });
  process.stdout.write(output);
} catch (error) {
  process.stderr.write(`${error?.stderr || error?.message || String(error)}\n`);
  process.exitCode = error?.gitCredentialRefreshFailed ? 76 : 1;
}

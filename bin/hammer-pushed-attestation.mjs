#!/usr/bin/env node
import { execGhWithRetry } from '../src/gh-cli.mjs';
import { publishPushedHammerAttestation } from '../src/ama/hammer-pushed-attestation.mjs';

const [repo, prNumber, baseHead, pushedHead] = process.argv.slice(2);
if (!process.env.HAMMER_LACEY_GH_TOKEN && !process.env.MERGE_AGENT_GH_TOKEN
  && !process.env.HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND && !process.env.MERGE_AGENT_GH_TOKEN_REFRESH_COMMAND
  && !process.env.HQ_ENTITLEMENT_GH_TOKEN_REFRESH_COMMAND) throw new Error('no entitled hammer token for pushed provenance');
const result = await publishPushedHammerAttestation({ repo, prNumber, baseHead, pushedHead,
  api: async (path, input) => JSON.parse((await execGhWithRetry({ hammerToken: true,
    args: ['api', path, ...Object.entries(input || {}).flatMap(([key, value]) => ['-f', `${key}=${value}`])],
    env: process.env, timeoutMs: 15000,
  })).stdout),
});
process.stdout.write(`${JSON.stringify(result)}\n`);

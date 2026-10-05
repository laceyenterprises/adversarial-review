#!/usr/bin/env node
import { fetchCiCost, checkCiCost } from '../src/ama/ci-cost.mjs';
import { execGhWithRetry } from '../src/gh-cli.mjs';
const [repo, prNumber, headSha] = process.argv.slice(2);
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '') || !/^[1-9]\d*$/.test(prNumber || '') || !/^[0-9a-f]{40}$/i.test(headSha || '')) {
  process.stderr.write('usage: ci-cost-check.mjs owner/repo pr head-sha\n');
  process.exit(64);
}
const evidence = await fetchCiCost({ repo, prNumber, headSha, get: async (path) => {
  const { stdout } = await execGhWithRetry({ args: ['api', path], timeoutMs: 15000 });
  return JSON.parse(stdout);
} });
const gate = checkCiCost(evidence, headSha);
process.stdout.write(`${JSON.stringify({ ...gate, evidence })}\n`);
process.exitCode = gate.ok ? 0 : 1;

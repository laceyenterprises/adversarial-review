#!/usr/bin/env node
import { createHistoryReader } from '../src/ama/history-reader.mjs';
import { fetchPrimaryChange } from '../src/ama/primary-change.mjs';
const [repo, prNumber, headSha] = process.argv.slice(2);
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '') || !/^[1-9]\d*$/.test(prNumber || '') || !/^[0-9a-f]{40}$/i.test(headSha || '')) {
  process.stderr.write('usage: primary-change-context.mjs owner/repo pr head-sha\n');
  process.exit(64);
}
const evidence = await fetchPrimaryChange({ repo, prNumber, headSha, get: createHistoryReader() });
process.stdout.write(`${JSON.stringify(evidence)}\n`);
if (evidence.historyReadFailed) process.exitCode = 1;

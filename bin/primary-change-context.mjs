#!/usr/bin/env node
import { createHistoryReader } from '../src/ama/history-reader.mjs';
import { fetchPrimaryChange, fetchPrimaryChangeContext, primaryChangeRoot } from '../src/ama/primary-change.mjs';
import { loadEffectiveMergeAuthorityConfig } from '../src/ama/effective-policy.mjs';
const [repo, prNumber, headSha, diagnostics, ...extra] = process.argv.slice(2);
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '') || !/^[1-9]\d*$/.test(prNumber || '') || !/^[0-9a-f]{40}$/i.test(headSha || '')
  || (diagnostics !== undefined && diagnostics !== '--diagnostics') || extra.length) {
  process.stderr.write('usage: primary-change-context.mjs owner/repo pr head-sha [--diagnostics]\n');
  process.exit(64);
}
const args = { repo, prNumber, headSha, get: createHistoryReader() };
const evidence = diagnostics ? await fetchPrimaryChangeContext(args, {
  strictNonBlockingRemediation: loadEffectiveMergeAuthorityConfig({ rootDir: primaryChangeRoot() })?.strictNonBlockingRemediation !== false,
}) : await fetchPrimaryChange(args);
process.stdout.write(`${JSON.stringify(evidence)}\n`);
if (evidence.historyReadFailed) process.exitCode = 1;

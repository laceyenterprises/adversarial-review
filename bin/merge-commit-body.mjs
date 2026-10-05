#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { buildMergeCommitBody } from '../src/ama/closing-keywords.mjs';
const [repo, selfPrNumber] = process.argv.slice(2);
if (!repo || !/^[1-9][0-9]*$/.test(selfPrNumber || '')) process.exit(64);
const trailers = process.env.HAM_AMA_TRAILERS;
if (!trailers?.trim()) {
  process.stderr.write('merge-commit-body: canonical HAM_AMA_TRAILERS is required\n');
  process.exit(78);
}
process.stdout.write(JSON.stringify(buildMergeCommitBody({
  prTitle: process.env.HAM_PR_TITLE || '', prBody: readFileSync(0, 'utf8'), trailers, repo, selfPrNumber,
})));

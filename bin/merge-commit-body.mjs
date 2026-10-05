#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { buildMergeCommitBody } from '../src/ama/closing-keywords.mjs';
import { composeAmaTrailers } from '../src/ama/audit.mjs';
const [repo, selfPrNumber] = process.argv.slice(2);
if (!repo || !/^[1-9][0-9]*$/.test(selfPrNumber || '')) process.exit(64);
const trailers = process.env.HAM_AMA_TRAILERS || composeAmaTrailers({
  workerClass: 'hammer', reviewerFamily: process.env.HAM_REVIEWER || '',
  riskClass: process.env.HAM_RISK_CLASS || 'unknown', eligibilityReason: 'ham-terminal-remediation',
  auditRef: `ama:${repo}:pr:${selfPrNumber}`,
});
process.stdout.write(JSON.stringify(buildMergeCommitBody({ prBody: readFileSync(0, 'utf8'), trailers, repo, selfPrNumber })));

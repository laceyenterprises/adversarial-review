#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

import { main as pipelineHealthMain } from './review-pipeline-health-cli.mjs';
import { main as resetPrMain } from './reset-pr.mjs';
import { main as tokensMain } from './tokens-cli.mjs';
import { reviewerRoster, formatReviewerRoster } from './adapters/subject/github-pr/routing.mjs';
import { resolveGeminiReviewerMode } from './role-config.mjs';

const USAGE = `\
Usage:
  adversarial-review pipeline-health [--root <dir>] [--json | --prometheus | --sentinel]
  adversarial-review reset-pr <owner/repo> <pr-number> [options]
  adversarial-review tokens [--since 7d] [--by-pr | --by-reviewer] [--json]
  adversarial-review reviewer-roster [--json]
`;

// GMW-02 — reviewer-roster debug surface. Prints which builder tags each
// reviewer model reviews (cross-model only) plus the gemini selection mode,
// matching the SPEC §1 mockup. Resolves the live `reviewer.gemini.mode` from
// the config cascade so the gemini-row note reflects the deployed mode.
function reviewerRosterMain(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const json = argv.includes('--json');
  let mode;
  try {
    mode = resolveGeminiReviewerMode({ env: process.env });
  } catch (err) {
    stderr.write(`error: could not resolve reviewer.gemini.mode: ${err?.message || err}\n`);
    return 1;
  }
  const roster = reviewerRoster({ mode });
  if (json) {
    stdout.write(`${JSON.stringify({ mode, roster }, null, 2)}\n`);
  } else {
    stdout.write(`reviewer roster (reviewer.gemini.mode=${mode}):\n`);
    stdout.write(`${formatReviewerRoster(roster)}\n`);
  }
  return 0;
}

function main(argv, io = {}) {
  const [command, ...rest] = argv;
  if (command === 'reset-pr') {
    return resetPrMain(rest, io);
  }
  if (command === 'pipeline-health') {
    return pipelineHealthMain(rest, io);
  }
  if (command === 'tokens') {
    return tokensMain(rest, io);
  }
  if (command === 'reviewer-roster') {
    return reviewerRosterMain(rest, io);
  }

  const stderr = io.stderr || process.stderr;
  stderr.write(`error: unknown command ${command || '<none>'}\n\n${USAGE}`);
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

export { main, reviewerRosterMain };

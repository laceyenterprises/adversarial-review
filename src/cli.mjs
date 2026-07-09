#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

import { main as pipelineHealthMain } from './review-pipeline-health-cli.mjs';
import { main as resetPrMain } from './reset-pr.mjs';
import { main as tokensMain } from './tokens-cli.mjs';
import { reviewerRoster, formatReviewerRoster } from './adapters/subject/github-pr/routing.mjs';
import { resolveGeminiReviewerMode } from './role-config.mjs';
import { loadConfigCached } from './config-loader.mjs';
import {
  collectHandoffStatus,
  collectHandoffTrace,
  renderHandoffStatus,
  renderHandoffTrace,
} from './handoff-telemetry.mjs';

const USAGE = `\
Usage:
  adversarial-review pipeline-health [--root <dir>] [--json | --prometheus | --sentinel]
  adversarial-review reset-pr <owner/repo> <pr-number> [options]
  adversarial-review tokens [--since 7d] [--by-pr | --by-reviewer] [--json]
  adversarial-review reviewer-roster [--json]
  adversarial-review handoff status [--repo <owner/repo>] [--window <24h>] [--root <dir>] [--json]
  adversarial-review handoff trace <owner/repo#pr> [--root <dir>] [--json]
`;

// GMW-02 — reviewer-roster debug surface. Prints the effective default route
// matrix alongside reviewer eligibility plus the gemini selection mode,
// matching the SPEC §1 mockup. Resolves the live `reviewer.gemini.mode` from
// the config cascade so the gemini-row note reflects the deployed mode.
function reviewerRosterMain(argv, io = {}, configOptions = io.config || {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const env = configOptions.env || io.env || process.env;
  const json = argv.includes('--json');
  let mode;
  try {
    mode = resolveGeminiReviewerMode({ ...configOptions, env });
  } catch (err) {
    stderr.write(`error: could not resolve reviewer.gemini.mode: ${err?.message || err}\n`);
    return 1;
  }
  const roster = reviewerRoster({ mode });
  if (json) {
    stdout.write(`${JSON.stringify({ mode, roster }, null, 2)}\n`);
  } else {
    stdout.write(`reviewer route roster (reviewer.gemini.mode=${mode}):\n`);
    stdout.write(`${formatReviewerRoster(roster)}\n`);
  }
  return 0;
}

function parseHandoffArgs(argv) {
  const [subcommand, ...rest] = argv;
  const options = {
    subcommand,
    rootDir: process.cwd(),
    repo: null,
    window: '24h',
    target: null,
    json: false,
    help: false,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--root') {
      if (!rest[i + 1]) throw new Error('--root requires a directory');
      options.rootDir = rest[++i];
    } else if (arg === '--repo') {
      if (!rest[i + 1]) throw new Error('--repo requires a repo');
      options.repo = rest[++i];
    } else if (arg === '--window') {
      if (!rest[i + 1]) throw new Error('--window requires a duration');
      options.window = rest[++i];
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (subcommand === 'trace' && !options.target) {
      options.target = arg;
    } else {
      throw new Error(`Unknown handoff argument: ${arg}`);
    }
  }
  return options;
}

function handoffMain(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  let options;
  try {
    options = parseHandoffArgs(argv);
  } catch (err) {
    stderr.write(`error: ${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (options.subcommand === 'status') {
    try {
      const status = collectHandoffStatus({
        rootDir: options.rootDir,
        repo: options.repo,
        window: options.window,
        loadConfigImpl: loadConfigCached,
      });
      stdout.write(options.json ? `${JSON.stringify(status, null, 2)}\n` : renderHandoffStatus(status));
      return 0;
    } catch (err) {
      stderr.write(`error: ${err.message}\n`);
      return 2;
    }
  }
  if (options.subcommand === 'trace') {
    if (!options.target) {
      stderr.write(`error: handoff trace requires <repo#pr>\n\n${USAGE}`);
      return 2;
    }
    try {
      const trace = collectHandoffTrace({ rootDir: options.rootDir, target: options.target });
      stdout.write(options.json ? `${JSON.stringify(trace, null, 2)}\n` : renderHandoffTrace(trace));
      return 0;
    } catch (err) {
      stderr.write(`error: ${err.message}\n`);
      return 2;
    }
  }
  stderr.write(`error: unknown handoff command ${options.subcommand || '<none>'}\n\n${USAGE}`);
  return 2;
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
  if (command === 'handoff') {
    return handoffMain(rest, io);
  }

  const stderr = io.stderr || process.stderr;
  stderr.write(`error: unknown command ${command || '<none>'}\n\n${USAGE}`);
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

export { handoffMain, main, reviewerRosterMain };

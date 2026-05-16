#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

import { main as resetPrMain } from './reset-pr.mjs';
import { main as tokensMain } from './tokens-cli.mjs';

const USAGE = `\
Usage:
  adversarial-review reset-pr <owner/repo> <pr-number> [options]
  adversarial-review tokens [--since 7d] [--by-pr | --by-reviewer] [--json]
`;

function main(argv, io = {}) {
  const [command, ...rest] = argv;
  if (command === 'reset-pr') {
    return resetPrMain(rest, io);
  }
  if (command === 'tokens') {
    return tokensMain(rest, io);
  }

  const stderr = io.stderr || process.stderr;
  stderr.write(`error: unknown command ${command || '<none>'}\n\n${USAGE}`);
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

export { main };

#!/usr/bin/env node

// Clobber guard CLI — verify that a MOVED head preserved all reviewed content.
//
// Reusable at force-push time: a remediation/closer actor that rebased a branch
// can call this with the reviewed head and the head it is about to trust/push and
// act on the exit code before the content-blind daemon lane ever sees it.
//
//   ama-clobber-guard.mjs assess --repo <owner/name> --reviewed-sha <sha> --live-sha <sha>
//
// Exit codes:
//   0  ok / skipped   reviewed content preserved, head unchanged, or guard disabled
//   3  clobber        reviewed content was dropped on the rebase
//   4  unverifiable   could not prove preservation (treat as fail-closed)

import { evaluateMovedHeadClobberGuard } from '../src/ama/clobber-guard.mjs';
import { execGhWithRetry } from '../src/gh-cli.mjs';

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage:
  ama-clobber-guard.mjs assess --repo <owner/name> --reviewed-sha <sha> --live-sha <sha>

Exit codes: 0 = ok/skipped, 3 = clobber (reviewed content dropped), 4 = unverifiable.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '-h' || command === '--help') usage(command ? 0 : 64);
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith('--')) usage(64);
    const key = arg.slice(2);
    if (index + 1 >= rest.length) usage(64);
    flags[key] = rest[index + 1];
    index += 1;
  }
  return { command, flags };
}

async function commandAssess(flags) {
  const result = await evaluateMovedHeadClobberGuard({
    repo: flags.repo,
    reviewedHead: flags['reviewed-sha'],
    liveHead: flags['live-sha'],
    execGh: ({ args, timeoutMs }) => execGhWithRetry({ args, timeoutMs }),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === 'clobber') process.exit(3);
  if (result.status === 'unverifiable') process.exit(4);
  process.exit(0);
}

const { command, flags } = parseArgs(process.argv.slice(2));
if (command === 'assess') {
  await commandAssess(flags);
} else {
  usage(64);
}

#!/usr/bin/env node
/**
 * AMA-04 audit CLI shim.
 *
 * The closer prompt (AMA-03 template) invokes this to write the §4.4
 * audit JSON without re-implementing the state-machine in bash.
 *
 *   ama-audit init   --hq-root <path> --repo <r> --pr <n> --head <sha> \
 *                    --outcome <enum> [--attempt-json <path>] [--now <iso>]
 *   ama-audit append --hq-root <path> --repo <r> --pr <n> --head <sha> \
 *                    --outcome <enum> [--attempt-json <path>] [--now <iso>]
 *   ama-audit trailers --worker-class <c> --reviewer <r> --risk-class <rc> \
 *                      --reason <text> --audit-path <p>
 *
 * `--attempt-json <path>` is optional context the writer merges into
 * the attempt entry (e.g. `mergeCliExitCode`, `postCliGithubState`,
 * `preMergeReasons`). When absent, only `outcome` (+ caller-provided
 * `--now`) is recorded.
 *
 * Exit codes:
 *   0   write succeeded; absolute file path on stdout
 *   65  data error — refused write (e.g. sticky-succeeded regression)
 *   1   usage error
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import {
  appendAmaAuditAttempt,
  composeAmaTrailers,
  writeAmaAuditEntry,
} from '../src/ama/audit.mjs';

const USAGE = `\
Usage:
  ama-audit init   --hq-root <path> --repo <owner/name> --pr <n> --head <sha>
                   --outcome <enum> [--attempt-json <path>] [--now <iso>]
  ama-audit append --hq-root <path> --repo <owner/name> --pr <n> --head <sha>
                   --outcome <enum> [--attempt-json <path>] [--now <iso>]
  ama-audit trailers --worker-class <c> --reviewer <r> --risk-class <rc>
                     --reason <text> --audit-path <p>

Common args:
  --hq-root      \$HQ_ROOT (audit file is written under
                  <hq-root>/dispatch/audit/adversarial-merge-authority/)
  --repo         <owner>/<name>
  --pr           PR number
  --head         authorized head SHA
  --outcome      in_progress|deferred|superseded|succeeded|failed-without-merge
  --attempt-json optional JSON file merged into the attempt entry
  --now          ISO 8601 UTC timestamp (caller-provided for
                 deterministic tests)

Trailers args:
  --worker-class    e.g. codex or claude-code
  --reviewer        reviewer bot login (e.g. claude-reviewer-lacey)
  --risk-class      resolved risk class
  --reason          short human summary
  --audit-path      absolute path to the audit JSON (for Eligibility-Trace)
`;

function loadAttemptJson(path) {
  if (!path) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parseWriteArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'hq-root': { type: 'string' },
      repo: { type: 'string' },
      pr: { type: 'string' },
      head: { type: 'string' },
      outcome: { type: 'string' },
      'attempt-json': { type: 'string' },
      now: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  return { values, positionals };
}

function parseTrailersArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'worker-class': { type: 'string' },
      reviewer: { type: 'string' },
      'risk-class': { type: 'string' },
      reason: { type: 'string' },
      'audit-path': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  return { values, positionals };
}

function runInitOrAppend(subcommand, argv) {
  const { values } = parseWriteArgs(argv);
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  for (const required of ['hq-root', 'repo', 'pr', 'head', 'outcome']) {
    if (!values[required]) {
      process.stderr.write(`error: --${required} is required\n${USAGE}`);
      return 1;
    }
  }
  const attemptBase = loadAttemptJson(values['attempt-json']);
  const attempt = { ...attemptBase, outcome: values.outcome };
  const args = {
    hqRoot: values['hq-root'],
    repo: values.repo,
    prNumber: Number(values.pr),
    headSha: values.head,
    attempt,
    now: values.now,
  };
  try {
    const { filePath } =
      subcommand === 'init'
        ? writeAmaAuditEntry(args)
        : appendAmaAuditAttempt(args);
    process.stdout.write(`${filePath}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    return 65;
  }
}

function runTrailers(argv) {
  const { values } = parseTrailersArgs(argv);
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  for (const required of [
    'worker-class',
    'reviewer',
    'risk-class',
    'reason',
    'audit-path',
  ]) {
    if (!values[required]) {
      process.stderr.write(`error: --${required} is required\n${USAGE}`);
      return 1;
    }
  }
  try {
    const block = composeAmaTrailers({
      workerClass: values['worker-class'],
      reviewerFamily: values.reviewer,
      riskClass: values['risk-class'],
      eligibilityReason: values.reason,
      auditPath: values['audit-path'],
    });
    process.stdout.write(`${block}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    return 65;
  }
}

function main(argv = process.argv.slice(2)) {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  switch (sub) {
    case 'init':
    case 'append':
      return runInitOrAppend(sub, argv.slice(1));
    case 'trailers':
      return runTrailers(argv.slice(1));
    default:
      process.stderr.write(`error: unknown subcommand '${sub}'\n${USAGE}`);
      return 1;
  }
}

process.exit(main());

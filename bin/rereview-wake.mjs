#!/usr/bin/env node
/**
 * Operator surface for the RPL-04 durable rereview wake queue.
 *
 *   rereview-wake request --root-dir <path> --repo <owner/name> --pr <n> \
 *                         [--head-sha <sha>] [--reason <reason>]
 *   rereview-wake status  --root-dir <path> [--repo <owner/name>] [--pr <n>] [--json]
 *
 * `request` is the same entry point a hammer, remediator, or CI hook uses: it
 * writes the durable record, coalesces against an existing one for the same
 * (repo, PR, head, reason), and nudges the watcher. It does NOT reset the
 * review row — use `npm run retrigger-review` for that. A wake asks the
 * watcher to look now; it does not decide what the watcher finds.
 */

import { parseArgs } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  KNOWN_REREVIEW_WAKE_REASONS,
  REREVIEW_WAKE_REASONS,
  rereviewWakeBacklog,
  requestRereviewWake,
} from '../src/rereview-wake.mjs';

const TOOL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REASON_LIST = [...KNOWN_REREVIEW_WAKE_REASONS].join(', ');

const USAGE = `\
Usage:
  rereview-wake request [--root-dir <path>] --repo <owner/name> --pr <n>
                        [--head-sha <sha>] [--reason <reason>] [--source <text>]
                        [--requested-at <iso>] [--json]
  rereview-wake status  [--root-dir <path>] [--repo <owner/name>] [--pr <n>] [--json]

Options:
  --root-dir      adversarial-review root directory (defaults to this checkout)
  --repo          repository in owner/name form
  --pr            pull request number (--pr-number is an alias)
  --head-sha      PR head SHA the wake is about (--head is an alias)
  --reason        one of: ${REASON_LIST} (default: ${REREVIEW_WAKE_REASONS.OPERATOR})
  --source        free-text producer label recorded on the request
  --requested-at  deterministic ISO timestamp
  --json          machine-readable output
`;

function usageError(stderr, message) {
  stderr.write(`error: ${message}\n${USAGE}`);
  return 64;
}

function parseCliArgs(argv) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'root-dir': { type: 'string' },
      repo: { type: 'string' },
      pr: { type: 'string' },
      'pr-number': { type: 'string' },
      'head-sha': { type: 'string' },
      head: { type: 'string' },
      reason: { type: 'string' },
      source: { type: 'string' },
      'requested-at': { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
}

function isSafeRepo(value) {
  const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)$/.exec(value);
  if (!match) return false;
  return match.slice(1).every((part) => part !== '.' && part !== '..');
}

function formatAge(ms) {
  if (ms === null || ms === undefined) return '-';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

function renderStatus(backlog) {
  const lines = [
    `rereview wake backlog: ${backlog.pending} pending `
    + `(${backlog.unclaimed ?? 'unknown'} unclaimed, ${backlog.claimed ?? 'unknown'} claimed)`,
    ...(backlog.truncated ? [`sampled ${backlog.sampledEntries} pending records; details below are partial`] : []),
    `oldest: ${backlog.oldest
      ? `${backlog.oldest.repo}#${backlog.oldest.prNumber} ${formatAge(backlog.oldestAgeMs)} `
        + `${backlog.oldest.reason}${backlog.oldest.holdReason ? ` held=${backlog.oldest.holdReason}` : ''}`
      : 'none'}`,
    '',
    'by reason:',
    ...(backlog.byReason.length
      ? backlog.byReason.map((row) => `- ${row.reason}: ${row.count}`)
      : ['- none']),
    '',
    'by hold reason:',
    ...(backlog.byHoldReason.length
      ? backlog.byHoldReason.map((row) => `- ${row.reason}: ${row.count}`)
      : ['- none']),
    '',
    'pending wakes:',
    ...(backlog.entries.length
      ? backlog.entries.slice(0, 20).map((entry) => (
        `- ${entry.repo}#${entry.prNumber} @${(entry.headSha || 'no-head').slice(0, 12)} `
        + `${entry.reason} state=${entry.state} age=${formatAge(entry.ageMs)} `
        + `claims=${entry.claimCount}${entry.holdReason ? ` held=${entry.holdReason}` : ''}`
      ))
      : ['- none']),
  ];
  return `${lines.join('\n')}\n`;
}

function main(argv = process.argv.slice(2), deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const requestRereviewWakeImpl = deps.requestRereviewWakeImpl || requestRereviewWake;
  const rereviewWakeBacklogImpl = deps.rereviewWakeBacklogImpl || rereviewWakeBacklog;

  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    return usageError(stderr, err?.message || 'invalid arguments');
  }

  const { values, positionals } = parsed;
  if (values.help) {
    stdout.write(USAGE);
    return 0;
  }
  const command = positionals[0] || '';
  if (positionals.length > 1) return usageError(stderr, `unexpected argument: ${positionals[1]}`);
  if (command !== 'request' && command !== 'status') {
    return usageError(stderr, `unknown command: ${command || '<none>'}`);
  }

  const rootDir = String(values['root-dir'] || TOOL_ROOT).trim();
  const repo = String(values.repo || '').trim();
  const prRaw = String(values.pr || values['pr-number'] || '').trim();
  const prNumber = prRaw ? Number(prRaw) : null;
  if (prRaw && (!Number.isInteger(prNumber) || prNumber <= 0)) {
    return usageError(stderr, '--pr must be a positive integer');
  }
  if (repo && !isSafeRepo(repo)) return usageError(stderr, '--repo must be shaped owner/name');

  if (command === 'status') {
    let backlog;
    try {
      backlog = rereviewWakeBacklogImpl({ rootDir });
    } catch (err) {
      stderr.write(`rereview-wake-error: ${err?.message || err}\n`);
      return 70;
    }
    // Filtering here rather than in the backlog helper keeps the aggregate
    // counts (`pending`, `byReason`) describing the whole queue, so a scoped
    // lookup never makes a fleet-wide backlog look small.
    const entries = backlog.entries.filter((entry) => (
      (!repo || entry.repo === repo) && (prNumber === null || entry.prNumber === prNumber)
    ));
    const scoped = { ...backlog, scope: { repo: repo || null, prNumber }, entries };
    stdout.write(values.json ? `${JSON.stringify(scoped, null, 2)}\n` : renderStatus(scoped));
    return 0;
  }

  if (!isSafeRepo(repo)) return usageError(stderr, '--repo is required and must be shaped owner/name');
  if (prNumber === null) return usageError(stderr, '--pr is required');
  const reason = String(values.reason || REREVIEW_WAKE_REASONS.OPERATOR).trim();
  if (!KNOWN_REREVIEW_WAKE_REASONS.has(reason)) {
    return usageError(stderr, `--reason must be one of: ${REASON_LIST}`);
  }
  const requestedAt = String(values['requested-at'] || '').trim();
  if (requestedAt && Number.isNaN(Date.parse(requestedAt))) {
    return usageError(stderr, '--requested-at must be an ISO timestamp');
  }

  let result;
  try {
    result = requestRereviewWakeImpl({
      rootDir,
      repo,
      prNumber,
      headSha: String(values['head-sha'] || values.head || '').trim() || null,
      reason,
      source: String(values.source || 'operator-cli').trim() || 'operator-cli',
      ...(requestedAt ? { requestedAt } : {}),
    });
  } catch (err) {
    stderr.write(`rereview-wake-error: ${err?.message || err}\n`);
    return 70;
  }
  if (values.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    stdout.write(`${result.outcome} ${repo}#${prNumber} reason=${reason} detail=${result.reason}\n`);
  }
  // A coalesced duplicate is a success: the wake this operator asked for is
  // already enqueued. Only a genuine write/validation failure is non-zero, so
  // a retry loop around this command cannot wedge on its own idempotency.
  return result.outcome === 'failed' || result.outcome === 'invalid' ? 70 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}

export { main, renderStatus };

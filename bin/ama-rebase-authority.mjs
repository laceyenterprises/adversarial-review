#!/usr/bin/env node

import { readFileSync } from 'node:fs';

import {
  DEFAULT_REBASE_ATTEMPT_CAP,
  assessRebaseRecovery,
  requiresRebaseRecovery,
} from '../src/ama/rebase-authority.mjs';

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage:
  ama-rebase-authority.mjs needs-recovery --pr <pr.json> --verdict <verdict.json> --reviewed-sha <sha>
  ama-rebase-authority.mjs assess --pr <pr.json> [--verdict <verdict.json>] --reviewed-sha <sha> [--current-head <sha>] [--attempts <n>] [--cap <n>] [--reviewed-patchids <file>] [--rebased-patchids <file>] [--conflict] [--reverify-eligible true|false]
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
    if (key === 'conflict') {
      flags[key] = true;
      continue;
    }
    if (index + 1 >= rest.length) usage(64);
    flags[key] = rest[index + 1];
    index += 1;
  }
  return { command, flags };
}

function readJson(path, fallback = null) {
  if (!path) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readPatchIds(path) {
  if (!path) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean);
}

function asBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  if (value === true || value === 'true' || value === '1' || value === 'yes') return true;
  if (value === false || value === 'false' || value === '0' || value === 'no') return false;
  return fallback;
}

function asInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function writeJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function verdictReasons(verdict) {
  return Array.isArray(verdict?.reasons) ? verdict.reasons : [];
}

function commandNeedsRecovery(flags) {
  const pr = readJson(flags.pr);
  const verdict = readJson(flags.verdict, {});
  const reasons = verdictReasons(verdict);
  const staleOnly = verdict?.eligible === false
    && reasons.length === 1
    && reasons[0] === 'stale-review-head';
  const moduleRequired = requiresRebaseRecovery({
    reviewedHead: flags['reviewed-sha'],
    currentHead: pr?.headRefOid,
    mergeStateStatus: pr?.mergeStateStatus,
  });
  writeJson({
    needed: staleOnly || moduleRequired,
    staleOnly,
    mergeStateStatus: pr?.mergeStateStatus || null,
    currentHead: pr?.headRefOid || null,
    reasons,
  });
}

function commandAssess(flags) {
  const pr = readJson(flags.pr);
  const verdict = readJson(flags.verdict, {});
  const decision = assessRebaseRecovery({
    reviewedHead: flags['reviewed-sha'],
    currentHead: flags['current-head'] || pr?.headRefOid,
    mergeStateStatus: pr?.mergeStateStatus,
    attempts: asInteger(flags.attempts, 0),
    cap: asInteger(flags.cap, DEFAULT_REBASE_ATTEMPT_CAP),
    conflict: asBoolean(flags.conflict, false),
    reviewedPatchIds: readPatchIds(flags['reviewed-patchids']),
    rebasedPatchIds: readPatchIds(flags['rebased-patchids']),
    reverifyEligible: asBoolean(flags['reverify-eligible'], verdict?.eligible === true),
    reverifyReasons: verdictReasons(verdict),
    hamRemediationCommit: asBoolean(flags['ham-remediation-commit'], false),
    hamTerminalRemediationValidated: asBoolean(flags['ham-terminal-remediation-validated'], false),
  });
  writeJson(decision);
}

const { command, flags } = parseArgs(process.argv.slice(2));
if (command === 'needs-recovery') {
  commandNeedsRecovery(flags);
} else if (command === 'assess') {
  commandAssess(flags);
} else {
  usage(64);
}

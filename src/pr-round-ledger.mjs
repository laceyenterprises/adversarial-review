// REVIEWROUNDLEDGER-01 — one per-PR round ledger.
//
// Before this module a PR's remediation budget was derived from ONE producer's
// history: the follow-up job files. `summarizePRRemediationLedger` took the max
// `currentRound` across terminal jobs and keyed its non-blocking streak by that
// round number. Rounds made by anything else — a final-fix-all or conflict
// closure job (seeded at round 0), a hammer pass, an in-place HQ PR-update, an
// operator retrigger — were never charged, and two jobs that carried the same
// round number collapsed into one. Comments therefore restarted at "round 1 of
// N" and the tier budget never bound.
//
// The ledger is an append-only JSONL file per (domain, repo, PR). Every
// producer appends one line per round with a stable `roundId`; readers
// de-duplicate by `roundId`, so a retried write or a racing second writer can
// never double-charge, and two different rounds can never collapse. A `void`
// line uncharges a round that never really ran (a transient requeue that will
// re-spawn the same round, an unexecuted hammer dispatch). A later `record`
// line for the same id charges it again.
//
// This module is a leaf: it imports only node built-ins and the repo-name
// sanitizer, so the follow-up queue, the hammer ledger, the retrigger CLI and
// the comment renderer can all depend on it without a cycle.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeRepo } from './follow-up-job-names.mjs';

export const PR_ROUND_LEDGER_SCHEMA_VERSION = 1;

// Remediation rounds spend the PR's risk-tier budget. Review passes are
// recorded for visibility; an operator retrigger is a review pass charged to
// the operator.
export const PR_ROUND_KINDS = Object.freeze({
  FOLLOW_UP_BLOCKING: 'follow-up-blocking',
  FOLLOW_UP_NON_BLOCKING: 'follow-up-non-blocking',
  FINAL_FIX_ALL: 'final-fix-all',
  CONFLICT_PRIMARY: 'conflict-primary',
  HAMMER: 'hammer',
  HQ_PR_UPDATE: 'hq-pr-update',
  REVIEW_PASS: 'review-pass',
  OPERATOR_RETRIGGER: 'operator-retrigger',
});

const REMEDIATION_KINDS = new Set([
  PR_ROUND_KINDS.FOLLOW_UP_BLOCKING,
  PR_ROUND_KINDS.FOLLOW_UP_NON_BLOCKING,
  PR_ROUND_KINDS.FINAL_FIX_ALL,
  PR_ROUND_KINDS.CONFLICT_PRIMARY,
  PR_ROUND_KINDS.HAMMER,
  PR_ROUND_KINDS.HQ_PR_UPDATE,
]);
const REVIEW_KINDS = new Set([PR_ROUND_KINDS.REVIEW_PASS, PR_ROUND_KINDS.OPERATOR_RETRIGGER]);
const FOLLOW_UP_KINDS = new Set([
  PR_ROUND_KINDS.FOLLOW_UP_BLOCKING,
  PR_ROUND_KINDS.FOLLOW_UP_NON_BLOCKING,
  PR_ROUND_KINDS.FINAL_FIX_ALL,
  PR_ROUND_KINDS.CONFLICT_PRIMARY,
]);
// Closure-path rounds run after the budget by design (MSM): the hammer and the
// closure hand-off jobs remediate and merge without another builder loop.
const CLOSURE_KINDS = new Set([
  PR_ROUND_KINDS.FINAL_FIX_ALL,
  PR_ROUND_KINDS.CONFLICT_PRIMARY,
  PR_ROUND_KINDS.HAMMER,
]);

export const CHARGED_TO = Object.freeze({ PIPELINE: 'pipeline', OPERATOR: 'operator' });

export function isPrRoundKind(kind) {
  return REMEDIATION_KINDS.has(kind) || REVIEW_KINDS.has(kind);
}

export function isRemediationRoundKind(kind) {
  return REMEDIATION_KINDS.has(kind);
}

export function isFollowUpRoundKind(kind) {
  return FOLLOW_UP_KINDS.has(kind);
}

export function isClosureRoundKind(kind) {
  return CLOSURE_KINDS.has(kind);
}

export function prRoundLedgerPath(rootDir, { domainId = 'code-pr', repo, prNumber }) {
  return join(rootDir, 'data', 'pr-round-ledger',
    `${sanitizeRepo(String(domainId || 'code-pr'))}--${sanitizeRepo(String(repo).toLowerCase())}-pr-${Number(prNumber)}.jsonl`);
}

function validIdentity({ repo, prNumber }) {
  return Boolean(String(repo ?? '').trim()) && Number.isInteger(Number(prNumber)) && Number(prNumber) > 0;
}

export function followUpRoundId(jobId, round) {
  return `follow-up:${jobId}:r${Number(round)}`;
}

// The kind of round a follow-up job runs. Closure hand-off jobs are their own
// kinds so the summary shows who spent each round.
export function followUpRoundKind(job) {
  const reason = job?.closureHandoff?.reason;
  if (reason === 'final-fix-all') return PR_ROUND_KINDS.FINAL_FIX_ALL;
  if (reason) return PR_ROUND_KINDS.CONFLICT_PRIMARY;
  return job?.nonBlockingOnly === true
    ? PR_ROUND_KINDS.FOLLOW_UP_NON_BLOCKING
    : PR_ROUND_KINDS.FOLLOW_UP_BLOCKING;
}

function cleanString(value, max = 200) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/[\r\n]+/gu, ' ').trim();
  return text ? text.slice(0, max) : null;
}

/**
 * Read every line, newest state per roundId, in first-recorded order.
 * Unparseable lines are skipped (and reported) so one torn write cannot erase a
 * PR's history.
 */
export function readPrRoundLedger(rootDir, identity, { logger = console } = {}) {
  if (!rootDir || !validIdentity(identity)) return [];
  const path = prRoundLedgerPath(rootDir, identity);
  if (!existsSync(path)) return [];
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    logger?.warn?.(`[pr-round-ledger] unreadable ledger ${path}: ${err?.message || err}`);
    return [];
  }
  const byId = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch {
      logger?.warn?.(`[pr-round-ledger] skipping unparseable line in ${path}`);
      continue;
    }
    if (!entry || typeof entry.roundId !== 'string' || !entry.roundId) continue;
    const prior = byId.get(entry.roundId);
    if (entry.op === 'void') {
      if (prior) byId.set(entry.roundId, { ...prior, voided: true, voidedAt: entry.recordedAt || null });
      continue;
    }
    if (!isPrRoundKind(entry.kind)) continue;
    // A re-record of a voided round charges it again (it re-ran). A duplicate
    // record of a live round is the same round: keep the first.
    if (prior && !prior.voided) continue;
    byId.set(entry.roundId, { ...entry, voided: false, firstRecordedAt: prior?.firstRecordedAt || entry.recordedAt });
  }
  return [...byId.values()];
}

function appendLine(rootDir, identity, line) {
  const path = prRoundLedgerPath(rootDir, identity);
  mkdirSync(join(rootDir, 'data', 'pr-round-ledger'), { recursive: true });
  // One short line per append: O_APPEND keeps concurrent writers whole.
  appendFileSync(path, `${JSON.stringify(line)}\n`, { encoding: 'utf8', mode: 0o640 });
  return path;
}

/**
 * Record one round. Idempotent on `roundId`: a second record of a live round
 * returns the existing entry and writes nothing. Throws on an invalid kind or
 * identity so a producer cannot silently write an uncounted line.
 */
export function recordPrRound(rootDir, {
  domainId = 'code-pr',
  repo,
  prNumber,
  roundId,
  kind,
  chargedTo = CHARGED_TO.PIPELINE,
  headSha = null,
  jobId = null,
  launchRequestId = null,
  actor = null,
  source = null,
  reason = null,
  recordedAt = new Date().toISOString(),
} = {}) {
  if (!rootDir) throw new Error('pr-round-ledger: rootDir is required');
  if (!validIdentity({ repo, prNumber })) throw new Error('pr-round-ledger: repo and a positive prNumber are required');
  if (!isPrRoundKind(kind)) throw new Error(`pr-round-ledger: unknown round kind ${JSON.stringify(kind)}`);
  const id = cleanString(roundId, 300);
  if (!id) throw new Error('pr-round-ledger: roundId is required');
  if (![CHARGED_TO.PIPELINE, CHARGED_TO.OPERATOR].includes(chargedTo)) {
    throw new Error(`pr-round-ledger: chargedTo must be pipeline or operator, got ${JSON.stringify(chargedTo)}`);
  }
  // An operator retrigger is always the operator's spend, whatever the caller said.
  const charged = kind === PR_ROUND_KINDS.OPERATOR_RETRIGGER ? CHARGED_TO.OPERATOR : chargedTo;
  const identity = { domainId, repo, prNumber };
  const existing = readPrRoundLedger(rootDir, identity).find(entry => entry.roundId === id && !entry.voided);
  if (existing) return { recorded: false, entry: existing };
  const line = {
    schemaVersion: PR_ROUND_LEDGER_SCHEMA_VERSION,
    op: 'record',
    roundId: id,
    kind,
    class: REMEDIATION_KINDS.has(kind) ? 'remediation' : 'review',
    chargedTo: charged,
    domainId: String(domainId || 'code-pr'),
    repo: String(repo),
    prNumber: Number(prNumber),
    headSha: cleanString(headSha, 64),
    jobId: cleanString(jobId, 300),
    launchRequestId: cleanString(launchRequestId),
    actor: cleanString(actor),
    source: cleanString(source),
    reason: cleanString(reason, 400),
    recordedAt,
  };
  appendLine(rootDir, identity, line);
  return { recorded: true, entry: { ...line, voided: false, firstRecordedAt: recordedAt } };
}

/** Uncharge a round that did not run. No-op when the id was never recorded. */
export function voidPrRound(rootDir, { domainId = 'code-pr', repo, prNumber, roundId, reason = null,
  recordedAt = new Date().toISOString() } = {}) {
  if (!rootDir || !validIdentity({ repo, prNumber }) || !roundId) return { voided: false };
  const identity = { domainId, repo, prNumber };
  const live = readPrRoundLedger(rootDir, identity).find(entry => entry.roundId === roundId && !entry.voided);
  if (!live) return { voided: false };
  appendLine(rootDir, identity, { schemaVersion: PR_ROUND_LEDGER_SCHEMA_VERSION, op: 'void', roundId,
    reason: cleanString(reason, 400), recordedAt });
  return { voided: true };
}

/**
 * Summarize ledger entries. `excludeJobIds` drops follow-up rounds whose job is
 * still pending or in progress, matching the legacy "settled rounds only"
 * reading of `completedRoundsForPR`.
 */
export function summarizePrRoundLedgerEntries(entries, { budget = null, excludeJobIds = null } = {}) {
  const byKind = {};
  let remediationRoundsUsed = 0;
  let reviewPasses = 0;
  let operatorCharged = 0;
  let closureRounds = 0;
  const remediationRoundTimestamps = [];
  const live = (entries || []).filter(entry => !entry.voided);
  for (const entry of live) {
    if (excludeJobIds && entry.jobId && isFollowUpRoundKind(entry.kind) && excludeJobIds.has(entry.jobId)) continue;
    byKind[entry.kind] = (byKind[entry.kind] || 0) + 1;
    if (entry.chargedTo === CHARGED_TO.OPERATOR) operatorCharged += 1;
    if (REMEDIATION_KINDS.has(entry.kind)) {
      remediationRoundsUsed += 1;
      if (CLOSURE_KINDS.has(entry.kind)) closureRounds += 1;
      remediationRoundTimestamps.push({ round: remediationRoundsUsed, kind: entry.kind,
        recordedAt: entry.firstRecordedAt || entry.recordedAt || null });
    } else {
      reviewPasses += 1;
    }
  }
  const numericBudget = Number(budget);
  const hasBudget = Number.isInteger(numericBudget) && numericBudget >= 0;
  return {
    remediationRoundsUsed,
    reviewPasses,
    operatorCharged,
    closureRounds,
    byKind,
    budget: hasBudget ? numericBudget : null,
    budgetReached: hasBudget ? remediationRoundsUsed >= numericBudget : false,
    remediationRoundTimestamps,
  };
}

export function summarizePrRoundLedger(rootDir, identity, options = {}) {
  return summarizePrRoundLedgerEntries(readPrRoundLedger(rootDir, identity, options), options);
}

/**
 * One operator-facing line. Used by the remediation comment and by the
 * merge-agent rescue projection, so both say the same thing.
 */
export function formatPrRoundLedgerSummary(summary) {
  if (!summary) return null;
  const used = Number(summary.remediationRoundsUsed || 0);
  const budget = summary.budget === null || summary.budget === undefined ? '?' : summary.budget;
  const kinds = Object.entries(summary.byKind || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, count]) => `${kind} ${count}`)
    .join(', ');
  const parts = [`${used} of ${budget} remediation rounds used`];
  parts.push(`${Number(summary.reviewPasses || 0)} review passes`);
  if (Number(summary.operatorCharged || 0) > 0) parts.push(`${summary.operatorCharged} operator-charged`);
  return `${parts.join(' · ')}${kinds ? ` (${kinds})` : ''}`;
}

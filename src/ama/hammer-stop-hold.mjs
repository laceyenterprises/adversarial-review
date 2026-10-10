// NOOWNER-01 (SEV1) — after a hammer stops without merging, the next hammer
// run on the same head waits for an input to change, and the operator is paged
// once with the predicate the hammer named.
//
// Operator decisions, 2026-10-10: "Hammers judgement is final"; "Any operator
// action outside of critical safety requirement should be considered a Sev 1".
//
// Two incidents that day:
//   - podium PR 15 (Case 4): both hammer runs on head 9a1372c8 stopped at
//     `ci-not-green` because the repository has no CI ("zero check runs and
//     statuses"). The second run read the same inputs as the first, could not
//     end differently, and spent the per-PR cap. The cap page did not say why.
//   - agent-os PR 8022 (Case 3): the hammer rebased, pushed closer head
//     c9006987 and stopped at `unmerged-subrepo-parity-fix`. The closer then
//     asked for an exact-head re-review that policy never spawns on a closer
//     head, and the PR sat with no owner for hours.
//
// The closer reads the hammer's own terminal audit for the live head. When the
// latest terminal attempt for that head is `failed-without-merge`, the hammer
// is not dispatched again until one of these inputs differs from what the
// closer saw when it first observed the stop:
//   - the PR head SHA,
//   - the base branch SHA (a dependency merged, main moved),
//   - mergeability (MERGEABLE / CONFLICTING; UNKNOWN is not a reading), or
//   - the external check rollup (each check's latest state; the pipeline's own
//     gate context is excluded because the watcher writes it).
// Once an input changes, the hold releases for that stop and the closer's
// ordinary gates, lease and per-PR retry cap decide the one re-dispatch. A new
// no-merge on the same head starts a new hold. The page is sent once per head.
//
// State: data/follow-up-jobs/hammer-stop-hold/<repo>-pr-<n>.json, per head.

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic-write.mjs';
import { checkItemState, latestCheckRollupItems } from '../checks-summary.mjs';
import { readAmaAuditEntry } from './audit.mjs';

export const HAMMER_STOP_HOLD_REASON = 'hammer-stop-awaiting-input-change';
export const HAMMER_STOP_HOLD_PAGE_EVENT = 'ama_closer.hammer_stop_hold';

const STOP_OUTCOMES = new Set(['failed-without-merge', 'no-merge']);
// Process-local page debounce for a state file that cannot be written.
const PAGED_IN_PROCESS = new Set();

export function _resetHammerStopHoldPageDebounceForTests() {
  PAGED_IN_PROCESS.clear();
}
const TEXT_LIMIT = 300;
const HEADS_KEPT = 8;

function oneLine(value, limit = TEXT_LIMIT) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function holdStatePath(rootDir, repo, prNumber) {
  const safeRepo = String(repo || '').replace(/[^A-Za-z0-9._-]/g, '-');
  return join(rootDir, 'data', 'follow-up-jobs', 'hammer-stop-hold', `${safeRepo}-pr-${Number(prNumber)}.json`);
}

function readHoldState(rootDir, repo, prNumber) {
  try {
    const parsed = JSON.parse(readFileSync(holdStatePath(rootDir, repo, prNumber), 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.heads && typeof parsed.heads === 'object'
      ? parsed
      : { heads: {} };
  } catch {
    return { heads: {} };
  }
}

function writeHoldState(rootDir, repo, prNumber, state) {
  const path = holdStatePath(rootDir, repo, prNumber);
  mkdirSync(join(rootDir, 'data', 'follow-up-jobs', 'hammer-stop-hold'), { recursive: true });
  const heads = Object.entries(state.heads || {})
    .sort(([, a], [, b]) => String(b?.firstObservedAt || '').localeCompare(String(a?.firstObservedAt || '')))
    .slice(0, HEADS_KEPT);
  writeFileAtomic(path, `${JSON.stringify({ ...state, heads: Object.fromEntries(heads) }, null, 2)}\n`);
}

function attemptHead(attempt, fileHead) {
  for (const value of [attempt?.head, attempt?.currentHead, attempt?.headSha, attempt?.validatedHead]) {
    const text = String(value || '').trim();
    if (/^[0-9a-f]{7,40}$/i.test(text)) return text;
  }
  return fileHead;
}

function headsMatch(a, b) {
  const left = String(a || '').toLowerCase();
  const right = String(b || '').toLowerCase();
  if (!left || !right) return false;
  return left === right || (left.length < 40 && right.startsWith(left)) || (right.length < 40 && left.startsWith(right));
}

/**
 * The hammer's latest terminal decision recorded for `headSha`, read from the
 * audit file for that head and from the reviewed head's file (a hammer that
 * pushes a new head records its stop on the reviewed head with the new head
 * named in `head`/`currentHead`). Returns the stop only when that latest
 * terminal attempt is a no-merge; a later `deferred` or `succeeded` clears it.
 */
export function readHammerStopForHead({
  hqRoot,
  repo,
  prNumber,
  headSha,
  reviewedSha = null,
  readAuditImpl = readAmaAuditEntry,
  logger = console,
} = {}) {
  if (!hqRoot || !repo || !headSha) return null;
  const terminal = [];
  const files = [...new Set([headSha, reviewedSha].filter(Boolean))];
  for (const fileHead of files) {
    let doc;
    try {
      doc = readAuditImpl(hqRoot, repo, prNumber, fileHead);
    } catch (err) {
      logger?.warn?.(`[ama-closer] hammer stop audit unreadable for ${repo}#${prNumber}@${String(fileHead).slice(0, 12)}: ${err?.message || err}`);
      continue;
    }
    const entries = [
      ...(Array.isArray(doc?.attempts) ? doc.attempts : []),
      ...(Array.isArray(doc?.appendedRecords) ? doc.appendedRecords : []),
    ];
    entries.forEach((attempt, index) => {
      const outcome = String(attempt?.outcome || '').trim().toLowerCase();
      if (!outcome || outcome === 'in_progress') return;
      if (!headsMatch(attemptHead(attempt, fileHead), headSha)) return;
      terminal.push({
        attempt,
        outcome,
        fileHead,
        order: index,
        at: Date.parse(attempt?.startedAt || attempt?.timestamp || attempt?.recordedAt || '') || 0,
      });
    });
  }
  if (terminal.length === 0) return null;
  terminal.sort((a, b) => (a.at - b.at) || (a.order - b.order));
  const latest = terminal.at(-1);
  if (!STOP_OUTCOMES.has(latest.outcome)) return null;
  const { attempt } = latest;
  return {
    headSha,
    predicate: oneLine(attempt?.reason, 120) || 'reason-not-recorded',
    closingStatus: oneLine(attempt?.closingStatus),
    next: oneLine(attempt?.next),
    recordedAt: attempt?.startedAt || attempt?.timestamp || attempt?.recordedAt || null,
    stopKey: `${latest.fileHead}:${attempt?.attemptNumber ?? latest.order}:${attempt?.startedAt || attempt?.timestamp || ''}`,
  };
}

function checkName(item) {
  return String(item?.name || item?.context || item?.workflowName || '').trim().toLowerCase();
}

/**
 * The inputs a repeated hammer run would read. `excludeContexts` names the
 * pipeline's own status contexts, which the watcher itself writes.
 */
export function hammerStopInputs(prMetadata, { excludeContexts = [] } = {}) {
  const excluded = new Set((excludeContexts || []).map((ctx) => String(ctx || '').trim().toLowerCase()).filter(Boolean));
  const rollup = Array.isArray(prMetadata?.statusCheckRollup) ? prMetadata.statusCheckRollup : [];
  const checks = latestCheckRollupItems(rollup.filter((item) => !excluded.has(checkName(item))))
    .map((item) => `${checkName(item) || 'unnamed'}=${checkItemState(item) || 'NONE'}`)
    .sort();
  const mergeability = String(prMetadata?.mergeableState || '').trim().toUpperCase();
  return {
    headSha: prMetadata?.headSha || null,
    baseSha: prMetadata?.baseSha || null,
    mergeability: ['MERGEABLE', 'CONFLICTING'].includes(mergeability) ? mergeability : null,
    checks: checks.join('|'),
  };
}

// A missing current reading is not evidence of change; a newly available
// reading does release a hold whose previous observation was unknown (null).
export function changedHammerStopInputs(previous, current) {
  const changed = [];
  if (!previous || !current) return changed;
  if (current.headSha && previous.headSha !== current.headSha) changed.push('head');
  if (current.baseSha && previous.baseSha !== current.baseSha) changed.push('base');
  if (current.mergeability && previous.mergeability !== current.mergeability) {
    changed.push('mergeability');
  }
  if (typeof previous.checks === 'string' && typeof current.checks === 'string' && previous.checks !== current.checks) {
    changed.push('checks');
  }
  return changed;
}

/**
 * Decide whether to hold the next hammer run on the live head.
 *
 * @returns {Promise<{ action: 'none' } | { action: 'hold', hammerStop: object }
 *   | { action: 'release', hammerStop: object, changed: string[] }>}
 */
export async function evaluateHammerStopHold({
  rootDir,
  hqRoot,
  repo,
  prNumber,
  headSha,
  reviewedSha,
  prMetadata,
  excludeContexts = [],
  deliverAlertImpl = null,
  logger = console,
  now = new Date().toISOString(),
  readAuditImpl = readAmaAuditEntry,
} = {}) {
  if (!rootDir || !headSha) return { action: 'none' };
  const stop = readHammerStopForHead({ hqRoot, repo, prNumber, headSha, reviewedSha, readAuditImpl, logger });
  if (!stop) return { action: 'none' };
  const inputs = hammerStopInputs(prMetadata, { excludeContexts });
  const state = readHoldState(rootDir, repo, prNumber);
  const prior = state.heads[headSha];
  let entry = prior && prior.stopKey === stop.stopKey
    ? { ...prior }
    : {
      stopKey: stop.stopKey,
      predicate: stop.predicate,
      firstObservedAt: now,
      // A stop that follows a released hold read the inputs seen at release;
      // compare against those, not against this first observation.
      inputs: prior?.releasedInputs || inputs,
      pagedAt: prior?.pagedAt || null,
    };
  let dirty = !prior || prior.stopKey !== stop.stopKey;
  if (!entry.releasedAt) {
    const changed = changedHammerStopInputs(entry.inputs, inputs);
    if (changed.length > 0) {
      entry = { ...entry, releasedAt: now, releasedBy: changed, releasedInputs: inputs };
      dirty = true;
      logger?.log?.(JSON.stringify({
        event: 'ama_closer.hammer_stop_hold_released',
        repo, prNumber, headSha, predicate: stop.predicate, changed,
      }));
    }
  }
  const hammerStop = {
    headSha,
    predicate: stop.predicate,
    closingStatus: stop.closingStatus || null,
    since: entry.firstObservedAt,
  };
  if (entry.releasedAt) {
    if (dirty) persist();
    return { action: 'release', hammerStop, changed: entry.releasedBy || [] };
  }
  const debounceKey = `${repo}\0${prNumber}\0${headSha}`;
  if (!entry.pagedAt && !PAGED_IN_PROCESS.has(debounceKey) && typeof deliverAlertImpl === 'function') {
    const text = `Adversarial-review hammer stopped without merging ${repo}#${prNumber} on head `
      + `${String(headSha).slice(0, 12)}: ${stop.predicate}. `
      + (stop.closingStatus ? `Hammer said: ${stop.closingStatus} ` : '')
      + 'No further hammer run on this head until its head, base, mergeability or checks change; '
      + 'the watcher re-checks every tick and re-dispatches once when one does.';
    try {
      await deliverAlertImpl(text, {
        event: HAMMER_STOP_HOLD_PAGE_EVENT,
        payload: {
          repo, prNumber, headSha, predicate: stop.predicate, closingStatus: stop.closingStatus || null,
          next: stop.next || null, inputs,
        },
      });
      entry.pagedAt = now;
      dirty = true;
      PAGED_IN_PROCESS.add(debounceKey);
    } catch (err) {
      logger?.error?.(JSON.stringify({
        event: `${HAMMER_STOP_HOLD_PAGE_EVENT}_page_failed`,
        repo, prNumber, headSha, error: err?.message || String(err),
      }));
    }
  }
  if (dirty) persist();
  return { action: 'hold', hammerStop: { ...hammerStop, paged: Boolean(entry.pagedAt) || PAGED_IN_PROCESS.has(debounceKey) } };

  function persist() {
    try {
      writeHoldState(rootDir, repo, prNumber, { ...state, heads: { ...state.heads, [headSha]: entry } });
    } catch (err) {
      logger?.error?.(JSON.stringify({
        event: 'ama_closer.hammer_stop_hold_persist_failed',
        repo, prNumber, headSha, error: err?.message || String(err),
      }));
    }
  }
}

// Retain-loop cap — a bounded, per-(repo, pr, head) ceiling on how many
// consecutive `not-eligible` "retain" ticks the watcher will absorb before it
// stops returning `ama-pending` and escalates to the operator.
//
// Why this exists (confirmed incident, #5053):
//   When the hammer remediates a PR, its own remediation commit advances the head
//   → the settled review is flagged `stale-review-head` → the AMA closer returns
//   an eligibility miss with `skipMergeAgent:true, reason:'not-eligible'` →
//   `resolveMergeAgentCoexistenceForWatcher` short-circuits to `ama-pending`
//   BEFORE the coexistence decision, so the `AWAIT_OPERATOR_ACTION` escalation was
//   unreachable. Nothing capped this no-dispatch retain, so the watcher spun the
//   same tick every poll interval forever (a live 50-min stall on PR #5053).
//
// The core self-cert fix (own-commit suppression un-gated from cycle exhaustion)
// lets a self-certified head resume, but a genuinely un-resumable stale head (an
// UNREVIEWED external push, a real blocking finding, an operator-only override) must
// still terminate rather than spin. This cap is that terminal backstop: after K
// (default 3) `not-eligible` retains on the SAME head, the watcher routes to
// `AWAIT_OPERATOR_ACTION` and tells the operator to apply the `operator-approved`
// label (which forces past `stale-review-head` via `eligibility.mjs`
// `hasOperatorApprovedOverride`). A NEW head resets the counter, so a legitimately
// progressing PR is never falsely escalated.

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from './atomic-write.mjs';

// Default ceiling: 3 `not-eligible` retains on one head are tolerated; the (K+1)th
// retain on that same head escalates. Small on purpose — a head that cannot resume
// in a few ticks is not going to resume without operator action, so we surface it
// loudly instead of burning poll ticks.
export const AMA_RETAIN_LOOP_CAP = 3;

const AMA_RETAIN_LOOP_CAP_SCHEMA_VERSION = 1;

function amaRetainLoopCapDir(rootDir) {
  return join(rootDir, 'data', 'follow-up-jobs', 'ama-retain-loop-cap');
}

function sanitizePathSegment(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '-');
}

export function amaRetainLoopCapFilePath(rootDir, { repo, prNumber } = {}) {
  const safeRepo = sanitizePathSegment(String(repo ?? '').replace(/\//g, '__'));
  // Keyed on (repo, pr); the head is stored INSIDE the doc so a new head resets the
  // count. Keeping the file per-PR (not per-head) avoids leaking a file per head.
  return join(amaRetainLoopCapDir(rootDir), `${safeRepo}-pr-${Number(prNumber)}.json`);
}

function normalizeHead(value) {
  const str = String(value ?? '').trim();
  return str.length ? str : null;
}

function readLedger(rootDir, identity, { logger = console } = {}) {
  const filePath = amaRetainLoopCapFilePath(rootDir, identity);
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    // Absent ledger is the expected first-retain path (count starts at 0). Any
    // OTHER read error is treated as a fresh start too: this cap only ESCALATES
    // (to a safe operator-await terminal), so failing toward "not yet escalated"
    // costs at most one more retain tick, never an unsafe merge.
    if (err && err.code === 'ENOENT') return null;
    logger?.warn?.(
      `[ama-retain-loop-cap] failed to read ledger ${filePath} ` +
        `(${err?.code || err?.message || 'unknown'}); treating as a fresh retain series`,
    );
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    logger?.warn?.(
      `[ama-retain-loop-cap] ledger ${filePath} is corrupt ` +
        `(${err?.message || 'parse error'}); treating as a fresh retain series`,
    );
    return null;
  }
}

/**
 * Record one `not-eligible` retain on `headSha` and report whether the per-head
 * cap is now exceeded. A retain on a DIFFERENT head than the ledger records resets
 * the count to 1 (fresh series). The (cap+1)th retain on the same head returns
 * `capExceeded:true`.
 *
 * @returns {{ retainCount:number, capExceeded:boolean, headSha:(string|null), cap:number }}
 */
export function recordAmaRetain(rootDir, identity, {
  headSha,
  cap = AMA_RETAIN_LOOP_CAP,
  now = null,
  logger = console,
} = {}) {
  const head = normalizeHead(headSha);
  // No head to key on → cannot bound this series; report a single (uncapped)
  // retain. This is only reached when the PR head is unknown, which is itself a
  // separate degraded signal handled upstream.
  if (!head) {
    return { retainCount: 1, capExceeded: false, headSha: null, cap };
  }
  const existing = readLedger(rootDir, identity, { logger });
  const ledgerHead = normalizeHead(existing?.headSha);
  const sameHead = ledgerHead !== null && ledgerHead === head;
  const priorCount = sameHead ? Math.max(0, Number(existing?.retainCount || 0)) : 0;
  const retainCount = priorCount + 1;
  const doc = {
    schemaVersion: AMA_RETAIN_LOOP_CAP_SCHEMA_VERSION,
    repo: identity.repo,
    prNumber: Number(identity.prNumber),
    headSha: head,
    retainCount,
    createdAt: (sameHead ? existing?.createdAt : null) || now || null,
    updatedAt: now || null,
  };
  mkdirSync(amaRetainLoopCapDir(rootDir), { recursive: true });
  writeFileAtomic(amaRetainLoopCapFilePath(rootDir, identity), `${JSON.stringify(doc, null, 2)}\n`);
  return { retainCount, capExceeded: retainCount > cap, headSha: head, cap };
}

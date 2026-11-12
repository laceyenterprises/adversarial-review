// CLOSERHEADPIN-01: one answer for "which head does this closer own".
//
// A closer's inputs are pinned when it is requested (`HAM_TARGET_REMEDIATION_SHA`).
// The watcher carries a live closer lease forward to a new PR head (CLR-01) so
// that a head the closer itself pushed does not orphan its lease. A closer that
// has not booted cannot have pushed anything, so a head that moved before boot
// is foreign: carrying the lease onto it would say "you own Y" while the
// worker's inputs say "you own X", and the worker must refuse Y because it
// never adopts an unreviewed head. Instead the watcher ends that closer with
// the typed `superseded-head-moved` outcome (`supersedeHeadMovedCloser`), which
// releases the PR so the ordinary closure path re-arms at the new head.
//
// A booted closer whose head moves mid-run stands down with `head-changed`.
// It can record that world refusal at the live head and a later generic stop
// (for example a closing-status step) at its pinned head. The world refusal is
// the launch's decision: `readLaunchWorldRefusal` lets it win over any later
// closer deferral from the same launch, and the lease ends `superseded-head-moved`.
import { readdirSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { basename, dirname } from 'node:path';
import { amaAuditFilePath, readAmaAuditEntry } from './audit.mjs';
import { hammerStopOrigin } from './hammer-stop-origin.mjs';

export const SUPERSEDED_HEAD_MOVED = 'superseded-head-moved';

// Bound memory across launches. Metadata is checked every time: neither a late
// refusal nor an audit rewrite may be hidden behind a cached resolution.
const launchRefusals = new Map();
const MAX_CACHED_LAUNCHES = 128;

function auditFingerprint(directory, names, prefix) {
  try {
    return JSON.stringify(names.filter(name => name.startsWith(prefix)
      && /^[a-f0-9]{40}\.json$/i.test(name.slice(prefix.length))).sort().map(name => {
      const stat = statSync(join(directory, name), { bigint: true });
      return [name, String(stat.dev), String(stat.ino), String(stat.size),
        String(stat.mtimeNs), String(stat.ctimeNs)];
    }));
  } catch { return null; }
}

function worldOrigin(attempt) {
  if (attempt?.stopOrigin === 'world') return true;
  try { return hammerStopOrigin(attempt?.reason) === 'world'; } catch { return false; }
}

/**
 * The latest world refusal (`failed-without-merge`, world origin) that this
 * launch recorded for the PR at any head, or null. Unreadable audits are
 * skipped: absent evidence never invents a refusal.
 */
export function readLaunchWorldRefusal(hqRoot, { repo, prNumber }, launchRequestId, {
  readdirImpl = readdirSync,
} = {}) {
  if (!hqRoot || !repo || !launchRequestId) return null;
  let sample;
  try { sample = amaAuditFilePath(hqRoot, repo, prNumber, 'H'); } catch { return null; }
  const prefix = basename(sample).slice(0, -'H.json'.length);
  let names;
  try { names = readdirImpl(dirname(sample)); } catch { return null; }
  const cacheKey = JSON.stringify([hqRoot, repo, prNumber, launchRequestId]);
  const fingerprint = auditFingerprint(dirname(sample), names, prefix);
  const cached = launchRefusals.get(cacheKey);
  if (fingerprint !== null && cached?.fingerprint === fingerprint) {
    return cached.refusal ? { ...cached.refusal } : null;
  }
  let readableAudits = 0;
  let latest = null;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    const headSha = name.slice(prefix.length, -'.json'.length);
    if (!/^[a-f0-9]{40}$/i.test(headSha)) continue;
    let doc;
    try { doc = readAmaAuditEntry(hqRoot, repo, prNumber, headSha); } catch { continue; }
    if (doc) readableAudits++;
    for (const attempt of Array.isArray(doc?.attempts) ? doc.attempts : []) {
      if (attempt?.launchRequestId !== launchRequestId || attempt.outcome !== 'failed-without-merge'
        || !worldOrigin(attempt)) continue;
      if (!latest || String(attempt.startedAt || '') >= String(latest.startedAt || '')) {
        latest = { ...attempt, headSha };
      }
    }
  }
  // Do not cache a snapshot that changed while it was being read. Failures to
  // stat also disable caching rather than preserving possibly stale evidence.
  if (fingerprint !== null && readableAudits === JSON.parse(fingerprint).length
    && auditFingerprint(dirname(sample), names, prefix) === fingerprint) {
    launchRefusals.delete(cacheKey);
    launchRefusals.set(cacheKey, { fingerprint, refusal: latest ? { ...latest } : null });
    if (launchRefusals.size > MAX_CACHED_LAUNCHES) {
      launchRefusals.delete(launchRefusals.keys().next().value);
    }
  }
  return latest;
}

/** The closer-lease terminal outcome for a launch's own world refusal. */
export function worldRefusalLeaseOutcome(refusal) {
  if (!refusal) return null;
  return String(refusal.reason || '').split(':')[0] === 'head-changed'
    ? SUPERSEDED_HEAD_MOVED : 'failed-without-merge';
}

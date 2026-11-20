import { randomUUID } from 'node:crypto';
import { closeSync, constants, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import fsExt from 'fs-ext';

export const WORKSPACE_DIFF_ONLY_CAUSES = Object.freeze([
  'no-checkout', 'origin-unverified', 'head-fetch-failed', 'archive-unavailable', 'escaping-link',
]);
const ALERT_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Serialize across reviewer processes so concurrent attempts count once each
// and only one process observes each snapshot-to-diff-only transition.
export function recordReviewerWorkspaceMode({ auditDir, repoKey, cause, nowMs = Date.now() }) {
  if (cause !== null && !WORKSPACE_DIFF_ONLY_CAUSES.includes(cause)) throw new Error('unknown workspace cause');
  const root = join(auditDir, 'modes');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, `${repoKey}.json`);
  const fd = openSync(`${path}.lock`, constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    fsExt.flockSync(fd, 'ex');
    let previous = {};
    try { previous = JSON.parse(readFileSync(path, 'utf8')); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    const count = key => {
      const value = previous.diffOnlyCounts?.[key];
      return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    };
    const diffOnlyCounts = Object.fromEntries(WORKSPACE_DIFF_ONLY_CAUSES.map(key => [key,
      Math.min(Number.MAX_SAFE_INTEGER, count(key) + Number(key === cause)),
    ]));
    // A PR-authored escaping link is visible but cannot drive a page. Keep the
    // last operational mode so it also cannot mask a later operational outage.
    const mode = cause === null ? 'snapshot' : 'diff-only';
    const operationalMode = cause === 'escaping-link' ? previous.operationalMode ?? null : mode;
    const degraded = previous.mode === 'snapshot' && cause !== null;
    const alert = previous.operationalMode === 'snapshot' && operationalMode === 'diff-only'
      && (previous.lastAlertAtMs == null || nowMs - previous.lastAlertAtMs >= ALERT_INTERVAL_MS);
    const record = { mode, operationalMode, cause, diffOnlyCounts,
      lastAlertAtMs: alert ? nowMs : previous.lastAlertAtMs ?? null };
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
      renameSync(temp, path);
    } finally { rmSync(temp, { force: true }); }
    return { diffOnlyCount: cause === null ? null : diffOnlyCounts[cause], degraded, alert };
  } finally { closeSync(fd); }
}

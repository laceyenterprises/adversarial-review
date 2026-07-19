import { linkSync, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFollowUpJobDir } from './follow-up-jobs.mjs';

// ARC-19: reconcile claim-lock cluster extracted verbatim from
// follow-up-remediation.mjs. A single-owner advisory lock over an in-progress
// follow-up job (`<jobPath>.reconcile.lock`), plus the stale-artifact sweep that
// reclaims abandoned locks. Leaf module: no orchestration-monolith imports.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FOLLOW_UP_RECONCILE_CLAIM_STALE_MS = 60 * 60 * 1000;

function reconcileClaimPath(jobPath) {
  return `${jobPath}.reconcile.lock`;
}

function buildReconcileClaimOwnerToken({ ownerPid, claimedAt }) {
  return `${ownerPid}:${claimedAt}:${Math.random().toString(16).slice(2)}`;
}

function writeReconcileClaimLock(lockPath, payload) {
  const tmpPath = `${lockPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(tmpPath, payload, { encoding: 'utf8', flag: 'wx' });
    linkSync(tmpPath, lockPath);
    return true;
  } catch (err) {
    if (err?.code === 'EEXIST') {
      return false;
    }
    throw err;
  } finally {
    rmSync(tmpPath, { force: true });
  }
}

function readReconcileClaimLock(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function tryAcquireFollowUpReconcileClaim({ jobPath, now = () => new Date().toISOString(), ownerPid = process.pid } = {}) {
  const lockPath = reconcileClaimPath(jobPath);
  const claimedAt = now();
  const ownerToken = buildReconcileClaimOwnerToken({ ownerPid, claimedAt });
  const payload = `${JSON.stringify({ claimedAt, ownerPid, ownerToken })}\n`;
  if (writeReconcileClaimLock(lockPath, payload)) {
    return { acquired: true, lockPath, claimedAt, ownerPid, ownerToken };
  }

  const existing = readReconcileClaimLock(lockPath);
  const corruptOrInvalid = existing === null;
  const claimedAtMs = Date.parse(existing?.claimedAt || '');
  const nowMs = Date.parse(claimedAt);
  const hasValidClaimedAt = Number.isFinite(claimedAtMs);
  const stale = corruptOrInvalid
    || !hasValidClaimedAt
    || (Number.isFinite(nowMs) && nowMs - claimedAtMs > FOLLOW_UP_RECONCILE_CLAIM_STALE_MS);
  if (!stale) {
    return {
      acquired: false,
      lockPath,
      claimedAt: existing?.claimedAt || null,
      ownerPid: existing?.ownerPid || null,
      ownerToken: existing?.ownerToken || null,
    };
  }

  rmSync(lockPath, { force: true });
  if (writeReconcileClaimLock(lockPath, payload)) {
    return { acquired: true, lockPath, claimedAt, ownerPid, ownerToken, reclaimedStale: true };
  }
  return { acquired: false, lockPath, claimedAt: null, ownerPid: null };
}

function reconcileClaimMatchesOwner(existing, claim) {
  if (!existing || !claim) return false;
  if (claim.ownerToken) {
    return existing.ownerToken === claim.ownerToken;
  }
  return existing.claimedAt === claim.claimedAt
    && Number(existing.ownerPid) === Number(claim.ownerPid);
}

function releaseFollowUpReconcileClaim(claim) {
  if (!claim?.acquired || !claim?.lockPath) return;
  const existing = readReconcileClaimLock(claim.lockPath);
  if (reconcileClaimMatchesOwner(existing, claim)) {
    rmSync(claim.lockPath, { force: true });
  }
}

function cleanupReconcileClaimArtifacts({
  rootDir = ROOT,
  nowMs = Date.now(),
  staleMs = FOLLOW_UP_RECONCILE_CLAIM_STALE_MS,
  log = console,
} = {}) {
  const inProgressDir = getFollowUpJobDir(rootDir, 'inProgress');
  let scanned = 0;
  let removedTmp = 0;
  let removedLocks = 0;
  let skipped = 0;
  let errors = 0;
  let entries = [];
  try {
    entries = readdirSync(inProgressDir);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { scanned, removedTmp, removedLocks, skipped, errors };
    }
    throw err;
  }

  for (const entry of entries) {
    const isTmpClaim = entry.includes('.reconcile.lock.') && entry.endsWith('.tmp');
    const isClaimLock = entry.endsWith('.reconcile.lock');
    if (!isTmpClaim && !isClaimLock) continue;
    scanned += 1;
    const entryPath = join(inProgressDir, entry);
    let stat = null;
    try {
      stat = lstatSync(entryPath);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        skipped += 1;
        continue;
      }
      errors += 1;
      log.warn?.(`[follow-up-remediation] reconcile claim artifact stat failed for ${entryPath}: ${err?.message || err}`);
      continue;
    }
    if (!stat.isFile()) {
      skipped += 1;
      continue;
    }

    const ageMs = nowMs - stat.mtimeMs;
    if (isTmpClaim) {
      if (ageMs <= staleMs) {
        skipped += 1;
        continue;
      }
      try {
        rmSync(entryPath, { force: true });
        removedTmp += 1;
      } catch (err) {
        errors += 1;
        log.warn?.(`[follow-up-remediation] reconcile claim tmp cleanup failed for ${entryPath}: ${err?.message || err}`);
      }
      continue;
    }

    const existing = readReconcileClaimLock(entryPath);
    const claimedAtMs = Date.parse(existing?.claimedAt || '');
    const lockAgeMs = Number.isFinite(claimedAtMs) ? nowMs - claimedAtMs : ageMs;
    const stale = existing === null
      || !Number.isFinite(claimedAtMs)
      || lockAgeMs > staleMs;
    if (!stale) {
      skipped += 1;
      continue;
    }
    try {
      rmSync(entryPath, { force: true });
      removedLocks += 1;
    } catch (err) {
      errors += 1;
      log.warn?.(`[follow-up-remediation] reconcile claim lock cleanup failed for ${entryPath}: ${err?.message || err}`);
    }
  }
  return { scanned, removedTmp, removedLocks, skipped, errors };
}

export {
  reconcileClaimPath,
  buildReconcileClaimOwnerToken,
  writeReconcileClaimLock,
  readReconcileClaimLock,
  tryAcquireFollowUpReconcileClaim,
  reconcileClaimMatchesOwner,
  releaseFollowUpReconcileClaim,
  cleanupReconcileClaimArtifacts,
};

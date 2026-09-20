import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_MAX_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_ADDITIONAL_SLOTS = 6;

function paths(rootDir) {
  const dir = join(rootDir, 'data', 'reviewer-capacity');
  return { dir, state: join(dir, 'burst-lease.json'), events: join(dir, 'burst-events.jsonl') };
}

function emit(rootDir, event) {
  const target = paths(rootDir);
  mkdirSync(target.dir, { recursive: true });
  appendFileSync(target.events, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function persist(rootDir, lease) {
  const target = paths(rootDir);
  mkdirSync(target.dir, { recursive: true });
  const temporary = `${target.state}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(lease, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, target.state);
}

function readRaw(rootDir) {
  try {
    return JSON.parse(readFileSync(paths(rootDir).state, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { state: 'invalid', denialReason: `unreadable-state:${error?.message || error}` };
  }
}

function normalizeList(values) {
  return [...new Set((values || []).map((value) => String(value).trim()).filter(Boolean))].sort();
}

function requestReviewerBurstLease({
  rootDir,
  ttlMs,
  additionalSlots,
  eligibleRepos,
  activePack = null,
  budgetSlotMinutes,
  reason,
  requestedBy,
  safety = {},
  now = () => new Date(),
  maxTtlMs = DEFAULT_MAX_TTL_MS,
  maxAdditionalSlots = DEFAULT_MAX_ADDITIONAL_SLOTS,
} = {}) {
  const at = now();
  const requestedAt = at.toISOString();
  const slots = Number(additionalSlots);
  const duration = Number(ttlMs);
  const budget = Number(budgetSlotMinutes);
  const repos = normalizeList(eligibleRepos);
  const requestId = randomUUID();
  const base = {
    version: 1, requestId, state: 'requested', requestedAt, requestedBy: String(requestedBy || '').trim(),
    reason: String(reason || '').trim(), additionalSlots: slots, ttlMs: duration,
    eligibleRepos: repos, activePack: activePack ? String(activePack).trim() : null,
    budgetSlotMinutes: budget,
  };
  emit(rootDir, { type: 'reviewer_burst_requested', at: requestedAt, ...base });
  const prior = readRaw(rootDir);
  const unsafe = [
    ['quota', safety.quotaSafe],
    ['posting', safety.postingSafe],
    ['reviewer-health', safety.reviewerHealthy],
  ].filter(([, safe]) => safe !== true).map(([name]) => name);
  let denialReason = null;
  if (!base.requestedBy || !base.reason) denialReason = 'requested-by-and-reason-required';
  else if (!Number.isInteger(slots) || slots < 1 || slots > maxAdditionalSlots) denialReason = 'additional-slots-out-of-range';
  else if (!Number.isFinite(duration) || duration <= 0 || duration > maxTtlMs) denialReason = 'ttl-out-of-range';
  else if (repos.length === 0) denialReason = 'eligible-repo-scope-required';
  else if (!Number.isFinite(budget) || budget < (slots * duration) / 60_000) denialReason = 'budget-guard-exceeded';
  else if (unsafe.length > 0) denialReason = `unsafe:${unsafe.join(',')}`;
  if (denialReason) {
    const denied = { ...base, state: 'denied', deniedAt: requestedAt, denialReason };
    // A malformed update must not tear down a still-safe active lease. Its
    // denial remains durable in the event stream while the prior lease runs.
    if (prior?.state !== 'active' || Date.parse(prior.expiresAt) <= at.getTime()) persist(rootDir, denied);
    emit(rootDir, { type: 'reviewer_burst_denied', at: requestedAt, ...denied });
    return denied;
  }
  const lease = {
    ...base,
    state: 'active',
    activatedAt: requestedAt,
    expiresAt: new Date(at.getTime() + duration).toISOString(),
    supersedesRequestId: prior?.state === 'active' ? prior.requestId : null,
  };
  persist(rootDir, lease);
  emit(rootDir, { type: 'reviewer_burst_activated', at: requestedAt, ...lease });
  return lease;
}

function readReviewerBurstLease(rootDir, { now = () => new Date(), expire = true } = {}) {
  const lease = readRaw(rootDir);
  if (!lease) return { state: 'inactive' };
  if (lease.state === 'active' && Date.parse(lease.expiresAt) <= now().getTime()) {
    const expired = { ...lease, state: 'expired', expiredAt: now().toISOString() };
    if (expire) {
      persist(rootDir, expired);
      emit(rootDir, { type: 'reviewer_burst_expired', at: expired.expiredAt, ...expired });
    }
    return expired;
  }
  return lease;
}

function revokeReviewerBurstLease(rootDir, { revokedBy, reason, now = () => new Date() } = {}) {
  const lease = readReviewerBurstLease(rootDir, { now });
  if (lease.state !== 'active') return lease;
  const at = now().toISOString();
  const revoked = { ...lease, state: 'revoked', revokedAt: at, revokedBy, revokeReason: reason || 'manual-revoke' };
  persist(rootDir, revoked);
  emit(rootDir, { type: 'reviewer_burst_manually_revoked', at, ...revoked });
  return revoked;
}

function reviewerBurstCandidateEligible(candidate, lease) {
  if (lease?.state !== 'active') return false;
  if (!lease.eligibleRepos?.includes(String(candidate?.repoPath || ''))) return false;
  if (!lease.activePack) return true;
  return [
    candidate?.activePack,
    candidate?.activePackId,
    candidate?.packId,
    ...(Array.isArray(candidate?.activePackIds) ? candidate.activePackIds : []),
  ]
    .some((value) => String(value || '') === lease.activePack);
}

export {
  DEFAULT_MAX_ADDITIONAL_SLOTS,
  DEFAULT_MAX_TTL_MS,
  readReviewerBurstLease,
  requestReviewerBurstLease,
  reviewerBurstCandidateEligible,
  revokeReviewerBurstLease,
};

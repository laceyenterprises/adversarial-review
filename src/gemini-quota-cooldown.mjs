// Durable Gemini quota routing holds, scoped to reviewer identities.
import { readFileSync, unlinkSync } from 'node:fs';
import { writeFileAtomic } from './atomic-write.mjs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { resolveAdversarialReviewStateDir } from './reviewer-fence.mjs';


// Identity quota state belongs beside the watcher's durable review state.
export const GEMINI_QUOTA_COOLDOWN_MS = 30 * 60 * 1000;
export const MAX_GEMINI_QUOTA_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

function cooldownPath(rootDir, env) {
  return join(resolveAdversarialReviewStateDir(rootDir, env), 'gemini-quota-cooldown.json');
}

function readCooldowns({ rootDir, env, nowMs, log, hqOwner }) {
  const path = cooldownPath(rootDir, env);
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    // Pre-identity records describe the HQ owner's quota only.
    const records = state.resetAt ? { [hqOwner]: { resetAt: state.resetAt } } : state.identities || {};
    const active = Object.create(null);
    let expired = false;
    for (const [user, record] of Object.entries(records)) {
      const end = Date.parse(record?.resetAt);
      if (!Number.isFinite(end)) continue;
      if (nowMs < end) active[user] = { resetAt: record.resetAt };
      else {
        expired = true;
        log.info?.(`[watcher] Gemini quota cooldown ended at ${record.resetAt}`);
      }
    }
    if (expired) {
      if (Object.keys(active).length) writeFileAtomic(path, JSON.stringify({ identities: active }));
      else unlinkSync(path);
    }
    return active;
  } catch {
    // Unreadable state preserves the existing route.
    return Object.create(null);
  }
}

export function readGeminiQuotaCooldown({
  rootDir, env = process.env, nowMs = Date.now(), log = console,
  hqOwner = userInfo().username, identityUser = hqOwner,
}) {
  return readCooldowns({ rootDir, env, nowMs, log, hqOwner })[identityUser] || null;
}

// A routing hold exists only when every identity used by this runtime is cooled.
export function readGeminiQuotaCooldownForIdentities({
  rootDir, env = process.env, nowMs = Date.now(), log = console,
  hqOwner = userInfo().username, identities = [hqOwner],
}) {
  const records = readCooldowns({ rootDir, env, nowMs, log, hqOwner });
  if (!identities.length || identities.some((user) => !records[user])) return null;
  if (identities.length === 1 && identities[0] === hqOwner) return records[hqOwner];
  return { identities: identities.map((user) => ({ user, resetAt: records[user].resetAt })) };
}

export function startGeminiQuotaCooldown({
  rootDir, signal, env = process.env, nowMs = Date.now(), log = console,
  hqOwner = userInfo().username, identityUser = hqOwner,
}) {
  const records = readCooldowns({ rootDir, env, nowMs, log, hqOwner });
  if (records[identityUser]) return records[identityUser];
  const override = Number(env.AGENT_OS_GEMINI_QUOTA_COOLDOWN_MS);
  const windowMs = Number.isFinite(override) && override > 0 ? override : GEMINI_QUOTA_COOLDOWN_MS;
  const explicitResetMs = Date.parse(signal?.resetAt);
  const requestedMs = Number.isFinite(explicitResetMs) && explicitResetMs > nowMs
    ? explicitResetMs - nowMs : windowMs;
  const boundedMs = Math.min(requestedMs, MAX_GEMINI_QUOTA_COOLDOWN_MS);
  if (boundedMs !== requestedMs) {
    log.warn?.('[watcher] Gemini quota cooldown clamped to the seven-day maximum');
  }
  const state = { resetAt: new Date(nowMs + boundedMs).toISOString() };
  const path = cooldownPath(rootDir, env);
  try {
    records[identityUser] = state;
    writeFileAtomic(path, JSON.stringify({ identities: records }));
    log.info?.(`[watcher] Gemini quota cooldown started; ends at ${state.resetAt}`);
  } catch (error) {
    log.warn?.(`[watcher] Gemini quota cooldown persistence failed: ${error.message}`);
  }
  return state;
}

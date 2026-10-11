// Durable provider-wide Gemini quota routing hold.
import { readFileSync, unlinkSync } from 'node:fs';
import { writeFileAtomic } from './atomic-write.mjs';
import { join } from 'node:path';
import { resolveAdversarialReviewStateDir } from './reviewer-fence.mjs';


// Provider-wide state belongs beside the watcher's durable review state.
export const GEMINI_QUOTA_COOLDOWN_MS = 30 * 60 * 1000;
export const MAX_GEMINI_QUOTA_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

function cooldownPath(rootDir, env) {
  return join(resolveAdversarialReviewStateDir(rootDir, env), 'gemini-quota-cooldown.json');
}

export function readGeminiQuotaCooldown({ rootDir, env = process.env, nowMs = Date.now(), log = console }) {
  const path = cooldownPath(rootDir, env);
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    const end = Date.parse(state.resetAt);
    if (!Number.isFinite(end)) return null;
    if (nowMs < end) return state;
    unlinkSync(path);
    log.info?.(`[watcher] Gemini quota cooldown ended at ${state.resetAt}`);
  } catch {
    // Unreadable state preserves the existing route.
  }
  return null;
}

export function startGeminiQuotaCooldown({ rootDir, signal, env = process.env, nowMs = Date.now(), log = console }) {
  const existing = readGeminiQuotaCooldown({ rootDir, env, nowMs, log });
  if (existing) return existing;
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
    writeFileAtomic(path, JSON.stringify(state));
    log.info?.(`[watcher] Gemini quota cooldown started; ends at ${state.resetAt}`);
  } catch (error) {
    log.warn?.(`[watcher] Gemini quota cooldown persistence failed: ${error.message}`);
  }
  return state;
}

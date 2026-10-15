// Argus reserves the watcher's shared pool before spawning its isolated child.
// The child receives the lease; it must not create a second, independent lease.
import { getAgyReviewerIdentityPool } from './agy-reviewer-identities.mjs';
import { readGeminiQuotaCooldown } from './gemini-quota-cooldown.mjs';

export async function argusGeminiAvailability({
  rootDir, env = process.env, pool = getAgyReviewerIdentityPool(),
  nowMs = Date.now(), logger = console,
} = {}) {
  await pool.refreshReadiness();
  const plan = pool.plan();
  const users = plan.multi ? pool.readyUsers() : [plan.hqOwner];
  const available = users.some((identityUser) => !readGeminiQuotaCooldown({
    rootDir, env, nowMs, log: logger, hqOwner: plan.hqOwner, identityUser,
  }));
  const resets = plan.identities.map(({ user: identityUser }) => readGeminiQuotaCooldown({
    rootDir, env, nowMs, log: logger, hqOwner: plan.hqOwner, identityUser,
  })?.resetAt).filter(Boolean).sort();
  return { available, resetAt: available ? null : resets[0] || null };
}

export async function acquireArgusGeminiLease({ pool = getAgyReviewerIdentityPool(), ...options } = {}) {
  const availability = await argusGeminiAvailability({ pool, ...options });
  const lease = availability.available ? await pool.acquire() : null;
  return { lease, resetAt: availability.resetAt };
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';
import { githubBudgetBelowFloor, resolveThrottleFloor } from './rate-limit-throttle.mjs';

// One watcher owns this file. Persist across restarts; a healthy observation
// clears the episode. An unobserved poll breaks the sustained-low interval.
// A directly observed rollover retains the same episode and receipt.
export async function monitorGitHubBudgets({ rootDir, budgets, deliverAlert,
  logger = console, now = Date.now(), floor = resolveThrottleFloor(), activeCredential }) {
  const file = join(rootDir, 'data', 'api-cache', 'budget-deficits.json');
  let episodes;
  try { episodes = JSON.parse(readFileSync(file, 'utf8')); } catch { episodes = {}; }
  if (!episodes || typeof episodes !== 'object' || Array.isArray(episodes)) episodes = {};
  const before = JSON.stringify(episodes);
  const installations = new Map();
  for (const [key, bucket] of Object.entries(budgets)) {
    if (!bucket || Date.parse(bucket.resetAt) <= now) continue;
    const installation = bucket.credential || key.replace(/\/(?:core|graphql)$/, '');
    const group = installations.get(installation) || [];
    group.push({ key, bucket });
    installations.set(installation, group);
  }
  for (const key of Object.keys(episodes)) {
    if (!installations.has(key)) delete episodes[key];
  }
  for (const [key, group] of installations) {
    if (key.startsWith('installation-') || key === activeCredential) {
      logger.log(`[watcher] GitHub budget ${key}: ${group.map(({ bucket }) =>
        `${bucket.resource} remaining=${bucket.remaining}/${bucket.limit ?? 'unknown'} reset=${bucket.resetAt}`).join('; ')}`);
    }
    const low = group.filter(({ bucket }) => githubBudgetBelowFloor(bucket, floor));
    if (!low.length) { delete episodes[key]; continue; }
    const bucket = low[0].bucket;
    const prior = episodes[key];
    const episode = prior || { since: now, alerted: false };
    episode.resetAt = bucket.resetAt;
    episodes[key] = episode;
    if (!episode.alerted && now - episode.since > 15 * 60_000) {
      await deliverAlert(`GitHub API budget for ${key} has remained below the polling floor for over 15 minutes; closure and discovery may be delayed.`, {
        event: 'adversarial-github-budget',
        payload: { budget: key, remaining: bucket.remaining, since: new Date(episode.since).toISOString() },
      });
      episode.alerted = true;
    }
  }
  const next = JSON.stringify(episodes);
  if (next !== before) writeFileAtomic(file, next, { mode: 0o600 });
}

import { readFileSync } from 'node:fs';

// Default reservation sizing must remain importable without deployment config.
// The watcher still validates its runtime config and gives that interval priority.
let pollIntervalMs = 300_000;
try {
  const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  pollIntervalMs = config.pollIntervalMs ?? pollIntervalMs;
} catch { /* Use the ordinary poll default when the file is absent or invalid. */ }
export const WATCHER_POLL_INTERVAL_MS = pollIntervalMs;

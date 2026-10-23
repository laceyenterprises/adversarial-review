import { readFileSync } from 'node:fs';

// Share the watcher's existing startup configuration with daemon reservations.
const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
export const WATCHER_POLL_INTERVAL_MS = config.pollIntervalMs ?? 300_000;

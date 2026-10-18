import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Leaf reader shared by closer admission and event-driven hammer wakes.
export function amaCloserDispatchDir(rootDir) {
  return join(rootDir, 'data', 'follow-up-jobs', 'ama-closer-dispatches');
}

function sanitizeDispatchPathSegment(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '-');
}

export function amaCloserDispatchFilePath(rootDir, { repo, prNumber, headSha } = {}) {
  const safeRepo = sanitizeDispatchPathSegment(String(repo ?? '').replace(/\//g, '__'));
  const safeSha = sanitizeDispatchPathSegment(String(headSha || 'no-sha'));
  return join(amaCloserDispatchDir(rootDir), `${safeRepo}-pr-${Number(prNumber)}-${safeSha}.json`);
}

export function readAmaCloserDispatchRecord(rootDir, identity) {
  try {
    return JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8'));
  } catch {
    return null;
  }
}

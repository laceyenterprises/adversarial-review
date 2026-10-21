import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { listSettledJsonNames } from './dispatch-dir-names.mjs';

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

// Launches stay keyed to their dispatch head after the hammer rebases.
export function readAmaCloserDispatchRecordsForPR(rootDir, { repo, prNumber }) {
  const sample = basename(amaCloserDispatchFilePath(rootDir, { repo, prNumber, headSha: 'H' }));
  const prefix = sample.slice(0, -'H.json'.length);
  return listSettledJsonNames(amaCloserDispatchDir(rootDir))
    .filter(name => name.startsWith(prefix))
    .flatMap(name => {
      try {
        const record = JSON.parse(readFileSync(join(amaCloserDispatchDir(rootDir), name), 'utf8'));
        return record?.repo === repo && Number(record.prNumber) === Number(prNumber) ? [record] : [];
      } catch {
        return [];
      }
    });
}

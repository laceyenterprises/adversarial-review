import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { listSettledJsonNames } from './dispatch-dir-names.mjs';
import { followUpJobFileFilter } from '../follow-up-job-names.mjs';
import { repositoryNames } from '../repository-names.mjs';

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
export function readAmaCloserDispatchRecordsForPR(rootDir, { repo, prNumber, strict = false }) {
  const dir = amaCloserDispatchDir(rootDir);
  let names;
  try { names = strict ? readdirSync(dir) : listSettledJsonNames(dir); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const aliases = strict ? new Set(repositoryNames(rootDir, repo).map(name => name.toLowerCase())) : null;
  return names.filter(followUpJobFileFilter({ rootDir, repo, prNumber, caseInsensitiveRepo: strict }))
    .flatMap(name => {
      try {
        const record = JSON.parse(readFileSync(join(dir, name), 'utf8'));
        const matchesRepo = strict ? typeof record?.repo === 'string' && aliases.has(record.repo.toLowerCase())
          : record?.repo === repo;
        if (matchesRepo && Number(record.prNumber) === Number(prNumber)) return [record];
        if (strict) throw new Error('closer dispatch record identity mismatch');
        return [];
      } catch (error) {
        if (strict) throw error;
        return [];
      }
    });
}

// Interrupted submissions still require canonical receipt reconciliation.
export const isPreReceiptIntent = record => ['dispatching', 'dispatch-interrupted'].includes(record?.state);

export function hasUnsettledAmaCloserDispatch(rootDir, identity) {
  return readAmaCloserDispatchRecordsForPR(rootDir, { ...identity, strict: true })
    .some(record => !record.state || record.state === 'dispatched' || isPreReceiptIntent(record));
}

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchRequestMeaning } from './launch-request-status.mjs';
import { projectCloserPassAfterOutcome } from './closer-pass-projection.mjs';

// Independent telemetry: a process exit is not evidence of a merge. Keep the
// launch-terminal observation separate from the authoritative lease outcome.
export function closerOutcomeObservation(record, kind) {
  const prNumber = Number(record?.prNumber);
  if (!record || typeof record.repo !== 'string' || !record.repo.trim()
    || !Number.isSafeInteger(prNumber) || prNumber <= 0
    || typeof record.headSha !== 'string' || !record.headSha.trim()) return null;
  const launchRequestId = kind === 'lease-terminal' ? record.lrqId : record.launchRequestId;
  if (typeof launchRequestId !== 'string' || !launchRequestId) return null;
  if (kind === 'launch-terminal') {
    // A parked or provisional phase outcome must never enter the denominator.
    if (record.state !== 'launch-terminal' || !record.terminalLaunchStatus) return null;
    const meaning = launchRequestMeaning(record.terminalLaunchStatus);
    if (!meaning.terminal || meaning.parked) return null;
  } else if (kind === 'lease-terminal') {
    if (record.status !== 'terminal' || !record.terminalOutcome) return null;
  } else return null;
  const terminalAt = kind === 'lease-terminal' ? record.updatedAt : record.reconciledAt;
  if (typeof terminalAt !== 'string' || !Number.isFinite(Date.parse(terminalAt))) return null;
  const code = value => typeof value === 'string' && /^[a-z][a-z0-9_:-]{0,159}$/.test(value)
    ? value : null;
  const launchStatus = kind === 'launch-terminal' ? code(record.terminalLaunchStatus) : null;
  const outcome = kind === 'lease-terminal' ? code(record.terminalOutcome) : null;
  if (kind === 'launch-terminal' ? !launchStatus : !outcome) return null;
  return {
    schemaVersion: 1, kind, repo: record.repo, prNumber,
    headSha: record.headSha, launchRequestId, terminalAt,
    launchStatus, outcome,
  };
}

export function appendCloserOutcome(rootDir, record, kind, {
  append = appendFileSync, mkdir = mkdirSync, warn = message => console.warn(message),
} = {}) {
  try {
    const observation = closerOutcomeObservation(record, kind);
    if (!observation) {
      // Ordinary active/parked records and unlaunched leases are not evidence.
      // Rejected terminal candidates must leave a visible incompleteness signal.
      if ((kind === 'launch-terminal' && record?.state === 'launch-terminal')
        || (kind === 'lease-terminal' && record?.status === 'terminal' && record?.lrqId)) {
        throw new Error('Invalid terminal observation');
      }
      return false;
    }
    const dir = join(rootDir, 'data', 'ama-closer-outcomes');
    // One O_APPEND write per small row; concurrent writers never rewrite
    // history. Receipt replay is intentional: consumers deduplicate by launch.
    const filePath = join(dir, `${new Date(observation.terminalAt).toISOString().slice(0, 10)}.jsonl`);
    const row = `${JSON.stringify(observation)}\n`;
    const options = { encoding: 'utf8', mode: 0o640, flush: true };
    try {
      append(filePath, row, options);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      // Lazily create the directory, also recovering if it was removed since
      // a previous append. Retry once; all failures stay inside the guard.
      mkdir(dir, { recursive: true });
      append(filePath, row, options);
    }
    // QWV-04: this journal is the one closer-outcome writer; the launch's
    // reviewer_passes closer row is re-projected from it (never throws).
    if (kind === 'lease-terminal') projectCloserPassAfterOutcome(rootDir, observation.launchRequestId, { warn });
    return true;
  } catch {
    // Telemetry failure must not change closure, custody, or paging decisions.
    // Never include filesystem errors or arbitrary process output in this sink.
    try { warn('ama_closer.outcome_record_unavailable'); } catch { /* Diagnostic sinks are telemetry too. */ }
    return false;
  }
}

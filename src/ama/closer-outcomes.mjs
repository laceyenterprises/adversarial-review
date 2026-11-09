import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchRequestMeaning } from './launch-request-status.mjs';

// Independent telemetry: a process exit is not evidence of a merge. Keep the
// launch-terminal observation separate from the authoritative lease outcome.
export function closerOutcomeObservation(record, kind) {
  if (!record || typeof record.repo !== 'string' || !Number.isSafeInteger(record.prNumber)
    || record.prNumber <= 0 || typeof record.headSha !== 'string') return null;
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
  const code = value => typeof value === 'string' && /^[a-z][a-z0-9:-]{0,159}$/.test(value)
    ? value : null;
  return {
    schemaVersion: 1, kind, repo: record.repo, prNumber: record.prNumber,
    headSha: record.headSha, launchRequestId, terminalAt,
    launchStatus: kind === 'launch-terminal' ? code(record.terminalLaunchStatus) : null,
    outcome: kind === 'lease-terminal' ? code(record.terminalOutcome) : null,
  };
}

export function appendCloserOutcome(rootDir, record, kind, {
  append = appendFileSync, warn = message => console.warn(message),
} = {}) {
  const observation = closerOutcomeObservation(record, kind);
  if (!observation) return false;
  try {
    const dir = join(rootDir, 'data', 'ama-closer-outcomes');
    mkdirSync(dir, { recursive: true });
    // One O_APPEND write per small row; concurrent writers never rewrite
    // history. Receipt replay is intentional: consumers deduplicate by launch.
    append(join(dir, `${new Date(observation.terminalAt).toISOString().slice(0, 10)}.jsonl`),
      `${JSON.stringify(observation)}\n`, { encoding: 'utf8', mode: 0o640, flush: true });
    return true;
  } catch {
    // Telemetry failure must not change closure, custody, or paging decisions.
    // Never include filesystem errors or arbitrary process output in this sink.
    warn('ama_closer.outcome_record_unavailable');
    return false;
  }
}

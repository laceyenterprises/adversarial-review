import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendShadowRecord } from './merge-lane-journal.mjs';
import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
import { launchRequestInFlight, withLiveLaunchRetry } from './ama/launch-request-status.mjs';
import { readLatestWorkerRunStatusFromLedgerAsync } from './session-ledger-read-adapter.mjs';
const exec = promisify(execFile);

// Use the producer's latest worker even for terminal launches: branch custody
// outlives process execution. Git is inspected only, never reset or cleaned.
export async function readBranchCustody(launchRequestId, { readWorker = readLatestWorkerRunStatusFromLedgerAsync,
  git = exec, rootDir } = {}) {
  const timeoutMs = loadAwareTimeoutMs(2_000, { maxMs: 12_000 });
  const worker = await readWorker({ rootDir, launchRequestId, timeoutMs });
  let live = null;
  const process = worker?.ok && worker.row?.process;
  if (process?.exited_at) live = false;
  else if (Number.isInteger(process?.pid) && process.pid > 0 && process.started_at) {
    try {
      const result = await git('ps', ['-o', 'lstart=', '-p', String(process.pid)], {
        timeout: timeoutMs, maxBuffer: 4096, env: { ...globalThis.process.env, LC_ALL: 'C', TZ: 'UTC' },
      });
      const observed = Date.parse(`${result.stdout.trim()} UTC`);
      const expected = Date.parse(process.started_at);
      // Registration timestamps are not a guaranteed process-birth fingerprint.
      // An exact corroboration proves life; a mismatch remains unknown.
      if (Number.isFinite(observed) && Number.isFinite(expected) && Math.abs(observed - expected) < 1000) live = true;
    } catch { /* Failed process reads are unknown, never proof of death. */ }
  }
  const path = worker?.ok && (worker.row?.worktree_path || worker.row?.worktreePath);
  if (!path) return { state: 'unknown', branch: null, dirty: null, live };
  const options = { cwd: path, timeout: timeoutMs, maxBuffer: 256 * 1024, env: { ...globalThis.process.env, GIT_OPTIONAL_LOCKS: '0' } };
  let branch = null, dirty = null;
  try {
    branch = (await git('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], options)).stdout.trim();
  } catch { /* Detached or unreadable refs do not prevent status inspection. */ }
  try {
    const status = await git('git', ['status', '--porcelain=v1', '--untracked-files=normal'], options);
    dirty = status.stdout.length > 0;
  } catch { /* Unreadable custody does not discard verified process liveness. */ }
  return { state: dirty == null ? 'unknown' : 'complete', branch, dirty, live };
}

export async function captureMergeLaneObservation({ rootDir, shared, repo, prNumber, observedMs,
  custodyRead = readBranchCustody, write = appendShadowRecord }) {
  const { snapshot, decision } = shared;
  const closer = snapshot.observations?.launches?.value?.closer;
  let live = null;
  let terminalDirtyCustody = false;
  let custody = { state: 'unknown', branch: null, dirty: null };
  if (closer?.launchRequestId) {
    const probe = closer.probe || { ok: snapshot.observations.launches.state === 'complete', row: closer.row || { status: closer.status },
      retryChain: closer.retryChain, retryChainUnreadable: closer.retryChainUnreadable };
    const effective = withLiveLaunchRetry(probe);
    const scheduling = launchRequestInFlight(probe);
    try { custody = await custodyRead(effective.liveRetryLaunchRequestId || closer.launchRequestId, { rootDir }); } catch { /* explicit unknown */ }
    const matchesHead = !closer.headSha || closer.headSha === decision.head;
    terminalDirtyCustody = matchesHead && scheduling === false && custody.state === 'complete' && custody.dirty === true;
    if (matchesHead) live = scheduling === false ? false : custody.live ?? null;
  }
  if (decision.actor === 'reviewer') live = snapshot.observations?.reviews?.value?.reviewerLive ?? null;
  else if (decision.actor === 'remediator') live = snapshot.observations?.remediation?.value?.job?.live ?? null;
  else if (['daemon', 'watcher', 'ci', 'operator'].includes(decision.actor)) live = true;
  else if (!closer && (decision.actor === 'none' || snapshot.observations?.launches?.state === 'complete')) live = false;
  const record = { schema: 'merge-lane-observation/v1', kind: 'observation', subjectKey: snapshot.subjectKey,
    repo, prNumber, head: decision.head, generation: snapshot.generation ?? null, passId: snapshot.passId ?? null,
    observedAt: new Date(observedMs).toISOString(), state: snapshot.observations?.pr?.value?.state ?? 'unknown',
    next: { action: decision.action, actor: decision.actor, row: decision.row, reason: decision.reason,
      deadline: decision.deadline, decisionKey: decision.decisionKey },
    ownership: { live, custody, ownerless: live === true ? false
      : terminalDirtyCustody || live === false ? true : null } };
  return write(rootDir, 'observations.jsonl', record);
}

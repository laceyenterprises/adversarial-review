import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { isAmaCloserPidAlive } from './closer-lease.mjs';

const psOptions = { encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024 };
const validPid = pid => Number.isInteger(pid) && pid > 0;
// System process tables can include macOS kernel_task (PID 0).
const validRowPid = pid => Number.isInteger(pid) && pid >= 0;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  ? new Date(Date.parse(value)).toISOString() : null;
const psTimestamp = value => timestamp(`${value} UTC`);
const execFileAsync = promisify(execFile);
const psEnvironment = env => ({ ...process.env, ...env, LC_ALL: 'C', TZ: 'UTC' });

export function captureCloserProcessSync(pid, options = {}) {
  if (!validPid(pid)) return null;
  try {
    const stdout = (options.processExecFileSyncImpl || execFileSync)('ps', ['-o', 'lstart=', '-p', String(pid)],
      { ...psOptions, env: psEnvironment(options.env) });
    return { pid, startedAt: psTimestamp(String(stdout).trim()) };
  } catch { return { pid, startedAt: null }; }
}

// Best effort at spawn time. Missing identity never authorizes early recovery.
export async function captureCloserProcess(pid, options = {}) {
  if (!validPid(pid)) return null;
  try {
    const { stdout } = await (options.processExecFileImpl || execFileAsync)('ps', ['-o', 'lstart=', '-p', String(pid)],
      { ...psOptions, env: psEnvironment(options.env) });
    return { pid, startedAt: psTimestamp(String(stdout).trim()) };
  } catch { return { pid, startedAt: null }; }
}

// Scan before reading the ledger: a child can commit a launch then disappear
// during ps. The later exact-key query must observe that committed launch.
// Never persist or log command lines; keep only bounded identity evidence.
export function probeCloserSubmitter(record, lease, options = {}) {
  const watcher = { pid: lease.watcherPid, status: 'unknown', reason: 'watcher-liveness-unknown' };
  const submitter = { pid: record.dispatchSubmitter?.pid || null, status: 'unknown' };
  const key = { status: 'unknown', pids: [] };
  const result = { watcher, submitter, key };
  const alive = isAmaCloserPidAlive(lease.watcherPid, options.processKillImpl);
  if (alive === false) Object.assign(watcher, { status: 'gone', reason: 'pid-absent' });
  else if (alive === true) Object.assign(watcher, { status: 'live', reason: 'pid-present' });
  let rows;
  try {
    // ww avoids command truncation on both macOS and Linux. A timeout, buffer
    // overflow, empty result or malformed row is unknown, never an empty scan.
    const output = String((options.processExecFileSyncImpl || execFileSync)('ps',
      ['-axww', '-o', 'pid=', '-o', 'lstart=', '-o', 'args='],
      { ...psOptions, env: psEnvironment(options.env) }));
    if (!output.endsWith('\n')) throw Error('incomplete process scan');
    rows = [];
    for (const line of output.slice(0, -1).split('\n')) {
      const match = /^\s*(\d+)\s+(.{24})(?:\s+(.*))?$/.exec(line);
      if (!match) {
        // Embedded argument newlines continue the preceding command. Keep
        // them in the key scan, but an orphan continuation proves nothing.
        if (!rows.length) throw Error('invalid process row');
        rows.at(-1).command += `\n${line}`;
        continue;
      }
      if (!validRowPid(Number(match[1])) || !psTimestamp(match[2])) throw Error('invalid process row');
      rows.push({ pid: Number(match[1]), startedAt: psTimestamp(match[2]), command: match[3] || '' });
    }
  } catch {
    result.reason = 'process-scan-unreadable';
    return result;
  }
  const watcherRow = rows.find(row => row.pid === lease.watcherPid);
  const expectedWatcher = record.dispatchWatcher;
  if (watcherRow) {
    const expectedStartedAt = timestamp(expectedWatcher?.startedAt);
    if (expectedWatcher?.pid !== lease.watcherPid || !expectedStartedAt) {
      Object.assign(watcher, { status: 'unknown', reason: 'watcher-identity-unverified',
        observedStartedAt: watcherRow.startedAt });
    } else if (watcherRow.startedAt !== expectedStartedAt) {
      Object.assign(watcher, { status: 'gone', reason: 'pid-reused',
        expectedStartedAt: expectedWatcher.startedAt, observedStartedAt: watcherRow.startedAt });
    } else {
      Object.assign(watcher, { status: 'live', reason: 'pid-present', observedStartedAt: watcherRow.startedAt });
    }
  }
  const child = rows.find(row => row.pid === submitter.pid);
  if (record.dispatchSubmitter && !validPid(submitter.pid)) {
    Object.assign(submitter, { status: 'unknown', reason: 'submitter-identity-invalid' });
  } else if (!child) Object.assign(submitter, { status: 'gone', reason: 'pid-absent' });
  else if (timestamp(record.dispatchSubmitter?.startedAt)
    && child.startedAt !== timestamp(record.dispatchSubmitter.startedAt)) {
    Object.assign(submitter, { status: 'gone', reason: 'pid-reused',
      expectedStartedAt: record.dispatchSubmitter.startedAt, observedStartedAt: child.startedAt });
  } else Object.assign(submitter, { status: 'live', reason: 'pid-present', observedStartedAt: child.startedAt });
  const matching = rows.filter(row => row.command.includes(record.dispatchIdempotencyKey));
  key.status = matching.length ? 'live' : 'absent';
  key.pids = matching.slice(0, 16).map(row => row.pid);
  return result;
}

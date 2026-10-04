// Capacity is scheduling only; it grants no dispatch or merge authority.
export function effectiveCloserCap(backlog, floor = 3, ceiling = 32) {
  const minimum = Math.max(1, Math.trunc(Number(floor)) || 3);
  const maximum = Math.max(minimum, Math.trunc(Number(ceiling)) || 32);
  return Math.min(maximum, Math.max(minimum, Math.trunc(Number(backlog)) || 0));
}

export function launchHoldsCloserCapacity(row, processKillImpl = process.kill) {
  if (!['requested', 'leased', 'starting', 'running'].includes(String(row?.status || '').toLowerCase())) return false;
  if (row?.process_status && ['exited', 'dead', 'failed'].includes(row.process_status)) return false;
  if (row?.workerStatus && !['requested', 'leased', 'starting', 'running'].includes(row.workerStatus)) return false;
  const pid = row?.pid ?? row?.worker_process_pid;
  if (pid == null) return true;
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return true;
  try { processKillImpl(Number(pid), 0); return true; }
  catch { return true; } // PID absence alone is not terminal ledger evidence.
}

const warned = new Set();
export function warnCloserFloor(floor, ceiling, logger = console) {
  const key = `${floor}:${ceiling}`;
  if (Number(floor) < Number(ceiling) && !warned.has(key)) {
    warned.add(key);
    logger?.warn?.(`AMA configured max concurrency ${floor} is now a floor; adaptive ceiling is ${ceiling}.`);
  }
}

// Runtime run-ledger (ARC-09, v2 app architecture §6 / Win 1). An append-only
// per-run record keyed by the mode the run ACTUALLY finished in (`os` or
// `local`). The router's transition audit (router/audit.mjs) records failover
// and resume provenance; this ledger records the runs themselves so the
// `runtime status` CLI can report "runs (24h): os=41 local=7" truthfully.
//
// A run is recorded once, on settle, with `mode` taken from the settled
// RunResult.runtimeMode — so a run the router failed over to local (hard-error
// fast path) is counted as `local`, matching "runs finish in the mode they
// started" (§6.3). The wrapper below (`wrapRuntimeWithRunLedger`) is the
// composition seam the router-owning loop uses: it decorates an AgentRuntime so
// every run() records on await()/reattach() settle without the caller changing.
//
// Durability mirrors router/audit.mjs: O_APPEND writes of a single JSON line
// are atomic well under PIPE_BUF, and the fd is fsync'd so a crash can't lose an
// acknowledged run. Files rotate monthly (`data/runtime-runs/YYYY-MM.jsonl`).

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const RUN_LEDGER_SCHEMA_VERSION = 1;
const RUN_LEDGER_DIR = ['data', 'runtime-runs'];
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

const VALID_MODES = new Set(['os', 'local']);

function runLedgerDir(rootDir) {
  return join(rootDir, ...RUN_LEDGER_DIR);
}

function monthStamp(iso) {
  const stamp = String(iso ?? '');
  if (!/^\d{4}-(0[1-9]|1[0-2])/.test(stamp)) {
    throw new Error(`invalid runtime-run timestamp: ${iso}`);
  }
  return stamp.slice(0, 7);
}

function monthFilePath(rootDir, iso) {
  return join(runLedgerDir(rootDir), `${monthStamp(iso)}.jsonl`);
}

function normalizeMode(mode) {
  const normalized = String(mode ?? '').trim().toLowerCase();
  return VALID_MODES.has(normalized) ? normalized : 'unknown';
}

function buildRow({
  at,
  mode,
  status,
  domainId = null,
  kind = null,
  idempotencyKey = null,
  canary = false,
}) {
  return {
    schema_version: RUN_LEDGER_SCHEMA_VERSION,
    at,
    mode: normalizeMode(mode),
    status: status == null ? null : String(status),
    domain_id: domainId == null ? null : String(domainId),
    kind: kind == null ? null : String(kind),
    idempotency_key: idempotencyKey == null ? null : String(idempotencyKey),
    canary: canary === true,
  };
}

function defaultAppendRow(rootDir, row, { fileMode = 0o640 } = {}) {
  const dir = runLedgerDir(rootDir);
  mkdirSync(dir, { recursive: true });
  const filePath = monthFilePath(rootDir, row.at);
  const line = `${JSON.stringify(row)}\n`;
  const fd = openSync(filePath, 'a', fileMode);
  try {
    writeFileSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return filePath;
}

// Record a single settled run. `at` defaults to now; callers that want a
// deterministic timestamp (tests, replay) pass it explicitly.
function recordRuntimeRun(rootDir, entry = {}, { now = () => new Date(), appendRowFn = defaultAppendRow } = {}) {
  const at = entry.at || now().toISOString();
  const row = buildRow({ ...entry, at });
  const path = appendRowFn(rootDir, row);
  return { row, path };
}

// The set of `YYYY-MM` files a [sinceMs, nowMs] window can touch. A 24h window
// touches at most the current and previous month, but this walks the whole span
// so a larger window still reads every month it covers.
function monthStampsInWindow(sinceMs, nowMs) {
  const stamps = [];
  const start = new Date(sinceMs);
  // Anchor to the first of the start month, then step month-by-month.
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const endYear = new Date(nowMs).getUTCFullYear();
  const endMonth = new Date(nowMs).getUTCMonth();
  // Guard against an absurd span (misconfigured clock) blowing up the walk.
  let guard = 0;
  while (guard < 600) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth();
    stamps.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    if (y === endYear && m === endMonth) break;
    if (y > endYear || (y === endYear && m > endMonth)) break;
    cursor.setUTCMonth(m + 1);
    guard += 1;
  }
  return stamps;
}

function readRowsFromFile(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // A torn/partial final line (crash mid-append) is skipped rather than
      // failing the whole read — the ledger is advisory, not a source of truth
      // for correctness.
    }
  }
  return rows;
}

// Read every recorded run whose `at` falls within [now - windowMs, now].
function readRuntimeRuns(rootDir, { windowMs = DEFAULT_WINDOW_MS, now = () => new Date() } = {}) {
  const nowMs = now().getTime();
  const sinceMs = nowMs - Math.max(0, windowMs);
  if (!existsSync(runLedgerDir(rootDir))) return [];
  const rows = [];
  for (const stamp of monthStampsInWindow(sinceMs, nowMs)) {
    for (const row of readRowsFromFile(join(runLedgerDir(rootDir), `${stamp}.jsonl`))) {
      const atMs = Date.parse(row?.at ?? '');
      if (!Number.isFinite(atMs)) continue;
      if (atMs >= sinceMs && atMs <= nowMs) rows.push(row);
    }
  }
  return rows;
}

// Roll the window up into the counts the status surface needs.
function summarizeRuntimeRuns(rootDir, { windowMs = DEFAULT_WINDOW_MS, now = () => new Date() } = {}) {
  const rows = readRuntimeRuns(rootDir, { windowMs, now });
  const byMode = { os: 0, local: 0, unknown: 0 };
  const byStatus = {};
  let canary = 0;
  for (const row of rows) {
    const mode = normalizeMode(row?.mode);
    byMode[mode] = (byMode[mode] ?? 0) + 1;
    const status = row?.status ? String(row.status) : 'unknown';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (row?.canary === true) canary += 1;
  }
  return {
    windowMs,
    total: rows.length,
    os: byMode.os,
    local: byMode.local,
    unknown: byMode.unknown,
    byStatus,
    canary,
  };
}

// Decorate an AgentRuntime so every run() records to the ledger when it
// settles. `mode`/`domainId` fallbacks fill in when a RunResult omits them
// (e.g. an admission refusal before a runtime mode is known). Recording is
// best-effort: a ledger write failure NEVER fails the underlying run.
function wrapRuntimeWithRunLedger(runtime, {
  rootDir,
  mode: fallbackMode = null,
  domainId: fallbackDomainId = null,
  canary = false,
  now = () => new Date(),
  recordImpl = recordRuntimeRun,
  logger = console,
} = {}) {
  if (!runtime || typeof runtime.run !== 'function') {
    throw new TypeError('wrapRuntimeWithRunLedger requires an AgentRuntime');
  }

  function record(handle, result) {
    try {
      const ref = handle?.runRef != null ? String(handle.runRef) : null;
      recordImpl(rootDir, {
        mode: result?.runtimeMode || handle?.mode || fallbackMode,
        status: result?.status ?? null,
        domainId: fallbackDomainId,
        kind: result?.artifact?.kind ?? null,
        idempotencyKey: ref,
        canary,
      }, { now });
    } catch (err) {
      logger?.warn?.('[runtime-run-ledger] failed to record run', {
        error: err?.message || String(err),
      });
    }
  }

  function decorateHandle(handle) {
    let recorded = false;
    const once = (result) => {
      if (!recorded) {
        recorded = true;
        record(handle, result);
      }
      return result;
    };
    return {
      ...handle,
      runRef: handle.runRef,
      mode: handle.mode,
      async await() {
        return once(await handle.await());
      },
      async cancel() {
        return handle.cancel();
      },
      async reattach() {
        return once(await handle.reattach());
      },
    };
  }

  return {
    ...runtime,
    async run(request) {
      return decorateHandle(await runtime.run(request));
    },
  };
}

export {
  DEFAULT_WINDOW_MS,
  RUN_LEDGER_SCHEMA_VERSION,
  buildRow,
  monthStampsInWindow,
  readRuntimeRuns,
  recordRuntimeRun,
  runLedgerDir,
  summarizeRuntimeRuns,
  wrapRuntimeWithRunLedger,
};

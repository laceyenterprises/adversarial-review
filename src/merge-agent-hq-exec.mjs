// The `hq` subprocess invocation environment for the follow-up merge agent.
//
// Extracted verbatim from `follow-up-merge-agent.mjs` (ARC-19 decomposition).
// This leaf owns the mechanics of shelling out to the agent-os `hq`
// worker-pool CLI: locating the executable and detecting agent-os presence
// (`isExecutableFile` / `resolveExecutableOnPath` / `detectAgentOsPresence`),
// resolving the current OS user for `--as-owner`, the sleep retry primitive,
// and classifying `hq` exec outcomes (timeout / transient / the
// unsupported-`--priority`-flag case + the shared exec-failure formatter).
//
// It has no dependency on the dispatch/persist/coexistence state machine —
// it is a pure host-environment utility layer that the dispatch core imports.
// `DEFAULT_HQ_PATH` is kept as a behavior-preserving private copy per the
// existing leaf precedent (e.g. `remediation-oss-readiness.mjs`), so this
// module has no import edge back into `follow-up-merge-agent.mjs`.

import {
  constants as fsConstants,
  accessSync,
  existsSync,
  statSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { delimiter, join } from 'node:path';

const DEFAULT_HQ_PATH = 'hq';

function currentUser(env = process.env) {
  const explicit = String(env.USER || env.LOGNAME || '').trim();
  if (explicit) return explicit;
  try {
    return userInfo().username;
  } catch {
    return null;
  }
}

function formatExecFailure(command, err) {
  const stderrText = String(err?.stderr ?? '').trim();
  const stdoutText = String(err?.stdout ?? '').trim();
  const augmented = new Error(
    `${command} failed (exit code ${err?.code ?? 'unknown'}): ${err?.message || 'no message'}` +
    (stderrText ? `\n  stderr:\n${stderrText.split('\n').map(l => `    ${l}`).join('\n')}` : '') +
    (stdoutText ? `\n  stdout:\n${stdoutText.split('\n').map(l => `    ${l}`).join('\n')}` : '')
  );
  augmented.code = err?.code;
  augmented.stderr = err?.stderr;
  augmented.stdout = err?.stdout;
  augmented.cause = err;
  return augmented;
}

function errorDiagnosticLines(err) {
  const primary = [err?.stderr, err?.stdout].filter(Boolean).join('\n');
  const detail = primary || String(err?.message || '');
  return detail
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function isUnsupportedHqPriorityFlagError(err) {
  return errorDiagnosticLines(err).some((line) => {
    if (!line.includes('--priority')) return false;
    return /\b(unrecognized|unknown|no such|unexpected)\b.*\b(argument|option|flag|parameter)s?\b.*--priority\b/i.test(line)
      || /\b(argument|option|flag|parameter)s?\b.*--priority\b.*\b(unrecognized|unknown|no such|unexpected)\b/i.test(line);
  });
}

function isTransientHqDispatchError(err) {
  if (isExecTimeout(err)) return true;
  const detail = [
    err?.code,
    err?.message,
    err?.stderr,
    err?.stdout,
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return /\b(etimedout|econnreset|econnrefused|ehostunreach|eagain|epipe)\b/.test(detail)
    || detail.includes('database is locked')
    || detail.includes('sqlite_busy')
    || detail.includes('resource temporarily unavailable')
    || detail.includes('temporary failure')
    || detail.includes('temporarily unavailable');
}

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isExecTimeout(err) {
  return err?.code === 'ETIMEDOUT'
    || err?.killed === true
    || String(err?.message || '').toLowerCase().includes('timed out');
}

// Detect whether agent-os (the host OS that provides the `hq` worker-pool
// CLI + the merge-agent adapter) is present on this machine. The
// follow-up-merge-agent dispatch path is the only flow in adversarial-review
// that requires agent-os; everything else (watcher, reviewer, remediation)
// works standalone. So when agent-os is missing — OSS installs, fresh
// clones, CI sandboxes — we cleanly skip the merge-agent dispatch instead
// of blowing up on an ENOENT from `hq`.
//
// Detection order:
//   1. Explicit operator opt-out via `ADV_REVIEW_MERGE_AGENT_DISABLED=1`
//      (lets the operator force OSS mode even on a machine that has hq).
//   2. Explicit operator opt-in via `ADV_REVIEW_MERGE_AGENT_AGENT_OS=1`
//      (escape hatch for environments where detection misfires).
//   3. Explicit `hqPath` argument, when it is not the default `'hq'`.
//   4. `HQ_BIN` env var points to an existing file.
//   5. `hqPath` (defaults to `'hq'`) resolves on PATH.
// We resolve PATH in-process instead of spawning hq itself because hq can be
// slow to cold-start and we run this on every watcher tick.
function isExecutableFile(candidatePath, {
  fsImpl = { accessSync, existsSync, statSync },
} = {}) {
  if (!candidatePath) return false;
  const stat = fsImpl.statSync;
  if (typeof stat === 'function') {
    try {
      if (!stat(candidatePath).isFile()) return false;
    } catch {
      return false;
    }
  }
  if (typeof fsImpl.accessSync === 'function') {
    try {
      fsImpl.accessSync(candidatePath, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return Boolean(fsImpl.existsSync?.(candidatePath));
}

function resolveExecutableOnPath(command, {
  env = process.env,
  fsImpl = { accessSync, existsSync, statSync },
} = {}) {
  const trimmed = String(command ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return isExecutableFile(trimmed, { fsImpl }) ? trimmed : null;
  }
  const pathEntries = String(env.PATH ?? '').split(delimiter);
  for (const entry of pathEntries) {
    if (!entry) continue;
    const candidate = join(entry, trimmed);
    if (isExecutableFile(candidate, { fsImpl })) {
      return candidate;
    }
  }
  return null;
}

function detectAgentOsPresence({
  env = process.env,
  hqPath = DEFAULT_HQ_PATH,
  fsImpl = { accessSync, existsSync, statSync },
} = {}) {
  if (String(env.ADV_REVIEW_MERGE_AGENT_DISABLED ?? '').trim() === '1') {
    return { present: false, source: 'operator-disabled' };
  }
  if (String(env.ADV_REVIEW_MERGE_AGENT_AGENT_OS ?? '').trim() === '1') {
    return { present: true, source: 'operator-enabled' };
  }
  const trimmedHqPath = String(hqPath ?? '').trim();
  if (trimmedHqPath && trimmedHqPath !== DEFAULT_HQ_PATH) {
    const resolved = resolveExecutableOnPath(trimmedHqPath, { env, fsImpl });
    if (resolved) {
      return { present: true, source: 'arg:hqPath', path: resolved };
    }
    return { present: false, source: 'not-found' };
  }
  const hqBin = String(env.HQ_BIN ?? '').trim();
  if (hqBin && isExecutableFile(hqBin, { fsImpl })) {
    return { present: true, source: 'env:HQ_BIN', path: hqBin };
  }
  const resolved = resolveExecutableOnPath(trimmedHqPath || DEFAULT_HQ_PATH, { env, fsImpl });
  if (resolved) {
    return { present: true, source: 'path', path: resolved };
  }
  return { present: false, source: 'not-found' };
}

export {
  currentUser,
  formatExecFailure,
  errorDiagnosticLines,
  isUnsupportedHqPriorityFlagError,
  isTransientHqDispatchError,
  sleep,
  isExecTimeout,
  isExecutableFile,
  resolveExecutableOnPath,
  detectAgentOsPresence,
};

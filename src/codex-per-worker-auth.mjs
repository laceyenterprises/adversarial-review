// Per-worker codex credential materialization (burst OAuth-cascade fix).
//
// WHY THIS EXISTS
// ---------------
// The adversarial-review reviewer and the remediation worker both spawn the
// native Codex CLI pointed at a SHARED ChatGPT OAuth auth.json (via
// CODEX_AUTH_PATH, default ~/.codex/auth.json which is the operator's single
// credential). ChatGPT rotates the refresh_token on every refresh and
// server-side invalidates the prior value. When several codex processes run
// concurrently (a review storm, or a reviewer racing the hq-dispatch worker
// fleet) any one that refreshes the shared credential revokes everyone else's
// token -> the fleet-wide `spawn exited before pgid could be observed` /
// `refresh_token_invalidated` cascade. `codex exec --ephemeral` does NOT help:
// the rotation is a server-side effect of using the refresh_token value, not a
// local write.
//
// FIX
// ---
// Give each spawned codex its OWN auth.json carrying a PLACEHOLDER refresh_token
// (and, best-effort, a freshly broker-synced access_token). Codex requires the
// refresh_token field to be present but does not need it valid when the access
// token is fresh, so the process runs normally but can no longer perform a
// refresh that rotates the shared credential. A process that outlives its
// access-token TTL fails its own refresh in isolation (retryable) instead of
// poisoning every other codex worker on the host.
//
// SAFETY
// ------
//   * Fail-safe: any error (missing/invalid source, fs failure) returns null and
//     the caller falls back to the shared CODEX_AUTH_PATH exactly as before.
//   * Kill-switch: AGENT_OS_CODEX_PER_WORKER_AUTH=0 disables materialization.
//   * Contract-safe: the per-worker auth.json is materialized UNDER the source
//     credential's operator home (/Users/<u>/...), so a consumer that derives
//     HOME/owner from the auth path (the remediation startup contract) still
//     resolves the same operator home and does not trip a policy violation.

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PER_WORKER_PLACEHOLDER_REFRESH_TOKEN =
  'agent-os-per-worker-placeholder-no-rotate';
const KILL_SWITCH_ENV = 'AGENT_OS_CODEX_PER_WORKER_AUTH';
const PER_WORKER_DIRNAME = '.per-worker';
const DEFAULT_STALE_SWEEP_MS = 6 * 60 * 60 * 1000; // 6h

function perWorkerAuthEnabled(env) {
  return String(env[KILL_SWITCH_ENV] ?? '1') !== '0';
}

// Mirror of the remediation startup contract's resolveCodexAuthHome: a path of
// the shape /Users/<u>/... maps to /Users/<u>; anything else falls back to the
// grandparent dir. Keeping this in lock-step is what makes materialization
// contract-safe for the remediation consumer.
function resolveOperatorHome(authPath) {
  const normalized = resolve(authPath);
  const segments = normalized.split('/').filter(Boolean);
  if (segments[0] === 'Users' && segments[1]) {
    return `/${segments[0]}/${segments[1]}`;
  }
  return dirname(dirname(normalized));
}

function resolveAuthSyncBin(env) {
  const explicit = env.AGENT_OS_CODEX_WORKER_AUTH_SYNC_BIN;
  if (explicit && existsSync(explicit)) return explicit;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // src/ -> repo root -> agent-os parent (tools/adversarial-review is a
    // submodule of agent-os) -> runtime/...
    resolve(here, '..', '..', '..', 'runtime', 'acpx-runtime', 'bin', 'acpx-codex-worker-auth-sync'),
    '/Users/airlock/agent-os/runtime/acpx-runtime/bin/acpx-codex-worker-auth-sync',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function sweepStalePerWorkerAuth(baseDir, maxAgeMs, now) {
  try {
    if (!existsSync(baseDir)) return;
    const cutoff = now - maxAgeMs;
    for (const entry of readdirSync(baseDir)) {
      const full = join(baseDir, entry);
      try {
        if (statSync(full).mtimeMs < cutoff) {
          rmSync(full, { recursive: true, force: true });
        }
      } catch {
        /* best-effort sweep */
      }
    }
  } catch {
    /* best-effort sweep */
  }
}

/**
 * Materialize a per-worker codex auth.json for a single spawned process.
 *
 * @returns {{authPath:string, codexHome:string, home:string, cleanup:()=>void}|null}
 *   paths to use for the spawn, or null to fall back to the shared credential.
 */
export function materializePerWorkerCodexAuth({
  sharedAuthPath,
  key,
  env = process.env,
  brokerRefresh = true,
  pythonBin = null,
  now = Date.now(),
} = {}) {
  try {
    if (!perWorkerAuthEnabled(env)) return null;
    if (!sharedAuthPath || !existsSync(sharedAuthPath)) return null;

    let parsed;
    try {
      parsed = JSON.parse(readFileSync(sharedAuthPath, 'utf8'));
    } catch {
      return null;
    }
    if ((parsed?.auth_mode || '').toLowerCase() !== 'chatgpt') return null;
    if (!parsed?.tokens?.access_token) return null;

    const operatorHome = resolveOperatorHome(sharedAuthPath);
    const baseDir = join(operatorHome, '.codex', PER_WORKER_DIRNAME);
    sweepStalePerWorkerAuth(baseDir, DEFAULT_STALE_SWEEP_MS, now);

    const safeKey = String(key || `${process.pid}-${now}`).replace(/[^A-Za-z0-9._-]/g, '_');
    const codexHome = join(baseDir, safeKey);
    rmSync(codexHome, { recursive: true, force: true });
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });

    const authPath = join(codexHome, 'auth.json');
    const placeholdered = {
      ...parsed,
      tokens: {
        ...parsed.tokens,
        refresh_token: PER_WORKER_PLACEHOLDER_REFRESH_TOKEN,
      },
    };
    writeFileSync(authPath, JSON.stringify(placeholdered), { mode: 0o600 });
    chmodSync(authPath, 0o600);

    // Best-effort: top up the access/id token from the OAuth broker so a
    // long-running worker gets the maximum TTL before its (un-refreshable)
    // token expires. The copied token is already broker-fresh on a host where
    // the acpx-codex-worker-auth-sync LaunchAgent runs, so this only widens the
    // safety margin and never blocks the spawn.
    if (brokerRefresh) {
      const syncBin = resolveAuthSyncBin(env);
      if (syncBin) {
        try {
          execFileSync(pythonBin || env.HQ_PYTHON3 || env.AGENT_OS_PY || 'python3', [syncBin], {
            env: { ...env, CODEX_WORKER_AUTH_PATH: authPath },
            stdio: 'ignore',
            timeout: 15000,
          });
          // The sync helper never touches refresh_token, but re-assert the
          // placeholder defensively so no real refresh_token can ever land in
          // the per-worker file.
          const afterSync = JSON.parse(readFileSync(authPath, 'utf8'));
          afterSync.tokens = {
            ...afterSync.tokens,
            refresh_token: PER_WORKER_PLACEHOLDER_REFRESH_TOKEN,
          };
          writeFileSync(authPath, JSON.stringify(afterSync), { mode: 0o600 });
        } catch {
          /* best-effort; copied token remains valid for the run */
        }
      }
    }

    const cleanup = () => {
      try {
        rmSync(codexHome, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    };

    return { authPath, codexHome, home: operatorHome, cleanup };
  } catch {
    return null; // fail-safe: caller uses the shared credential
  }
}

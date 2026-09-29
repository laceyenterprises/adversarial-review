// Startup-only AGY reviewer auth preflight for the watcher.
//
// ARGUSDRAIN-01: moved out of watcher.mjs verbatim so the Argus drain's one
// call site fits under the ARC-18 line ratchet. The watcher re-exports it, so
// `import { warnIfAntigravityReviewerAuthUnavailable } from './watcher.mjs'`
// keeps working.

import { homedir } from 'node:os';

import { checkAgyReviewerAuth } from './agy-reviewer-auth.mjs';
import { getAgyReviewerIdentityPool } from './agy-reviewer-identities.mjs';
import { resolveGeminiRuntime } from './role-config.mjs';
import { scrubOAuthFallbackEnv } from './secret-source/env.mjs';

export async function warnIfAntigravityReviewerAuthUnavailable({
  env = process.env,
  log = console,
  resolveGeminiRuntimeImpl = resolveGeminiRuntime,
  checkAgyReviewerAuthImpl = checkAgyReviewerAuth,
  scrubOAuthFallbackEnvImpl = scrubOAuthFallbackEnv,
} = {}) {
  const runtime = resolveGeminiRuntimeImpl({ env });
  if (runtime !== 'antigravity') {
    return { checked: false, runtime };
  }

  const { env: scrubbedEnv } = scrubOAuthFallbackEnvImpl({
    ...env,
    HOME: env.HOME || homedir(),
  });
  let result;
  try {
    result = await checkAgyReviewerAuthImpl({ env: scrubbedEnv });
  } catch (err) {
    const detail = err?.message ? `: ${err.message}` : '';
    log.warn?.(
      `[watcher] WARN config key=reviewer.gemini.runtime: ` +
      `antigravity agy auth startup preflight threw (agy-probe-threw)${detail}. ` +
      'Startup will continue; the per-review AGY auth probe remains fail-closed.'
    );
    return { checked: true, ok: false, reason: 'agy-probe-threw' };
  }
  if (result?.ok) {
    return { checked: true, ok: true, reason: null, cached: Boolean(result.cached) };
  }
  const reason = result?.reason || 'agy-probe-failed';
  const detail = result?.detail ? `: ${result.detail}` : '';
  const remediation = result?.remediation ? ` ${result.remediation}` : '';
  log.warn?.(
    `[watcher] WARN config key=reviewer.gemini.runtime: ` +
    `antigravity agy auth startup preflight failed (${reason})${detail}.${remediation}`
  );
  return { checked: true, ok: false, reason };
}

// CCX-08: the watcher's startup call. Runs the HQ-owner auth preflight above,
// then each added reviewer identity's workspace-helper `sweep`, which removes
// scratch copies a crashed watcher or reviewer child leaked. Neither ever
// blocks startup. With a single identity the sweep is a no-op.
export async function runAgyReviewerStartupChecks({
  env = process.env,
  log = console,
  identityPool = getAgyReviewerIdentityPool(),
  warnIfUnavailableImpl = warnIfAntigravityReviewerAuthUnavailable,
} = {}) {
  const auth = await warnIfUnavailableImpl({ env, log });
  let sweep = [];
  try {
    sweep = await identityPool.sweepAll();
  } catch (err) {
    log.warn?.(`[watcher] WARN agy reviewer identity startup sweep failed: ${err?.message || err}`);
  }
  return { auth, sweep };
}

// Required reviewer context reads own their selected-bot auth recovery.
// One-shot reviewer processes keep this environment separate from the daemon.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { recordApiCall } from './api-telemetry.mjs';
import { fetchPullRequestReviewContext } from './github-api.mjs';
import { BROKER_REVIEWER_ROLES, resolveReviewerAppToken } from './reviewer-broker-refresh.mjs';
import { GithubAuthOutageError, isGhAuthFailure } from './gh-cli.mjs';
import { preflightGeminiReviewerToken } from './gemini-reviewer-preflight.mjs';

const execFileAsync = promisify(execFile);

// Pin every `gh` invocation in the reviewer process to the reviewer's OWN
// identity token (the value at env[botTokenEnv]) by setting GH_TOKEN/GITHUB_TOKEN.
// The gh env is built by github-api's buildGhEnv(), which only forwards
// GH_TOKEN/GITHUB_TOKEN from the environment; a daemon-spawned reviewer has
// neither set (only botTokenEnv), so gh reaches for its keychain-stored PAT —
// inaccessible in the system-domain daemon security session — and the PR-context
// fetch fails, mis-classified as `oauth-broken`, stalling all reviews (SEV0
// 2026-08-11). Pinning both here also stops the fetch from silently using the
// watcher's merge-agent GITHUB_TOKEN: only the reviewer's own bot identity drives
// gh. Returns whether a token was found so required context can refuse an empty env.
function pinReviewerGhIdentity(env, botTokenEnv) {
  const token = env && botTokenEnv ? env[botTokenEnv] : undefined;
  if (typeof token === 'string' && token.length > 0) {
    env.GH_TOKEN = token;
    env.GITHUB_TOKEN = token;
    return { pinned: true, botTokenEnv };
  }
  return { pinned: false, botTokenEnv };
}

async function fetchPRContext(repo, prNumber, {
  botTokenEnv = null,
  execFileImpl = execFileAsync,
  recordApiCallImpl = recordApiCall,
  fetchImpl,
  readFileImpl,
  log = console,
} = {}) {
  // reviewer.mjs is one PR per process. Both the adapter and GraphQL fallback
  // read this isolated process.env; the daemon's later refresh cannot repair it.
  const readContext = () => fetchPullRequestReviewContext(repo, prNumber, {
    execFileImpl, recordApiCallImpl,
  });
  // Prompt enrichment reuses the already pinned environment. The required
  // pre-context call supplies the selected token explicitly, never a model guess.
  if (!botTokenEnv) return readContext();
  if (!pinReviewerGhIdentity(process.env, botTokenEnv).pinned) {
    throw new GithubAuthOutageError(`[github-auth-outage] required PR context missing selected ${botTokenEnv}`);
  }
  preflightGeminiReviewerToken({ env: process.env, botTokenEnv });
  try {
    return await readContext();
  } catch (err) {
    if (!isGhAuthFailure(err)) throw err;
    const role = BROKER_REVIEWER_ROLES.find((entry) => entry.envVar === botTokenEnv);
    if (!role || String(process.env[role.flag] || '').trim() !== 'true') {
      throw new GithubAuthOutageError(
        `[github-auth-outage] required PR context rejected selected ${botTokenEnv}; broker mode disabled`,
        { cause: err }
      );
    }
    // Resolve into a private candidate until provider/App/installation, expiry
    // and replacement checks pass. Never refresh watcher/merge-agent credentials.
    const candidateEnv = { ...process.env };
    let refreshed;
    try {
      refreshed = await resolveReviewerAppToken(botTokenEnv, {
        env: candidateEnv, force: true, fetchImpl, readFileImpl,
      });
    } catch (brokerErr) {
      throw new GithubAuthOutageError(
        `[github-auth-outage] required PR context selected ${role.role} broker re-mint failed; inspect provider/key/installation`,
        { cause: brokerErr, remintAttempted: true }
      );
    }
    if (refreshed.envVar !== botTokenEnv || !refreshed.token
      || refreshed.token === process.env[botTokenEnv]
      || refreshed.expiresAtMs == null || refreshed.expiresAtMs <= Date.now()) {
      throw new GithubAuthOutageError(
        `[github-auth-outage] required PR context selected ${role.role} re-mint did not supply a fresh replacement`,
        { cause: err, remintAttempted: true }
      );
    }
    process.env[botTokenEnv] = refreshed.token;
    pinReviewerGhIdentity(process.env, botTokenEnv);
    log.warn?.(`[reviewer] refreshed selected ${botTokenEnv}; retrying required PR context once`);
    try {
      return await readContext();
    } catch (retryErr) {
      if (!isGhAuthFailure(retryErr)) throw retryErr;
      throw new GithubAuthOutageError(
        `[github-auth-outage] required PR context rejected selected ${role.role} after one broker re-mint`,
        { cause: retryErr, remintAttempted: true }
      );
    }
  }
}

export { fetchPRContext, pinReviewerGhIdentity };

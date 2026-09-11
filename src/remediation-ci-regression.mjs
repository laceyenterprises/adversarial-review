import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveRequiredCheckContextsFromCfg } from './ama/required-check-contexts.mjs';
import { resolveGateStatusContext } from './adversarial-gate-context.mjs';
import { summarizeChecksConclusion } from './checks-summary.mjs';
import { execGhWithRetry } from './gh-cli.mjs';

const execFileAsync = promisify(execFile);

const DEFAULT_ADVERSARIAL_GATE_CONTEXT = 'agent-os/adversarial-gate';
const SUCCESSFUL_CHECK_STATES = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const PENDING_CHECK_STATES = new Set([
  'PENDING',
  'IN_PROGRESS',
  'QUEUED',
  'EXPECTED',
  'WAITING',
  'REQUESTED',
]);

function ownGateContexts(env = process.env) {
  const contexts = new Set([DEFAULT_ADVERSARIAL_GATE_CONTEXT.toLowerCase()]);
  try {
    contexts.add(String(resolveGateStatusContext(env)).trim().toLowerCase());
  } catch {
    // Bad optional gate-context config must not prevent us from checking
    // external CI. The default self-gate context is still filtered.
  }
  return contexts;
}

function isOwnGateItem(item, env = process.env) {
  if (item?.__typename && item.__typename !== 'StatusContext') return false;
  const context = String(item?.context || '').trim().toLowerCase();
  return context ? ownGateContexts(env).has(context) : false;
}

function normalizeCheckState(item) {
  return String(
    item?.conclusion
    || item?.status
    || item?.state
    || item?.statusCheckRollup?.state
    || ''
  ).trim().toUpperCase();
}

function checkName(item) {
  return String(item?.name || item?.context || item?.workflowName || 'unknown-check').trim();
}

function normalizeCheckForRecord(item) {
  return {
    name: checkName(item),
    state: normalizeCheckState(item) || 'UNKNOWN',
    workflowName: item?.workflowName || null,
    detailsUrl: item?.detailsUrl || item?.targetUrl || null,
  };
}

function summarizeExternalChecks(statusCheckRollup, { env = process.env, cfg = null } = {}) {
  const rollupKnown = Array.isArray(statusCheckRollup);
  const conclusion = summarizeChecksConclusion(statusCheckRollup, { env, cfg });
  const items = rollupKnown ? statusCheckRollup : [];
  const external = items.filter((item) => !isOwnGateItem(item, env));
  const failedChecks = [];
  const pendingChecks = [];
  const reportedContexts = new Set(
    external
      .map((item) => String(item?.context || item?.name || '').trim().toLowerCase())
      .filter(Boolean)
  );
  const requiredContexts = resolveRequiredCheckContextsFromCfg(cfg)
    .map((context) => String(context).trim())
    .filter(Boolean);

  for (const item of external) {
    const state = normalizeCheckState(item);
    if (!state || PENDING_CHECK_STATES.has(state)) {
      pendingChecks.push(normalizeCheckForRecord(item));
      continue;
    }
    if (!SUCCESSFUL_CHECK_STATES.has(state)) {
      failedChecks.push(normalizeCheckForRecord(item));
    }
  }
  for (const context of requiredContexts) {
    if (reportedContexts.has(context.toLowerCase())) continue;
    pendingChecks.push({
      name: context,
      state: 'PENDING',
      workflowName: null,
      detailsUrl: null,
    });
  }

  return {
    conclusion,
    rollupKnown,
    failedChecks,
    pendingChecks,
    totalExternalChecks: external.length,
  };
}

async function fetchPullRequestChecks({
  repo,
  prNumber,
  execFileImpl = execFileAsync,
  env = process.env,
  log = console,
} = {}) {
  const { stdout } = await execGhWithRetry({
    execFileImpl,
    env,
    log,
    args: [
      'pr',
      'view',
      String(prNumber),
      '--repo',
      repo,
      '--json',
      'headRefOid,statusCheckRollup',
    ],
  });
  const parsed = JSON.parse(String(stdout || '{}'));
  return {
    headSha: parsed?.headRefOid || null,
    statusCheckRollup: Array.isArray(parsed?.statusCheckRollup) ? parsed.statusCheckRollup : null,
  };
}

async function inspectRemediationCiRegression({
  repo,
  prNumber,
  execFileImpl = execFileAsync,
  env = process.env,
  log = console,
  cfg = null,
} = {}) {
  let payload;
  try {
    payload = await fetchPullRequestChecks({ repo, prNumber, execFileImpl, env, log });
  } catch (err) {
    return {
      state: 'unknown',
      conclusion: null,
      headSha: null,
      totalExternalChecks: 0,
      failedChecks: [],
      pendingChecks: [],
      error: err?.message || String(err),
    };
  }

  const summary = summarizeExternalChecks(payload.statusCheckRollup, { env, cfg });
  if (!summary.rollupKnown) {
    return {
      state: 'unknown',
      headSha: payload.headSha,
      ...summary,
    };
  }
  if (summary.failedChecks.length > 0) {
    return {
      state: 'failed',
      headSha: payload.headSha,
      ...summary,
    };
  }
  if (summary.pendingChecks.length > 0) {
    return {
      state: 'pending',
      headSha: payload.headSha,
      ...summary,
    };
  }
  return {
    state: 'green',
    headSha: payload.headSha,
    ...summary,
  };
}

export {
  inspectRemediationCiRegression,
  summarizeExternalChecks,
};

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from './atomic-write.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

const LOCAL_REVIEW_SHADOW_LABEL = 'run-local-review-shadow';
const DEFAULT_LOCAL_REVIEW_SHADOW_TIMEOUT_MS = 90_000;
const DEFAULT_LOCAL_REVIEW_SHADOW_URL = 'http://127.0.0.1:4000/v1/chat/completions';
const LOCAL_REVIEW_SHADOW_FILE_MODE = 0o600;
const LOCAL_REVIEW_SHADOW_RETRY_BACKOFF_MS = 15 * 60 * 1000;
const activeLocalReviewShadowReconciliations = new Set();

const BUILDER_FAMILY_BY_TAG = Object.freeze({
  codex: 'codex',
  '[codex]': 'codex',
  'claude-code': 'claude',
  '[claude-code]': 'claude',
  'clio-agent': 'codex',
  '[clio-agent]': 'codex',
  gemini: 'gemini',
  '[gemini]': 'gemini',
});

const REVIEWER_FAMILY_BY_MODEL = Object.freeze({
  claude: 'claude',
  'claude-code': 'claude',
  codex: 'codex',
  gemini: 'gemini',
});

// Checked-in metadata for local OSS models that may be used through LiteLLM.
// Unknown local model names fail closed to hosted-only behavior.
const LOCAL_REVIEW_SHADOW_MODEL_METADATA = Object.freeze({
  'local-oss-reviewer': { family: 'oss', provenance: 'local OSS model via LiteLLM' },
  'ollama/qwen2.5-coder:32b': { family: 'oss', provenance: 'local OSS model via LiteLLM' },
  'ollama/qwen2.5-coder:14b': { family: 'oss', provenance: 'local OSS model via LiteLLM' },
  'ollama/deepseek-coder-v2:16b': { family: 'oss', provenance: 'local OSS model via LiteLLM' },
  'ollama/codestral:22b': { family: 'oss', provenance: 'local OSS model via LiteLLM' },
  'local-codex-family-reviewer': { family: 'codex', provenance: 'local model via LiteLLM' },
  'local-claude-family-reviewer': { family: 'claude', provenance: 'local model via LiteLLM' },
});

function normalizeLabelNames(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => {
      if (typeof label === 'string') return label;
      if (label && typeof label.name === 'string') return label.name;
      return '';
    })
    .map((label) => label.trim().toLowerCase())
    .filter(Boolean);
}

function hasLocalReviewShadowLabel(labels) {
  return normalizeLabelNames(labels).includes(LOCAL_REVIEW_SHADOW_LABEL);
}

function normalizeFamilyToken(value) {
  const token = String(value || '').trim().toLowerCase();
  if (token === 'claude-code' || token === 'anthropic') return 'claude';
  if (token === 'clio-agent') return 'codex';
  return token || null;
}

function resolveBuilderFamily(builderTag) {
  const normalized = String(builderTag || '').trim().toLowerCase();
  return normalizeFamilyToken(BUILDER_FAMILY_BY_TAG[normalized] || normalized);
}

function resolveHostedReviewerFamily(reviewerModel) {
  const normalized = String(reviewerModel || '').trim().toLowerCase();
  return normalizeFamilyToken(REVIEWER_FAMILY_BY_MODEL[normalized] || normalized);
}

function resolveLocalReviewShadowModel(env = process.env) {
  const model = String(
    env.ADVERSARIAL_LOCAL_REVIEW_SHADOW_MODEL ||
    env.LOCAL_REVIEW_SHADOW_MODEL ||
    ''
  ).trim();
  if (!model) return null;
  const metadata = LOCAL_REVIEW_SHADOW_MODEL_METADATA[model] || null;
  return {
    model,
    family: normalizeFamilyToken(metadata?.family),
    provenance: metadata?.provenance || null,
    metadataFound: Boolean(metadata),
  };
}

function evaluateLocalReviewShadowEligibility({
  labels = [],
  builderTag = null,
  hostedReviewerModel = null,
  env = process.env,
} = {}) {
  if (!hasLocalReviewShadowLabel(labels)) {
    return { eligible: false, reason: 'label-absent' };
  }
  const localModel = resolveLocalReviewShadowModel(env);
  if (!localModel) {
    return { eligible: false, reason: 'local-shadow-model-unconfigured' };
  }
  if (!localModel.metadataFound || !localModel.family) {
    return {
      eligible: false,
      reason: 'local-shadow-family-unproven',
      localModel: localModel.model,
    };
  }
  const builderFamily = resolveBuilderFamily(builderTag);
  const hostedReviewerFamily = resolveHostedReviewerFamily(hostedReviewerModel);
  if (!builderFamily) {
    return {
      eligible: false,
      reason: 'builder-family-unproven',
      localModel: localModel.model,
      localFamily: localModel.family,
    };
  }
  if (!hostedReviewerFamily) {
    return {
      eligible: false,
      reason: 'hosted-reviewer-family-unproven',
      localModel: localModel.model,
      localFamily: localModel.family,
      builderFamily,
    };
  }
  if (localModel.family === builderFamily || localModel.family === hostedReviewerFamily) {
    return {
      eligible: false,
      reason: 'local-shadow-family-not-distinct',
      localModel: localModel.model,
      localFamily: localModel.family,
      builderFamily,
      hostedReviewerFamily,
    };
  }
  return {
    eligible: true,
    reason: 'eligible',
    localModel: localModel.model,
    localFamily: localModel.family,
    localProvenance: localModel.provenance,
    builderFamily,
    hostedReviewerFamily,
  };
}

function localReviewShadowRoot(rootDir = ROOT) {
  return join(rootDir, 'data', 'local-review-shadow');
}

function localReviewShadowKey({ repo, prNumber, headSha, label = LOCAL_REVIEW_SHADOW_LABEL }) {
  const safeRepo = String(repo || '').replace(/[^A-Za-z0-9_.-]+/g, '_');
  const safeSha = String(headSha || 'unknown-head').replace(/[^A-Za-z0-9_.-]+/g, '_');
  const safeLabel = String(label || LOCAL_REVIEW_SHADOW_LABEL).replace(/[^A-Za-z0-9_.-]+/g, '_');
  return `${safeRepo}__pr-${Number(prNumber)}__${safeSha}__${safeLabel}`;
}

function localReviewShadowPaths(rootDir, request) {
  const key = localReviewShadowKey(request);
  const root = localReviewShadowRoot(rootDir);
  return {
    key,
    requestPath: join(root, 'requests', `${key}.json`),
    artifactPath: join(root, 'artifacts', `${key}.md`),
    inputPath: join(root, 'inputs', `${key}.json`),
  };
}

function readJsonFileSafe(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function writeLocalReviewShadowRequest(rootDir, request, { now = new Date().toISOString() } = {}) {
  const paths = localReviewShadowPaths(rootDir, request);
  const existing = readJsonFileSafe(paths.requestPath);
  const status = existing?.status === 'completed' ? 'completed' : (request.status || existing?.status || 'pending');
  const inputPath = request.inputPath || existing?.inputPath || (status === 'pending' || status === 'retryable' || status === 'completed'
    ? paths.inputPath
    : undefined);
  const hasRequestField = (field) => Object.prototype.hasOwnProperty.call(request, field);
  const next = {
    ...(existing || {}),
    type: 'local-review-shadow-request',
    version: 1,
    repo: request.repo,
    prNumber: Number(request.prNumber),
    headSha: request.headSha || null,
    label: request.label || LOCAL_REVIEW_SHADOW_LABEL,
    builderTag: request.builderTag || null,
    hostedReviewerModel: request.hostedReviewerModel || null,
    hostedPostedAt: request.hostedPostedAt || null,
    status,
    artifactPath: existing?.artifactPath || paths.artifactPath,
    ...(inputPath ? { inputPath } : {}),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastError: hasRequestField('lastError') ? request.lastError : (existing?.lastError ?? null),
    eligibility: request.eligibility || existing?.eligibility || null,
    attemptCount: Number.isFinite(Number(request.attemptCount))
      ? Number(request.attemptCount)
      : Number(existing?.attemptCount || 0),
    nextAttemptAt: hasRequestField('nextAttemptAt') ? request.nextAttemptAt : (existing?.nextAttemptAt ?? null),
  };
  writeFileAtomic(paths.requestPath, `${JSON.stringify(next, null, 2)}\n`, { mode: LOCAL_REVIEW_SHADOW_FILE_MODE });
  return { request: next, ...paths };
}

function writeLocalReviewShadowInput(rootDir, request, {
  diff = '',
  hostedReviewBody = '',
  now = new Date().toISOString(),
} = {}) {
  const paths = localReviewShadowPaths(rootDir, request);
  writeFileAtomic(paths.inputPath, `${JSON.stringify({
    type: 'local-review-shadow-input',
    version: 1,
    repo: request.repo,
    prNumber: Number(request.prNumber),
    headSha: request.headSha || null,
    label: request.label || LOCAL_REVIEW_SHADOW_LABEL,
    diff,
    hostedReviewBody,
    createdAt: now,
  }, null, 2)}\n`, { mode: LOCAL_REVIEW_SHADOW_FILE_MODE });
  return paths.inputPath;
}

function recordLocalReviewShadowSkip(rootDir, request, reason, { log = console } = {}) {
  const result = writeLocalReviewShadowRequest(rootDir, {
    ...request,
    status: 'skipped',
    lastError: reason,
  });
  log.warn?.(
    JSON.stringify({
      event: 'local-review-shadow',
      action: 'skip',
      repo: request.repo,
      prNumber: Number(request.prNumber),
      headSha: request.headSha || null,
      reason,
    })
  );
  return { skipped: true, reason, requestPath: result.requestPath };
}

function buildLocalReviewShadowPrompt({ diff, hostedReviewBody, request }) {
  return [
    'You are a local OSS model producing a non-gating shadow code review artifact.',
    'Do not claim to be the hosted adversarial reviewer. Do not issue or imply a merge-blocking verdict.',
    'Focus on concrete bugs, regressions, tests, and security issues in the PR diff.',
    '',
    `Repository: ${request.repo}`,
    `PR: #${request.prNumber}`,
    `Head SHA: ${request.headSha || 'unknown'}`,
    '',
    'Hosted review already posted:',
    hostedReviewBody || '(hosted review body unavailable to shadow worker)',
    '',
    'PR diff:',
    '```diff',
    diff || '',
    '```',
  ].join('\n');
}

function formatLocalReviewShadowArtifact({ request, eligibility, reviewText, completedAt }) {
  return [
    '# Local Review Shadow (Non-Gating)',
    '',
    'Provenance: generated by a local OSS model through LiteLLM.',
    'Gate: non-gating artifact only. The hosted adversarial reviewer remains the merge-blocking verdict.',
    '',
    `Repo: ${request.repo}`,
    `PR: #${request.prNumber}`,
    `Head SHA: ${request.headSha || 'unknown'}`,
    `Label: ${request.label || LOCAL_REVIEW_SHADOW_LABEL}`,
    `Local model: ${eligibility.localModel}`,
    `Local model family: ${eligibility.localFamily}`,
    `Hosted reviewer model: ${request.hostedReviewerModel || 'unknown'}`,
    `Completed at: ${completedAt}`,
    '',
    '## Local Model Output',
    '',
    reviewText.trim(),
    '',
  ].join('\n');
}

function resolveLocalReviewShadowTimeoutMs(env = process.env) {
  const parsed = Number.parseInt(
    env.ADVERSARIAL_LOCAL_REVIEW_SHADOW_TIMEOUT_MS || env.LOCAL_REVIEW_SHADOW_TIMEOUT_MS || '',
    10
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LOCAL_REVIEW_SHADOW_TIMEOUT_MS;
}

function resolveLocalReviewShadowUrl(env = process.env) {
  return String(
    env.ADVERSARIAL_LOCAL_REVIEW_SHADOW_URL ||
    env.LOCAL_REVIEW_SHADOW_URL ||
    DEFAULT_LOCAL_REVIEW_SHADOW_URL
  ).trim();
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase();
  if (normalized === 'localhost' || normalized === '::1' || normalized === '[::1]') return true;
  const ipv4 = normalized.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ipv4) return false;
  return ipv4.slice(1).every((part) => Number(part) >= 0 && Number(part) <= 255) && Number(ipv4[1]) === 127;
}

function assertLocalReviewShadowUrlAllowed(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('local review shadow LiteLLM URL is invalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('local review shadow LiteLLM URL must use http or https');
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new Error('local review shadow LiteLLM URL must target a loopback host');
  }
  return parsed.toString();
}

async function runLocalReviewShadowViaLiteLLM({
  prompt,
  model,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch unavailable for local review shadow LiteLLM call');
  }
  const url = assertLocalReviewShadowUrlAllowed(resolveLocalReviewShadowUrl(env));
  const controller = new AbortController();
  const timeoutMs = resolveLocalReviewShadowTimeoutMs(env);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const apiKey = String(env.ADVERSARIAL_LOCAL_REVIEW_SHADOW_API_KEY || env.LOCAL_REVIEW_SHADOW_API_KEY || env.LITELLM_API_KEY || '').trim();
    const response = await fetchImpl(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      }),
    });
    if (!response.ok) {
      throw new Error(`LiteLLM local shadow request failed with HTTP ${response.status}`);
    }
    const json = await response.json();
    const text = json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || '';
    if (!String(text).trim()) {
      throw new Error('LiteLLM local shadow returned empty output');
    }
    return String(text);
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`LiteLLM local shadow timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function reconcileLocalReviewShadowRequest({
  rootDir = ROOT,
  repo,
  prNumber,
  headSha,
  labels = [],
  builderTag = null,
  hostedReviewerModel = null,
  hostedPostedAt = null,
  diff = '',
  hostedReviewBody = '',
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console,
} = {}) {
  const baseRequest = {
    repo,
    prNumber: Number(prNumber),
    headSha: headSha || null,
    label: LOCAL_REVIEW_SHADOW_LABEL,
    builderTag,
    hostedReviewerModel,
    hostedPostedAt,
  };
  if (!hasLocalReviewShadowLabel(labels)) {
    return { action: 'unchanged', reason: 'label-absent' };
  }
  const eligibility = evaluateLocalReviewShadowEligibility({
    labels,
    builderTag,
    hostedReviewerModel,
    env,
  });
  if (!eligibility.eligible) {
    return recordLocalReviewShadowSkip(rootDir, {
      ...baseRequest,
      eligibility,
    }, eligibility.reason, { log });
  }

  const persisted = writeLocalReviewShadowRequest(rootDir, {
    ...baseRequest,
    status: 'pending',
    eligibility,
  });
  const current = readJsonFileSafe(persisted.requestPath) || persisted.request;
  if (current.status === 'completed' && existsSync(current.artifactPath || persisted.artifactPath)) {
    return { action: 'unchanged', reason: 'already-completed', requestPath: persisted.requestPath, artifactPath: current.artifactPath };
  }

  log.log?.(
    JSON.stringify({
      event: 'local-review-shadow',
      action: 'start',
      repo,
      prNumber: Number(prNumber),
      headSha: headSha || null,
      localModel: eligibility.localModel,
    })
  );
  try {
    const input = readJsonFileSafe(current.inputPath || persisted.inputPath) || {};
    const prompt = buildLocalReviewShadowPrompt({
      diff: diff || input.diff || '',
      hostedReviewBody: hostedReviewBody || input.hostedReviewBody || '',
      request: baseRequest,
    });
    const reviewText = await runLocalReviewShadowViaLiteLLM({
      prompt,
      model: eligibility.localModel,
      env,
      fetchImpl,
    });
    const completedAt = new Date().toISOString();
    const artifact = formatLocalReviewShadowArtifact({
      request: baseRequest,
      eligibility,
      reviewText,
      completedAt,
    });
    writeFileAtomic(persisted.artifactPath, artifact, { mode: LOCAL_REVIEW_SHADOW_FILE_MODE });
    const completed = writeLocalReviewShadowRequest(rootDir, {
      ...baseRequest,
      status: 'completed',
      eligibility,
      lastError: null,
      attemptCount: Number(current.attemptCount || 0),
      nextAttemptAt: null,
    }, { now: completedAt });
    log.log?.(
      JSON.stringify({
        event: 'local-review-shadow',
        action: 'completed',
        repo,
        prNumber: Number(prNumber),
        headSha: headSha || null,
        artifactPath: persisted.artifactPath,
      })
    );
    return { action: 'completed', requestPath: completed.requestPath, artifactPath: persisted.artifactPath };
  } catch (err) {
    const detail = err?.message || String(err);
    const now = new Date();
    const attemptCount = Number(current.attemptCount || 0) + 1;
    const nextAttemptAt = new Date(now.getTime() + LOCAL_REVIEW_SHADOW_RETRY_BACKOFF_MS).toISOString();
    const failed = writeLocalReviewShadowRequest(rootDir, {
      ...baseRequest,
      status: 'retryable',
      eligibility,
      lastError: detail,
      attemptCount,
      nextAttemptAt,
    });
    log.warn?.(
      JSON.stringify({
        event: 'local-review-shadow',
        action: 'retryable',
        repo,
        prNumber: Number(prNumber),
        headSha: headSha || null,
        reason: detail,
        nextAttemptAt,
      })
    );
    return { action: 'retryable', reason: detail, requestPath: failed.requestPath, artifactPath: persisted.artifactPath, nextAttemptAt };
  }
}

function localReviewShadowDueState(rootDir, request, { nowMs = Date.now() } = {}) {
  const paths = localReviewShadowPaths(rootDir, request);
  const existing = readJsonFileSafe(paths.requestPath);
  if (!existing) return { due: true, reason: 'missing-request', paths, request: null };
  if (existing.status === 'completed' && existsSync(existing.artifactPath || paths.artifactPath)) {
    return { due: false, reason: 'already-completed', paths, request: existing };
  }
  if (existing.status === 'skipped') {
    return { due: false, reason: 'skipped', paths, request: existing };
  }
  if (existing.status === 'retryable' && existing.nextAttemptAt) {
    const dueAtMs = Date.parse(existing.nextAttemptAt);
    if (Number.isFinite(dueAtMs) && dueAtMs > nowMs) {
      return {
        due: false,
        reason: 'retry-backoff',
        nextAttemptAt: existing.nextAttemptAt,
        paths,
        request: existing,
      };
    }
  }
  return { due: true, reason: existing.status || 'pending', paths, request: existing };
}

function startLocalReviewShadowReconciliation({
  rootDir = ROOT,
  repo,
  prNumber,
  headSha,
  labels = [],
  builderTag = null,
  hostedReviewerModel = null,
  hostedPostedAt = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console,
  nowMs = Date.now(),
} = {}) {
  const baseRequest = {
    repo,
    prNumber: Number(prNumber),
    headSha: headSha || null,
    label: LOCAL_REVIEW_SHADOW_LABEL,
  };
  if (!hasLocalReviewShadowLabel(labels)) {
    return { action: 'unchanged', reason: 'label-absent' };
  }
  const dueState = localReviewShadowDueState(rootDir, baseRequest, { nowMs });
  if (!dueState.due) {
    return {
      action: 'deferred',
      reason: dueState.reason,
      requestPath: dueState.paths.requestPath,
      nextAttemptAt: dueState.nextAttemptAt || null,
    };
  }
  if (activeLocalReviewShadowReconciliations.has(dueState.paths.key)) {
    return { action: 'deferred', reason: 'already-running', requestPath: dueState.paths.requestPath };
  }
  activeLocalReviewShadowReconciliations.add(dueState.paths.key);
  Promise.resolve()
    .then(() => reconcileLocalReviewShadowRequest({
      rootDir,
      repo,
      prNumber,
      headSha,
      labels,
      builderTag,
      hostedReviewerModel,
      hostedPostedAt,
      env,
      fetchImpl,
      log,
    }))
    .catch((err) => {
      log.warn?.(
        `[reviewer] local-review-shadow background reconciliation warning for ${repo}#${prNumber}: ${err?.message || err}`
      );
    })
    .finally(() => {
      activeLocalReviewShadowReconciliations.delete(dueState.paths.key);
    });
  return { action: 'started', requestPath: dueState.paths.requestPath };
}

function recordLocalReviewShadowRequestAfterHostedPost({
  rootDir = ROOT,
  repo,
  prNumber,
  headSha,
  labels = [],
  builderTag = null,
  hostedReviewerModel = null,
  hostedPostedAt = new Date().toISOString(),
  diff = '',
  hostedReviewBody = '',
  env = process.env,
  log = console,
} = {}) {
  if (!hasLocalReviewShadowLabel(labels)) {
    return { recorded: false, reason: 'label-absent' };
  }
  const eligibility = evaluateLocalReviewShadowEligibility({
    labels,
    builderTag,
    hostedReviewerModel,
    env,
  });
  const request = {
    repo,
    prNumber: Number(prNumber),
    headSha: headSha || null,
    label: LOCAL_REVIEW_SHADOW_LABEL,
    builderTag,
    hostedReviewerModel,
    hostedPostedAt,
    status: eligibility.eligible ? 'pending' : 'skipped',
    lastError: eligibility.eligible ? null : eligibility.reason,
    eligibility,
  };
  if (!eligibility.eligible) {
    const skipped = recordLocalReviewShadowSkip(rootDir, request, eligibility.reason, { log });
    return {
      recorded: true,
      eligible: false,
      reason: eligibility.reason,
      requestPath: skipped.requestPath,
    };
  }
  request.inputPath = writeLocalReviewShadowInput(rootDir, request, {
    diff,
    hostedReviewBody,
    now: hostedPostedAt,
  });
  const persisted = writeLocalReviewShadowRequest(rootDir, request, { now: hostedPostedAt });
  log.log?.(
    JSON.stringify({
      event: 'local-review-shadow',
      action: eligibility.eligible ? 'request-recorded' : 'request-skipped',
      repo,
      prNumber: Number(prNumber),
      headSha: headSha || null,
      reason: eligibility.reason,
      requestPath: persisted.requestPath,
    })
  );
  return {
    recorded: true,
    eligible: eligibility.eligible,
    reason: eligibility.reason,
    requestPath: persisted.requestPath,
    artifactPath: persisted.artifactPath,
  };
}

export {
  LOCAL_REVIEW_SHADOW_LABEL,
  LOCAL_REVIEW_SHADOW_MODEL_METADATA,
  assertLocalReviewShadowUrlAllowed,
  evaluateLocalReviewShadowEligibility,
  formatLocalReviewShadowArtifact,
  localReviewShadowPaths,
  recordLocalReviewShadowRequestAfterHostedPost,
  reconcileLocalReviewShadowRequest,
  resolveLocalReviewShadowModel,
  resolveLocalReviewShadowUrl,
  runLocalReviewShadowViaLiteLLM,
  startLocalReviewShadowReconciliation,
};

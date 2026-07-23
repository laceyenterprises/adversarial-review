/**
 * LAC-12 + LAC-13: Reviewer Agent + Linear Integration
 *
 * One-shot: fetch PR diff → adversarial review → post GitHub comment → update Linear.
 *
 * Called by watcher.mjs as a child process:
 *   node src/reviewer.mjs '<JSON args>'
 *
 * Args JSON shape:
 *   { repo, prNumber, reviewerModel, botTokenEnv, linearTicketId, reviewerSessionUuid }
 *
 * ── Auth Policy (NON-NEGOTIABLE) ────────────────────────────────────────────
 * Claude reviews MUST use OAuth (claude CLI), never ANTHROPIC_API_KEY.
 * Codex reviews MUST use OAuth (codex CLI), never OPENAI_API_KEY.
 * If OAuth credentials are missing or expired → STOP and alert Paul via Clio.
 * API key fallback is intentionally NOT implemented here. On Darwin,
 * Claude is launched via `launchctl asuser`, so the wrapped command also
 * explicitly unsets API-key env vars inside the target process.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { execFile } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { apiStatusFromError, recordApiCall } from './api-telemetry.mjs';
import { awaitThrottleIfNeeded } from './rate-limit-throttle.mjs';
import { resolveGitHubAppBotLogin } from './github-app-identity.mjs';
import { getCachedDiff, putCachedDiff } from './diff-cache.mjs';
import {
  createFollowUpJob,
  resolveRoundBudgetForJob,
  summarizePRRemediationLedger,
} from './follow-up-jobs.mjs';
import { buildObviousDocsGuidance, fetchLinkedSpecContents } from './prompt-context.mjs';
import { buildHardeningReviewContext } from './hardening-ledger-context.mjs';
import { captureReviewerBodyAfterPost, findCapturedReviewerBody } from './review-body-capture.mjs';
import { emitReviewedAttestation } from './reviewed-attestation.mjs';
import { resolveReviewerAppToken } from './reviewer-broker-refresh.mjs';
import { preflightGeminiReviewerToken } from './gemini-reviewer-preflight.mjs';
import { clearPendingReviewsForSelf } from './reviewer-pre-write.mjs';
import {
  openReviewerFence,
  resolveAdversarialReviewStateDir,
  resolveSigtermFenceGraceSeconds,
} from './reviewer-fence.mjs';
import { resolveReviewerTimeoutMs } from './reviewer-timeout.mjs';
import { normalizeEffectiveReviewVerdict, sanitizeCodexReviewPayload } from './kernel/verdict.mjs';
import { pickReviewerStage } from './kernel/prompt-stage.mjs';
import { createLinearTriageAdapter } from './adapters/operator/linear-triage/index.mjs';
import { getConfig } from './config-loader.mjs';
import { parseCodexJsonTokenUsage } from './reviewer-model-detection.mjs';
import {
  fetchPullRequestHeadAndState,
  fetchPullRequestReviewContext,
} from './github-api.mjs';
import {
  resolveHandoffConfig,
  signalFollowUpDaemonWake,
} from './handoff-wake.mjs';
import {
  adapterUnsupportedError,
  writeAdapterPullRequestReview,
} from './github-adapter-client.mjs';
import { GH_LOOKUP_TIMEOUT_MS, execGhWithRetry } from './gh-cli.mjs';
import { fetchLatestLabelEvent } from './github-label-events.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import {
  appendScopeViolationFinding,
  resolveAdditiveOnlyScopeReview,
  reviewBodyHasScopeViolationFinding,
} from './additive-only-scope.mjs';
import { resolveGeminiRuntime } from './role-config.mjs';
import {
  REVIEW_POST_RETRY_DELAYS_MS,
  WAKE_HOOK_RETRY_DELAYS_MS,
  REVIEW_FAMILY_BY_BUILDER_CLASS,
  normalizeBuilderTag,
  parseDiffFiles,
  buildGhErrorDetail,
} from './reviewer-util.mjs';
import {
  dispatchReviewerModel,
  reviewAgyOversizedInChunks,
  resolveAgyOversizedReviewRoute,
  resolveGeminiRuntimeForReview,
  resolveReviewerMetadata,
  estimateTokensFromText,
  execFileWithTransientRetry,
  previewText,
  CLAUDE_CLI,
  CODEX_CLI,
  GEMINI_CLI,
  AGY_CLI,
  assertClaudeOAuth,
  assertCodexOAuth,
  spawnCaptured,
  __test__ as harnessTest,
} from './reviewer-harness.mjs';
import {
  REVIEWER_DOMAIN_ID,
  REVIEWER_PROMPT_SET,
  ADVERSARIAL_PROMPT,
  ADVERSARIAL_PROMPT_FINAL_ROUND_ADDENDUM,
  buildReviewerPromptPrefix,
  buildReviewerPrompt,
  buildPromptForReviewerModel,
  buildAgyReviewerPromptPrefix,
  isFinalReviewRound,
} from './reviewer-prompt.mjs';

const REVIEW_ADAPTER_ENV_KEYS = [
  'USER',
  'LOGNAME',
  'TMPDIR',
  'GH_CONFIG_DIR',
  'GH_HOST',
  'GITHUB_HOST',
  'LANG',
  'LC_ALL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE_BUNDLE',
  'GHA_ADAPTER_BIN',
  'AGENT_OS_GITHUB_ADAPTER_BIN',
];

const execFileAsync = promisify(execFile);
const ADVISORY_ONLY_REVIEW_LABEL = 'operator-approved: advisory-only-review';
const VERDICT_MODE_ENFORCE = 'enforce';
const VERDICT_MODE_ADVISORY_ONLY = 'advisory-only';
const ENFORCE_REVIEW_HEADER_RE = /^## Adversarial Review — .+ \(.+\)$/;
const ADVISORY_ONLY_REVIEW_HEADER_RE = /^## Adversarial Review \(advisory-only\) — .+ \(.+\)$/;
const ANY_ADVERSARIAL_REVIEW_HEADER_RE = /^##\s+Adversarial Review\b.*$/;

const REVIEWER_IDENTITY_BY_BOT_TOKEN_ENV = Object.freeze({
  GH_CLAUDE_REVIEWER_TOKEN: 'claude-reviewer-lacey',
  GH_CODEX_REVIEWER_TOKEN: 'codex-reviewer-lacey',
  GH_GEMINI_REVIEWER_TOKEN: 'gemini-reviewer-lacey',
});

function resolveReviewerIdentityForBotTokenEnv(botTokenEnv, fallbackIdentity = null) {
  return REVIEWER_IDENTITY_BY_BOT_TOKEN_ENV[botTokenEnv] || fallbackIdentity || botTokenEnv;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Local OSS shadow review (opt-in, non-gating) ────────────────────────────

const LOCAL_REVIEW_SHADOW_LABEL = 'run-local-review-shadow';
const LOCAL_REVIEW_SHADOW_DEFAULT_MODEL = '';
const LOCAL_REVIEW_SHADOW_DEFAULT_BASE_URL = 'http://127.0.0.1:4000';
const LOCAL_REVIEW_SHADOW_DEFAULT_TIMEOUT_MS = 120_000;

// Module-local explicit model-family metadata. Do not promote this to shared
// Agent OS CFG from this adversarial-review-only ticket.
const LOCAL_REVIEW_SHADOW_MODEL_FAMILY_BY_MODEL = Object.freeze({
  'litellm-local/qwen3-coder': 'qwen',
  'litellm-local/qwen2.5-coder': 'qwen',
  'litellm-local/gpt-oss-120b': 'openai-oss',
  'litellm-local/gpt-oss-20b': 'openai-oss',
  'openai/gpt-oss-120b': 'openai-oss',
  'openai/gpt-oss-20b': 'openai-oss',
});

const REVIEW_FAMILY_BY_REVIEWER_MODEL = Object.freeze({
  claude: 'claude',
  'claude-code': 'claude',
  codex: 'codex',
  gemini: 'gemini',
});

function logStructuredEvent(log = console, event) {
  const payload = {
    ts: new Date().toISOString(),
    ...event,
  };
  const line = JSON.stringify(payload);
  if (event?.level === 'warning') log.warn?.(line);
  else if (event?.level === 'error') log.error?.(line);
  else log.log?.(line);
}

function normalizeLabelName(label) {
  if (typeof label === 'string') return label.trim().toLowerCase();
  return String(label?.name || '').trim().toLowerCase();
}

function hasLabel(labels, labelName) {
  const expected = String(labelName || '').trim().toLowerCase();
  return Boolean(expected) && Array.isArray(labels)
    && labels.some((label) => normalizeLabelName(label) === expected);
}

function hasLocalReviewShadowLabel(labels) {
  return hasLabel(labels, LOCAL_REVIEW_SHADOW_LABEL);
}

function normalizeVerdictMode(mode) {
  return String(mode || '').trim() === VERDICT_MODE_ADVISORY_ONLY
    ? VERDICT_MODE_ADVISORY_ONLY
    : VERDICT_MODE_ENFORCE;
}

function resolveVerdictModeForHead({
  labels = [],
  currentHeadSha = null,
  reviewerHeadSha = null,
  advisoryLabelEvent = null,
  prAuthor = null,
} = {}) {
  const sameHead = (
    reviewerHeadSha &&
    currentHeadSha &&
    String(reviewerHeadSha) === String(currentHeadSha)
  );
  const actor = String(advisoryLabelEvent?.actor || '').trim();
  const author = String(prAuthor || '').trim();
  const hasEventId = Boolean(advisoryLabelEvent?.id || advisoryLabelEvent?.nodeId);
  const labelHeadMatches = String(advisoryLabelEvent?.headSha || '') === String(currentHeadSha || '');
  const nonAuthorActor = Boolean(actor) &&
    actor.toLowerCase() !== 'unknown' &&
    Boolean(author) &&
    actor.toLowerCase() !== author.toLowerCase();

  if (
    sameHead &&
    hasLabel(labels, ADVISORY_ONLY_REVIEW_LABEL) &&
    labelHeadMatches &&
    nonAuthorActor &&
    hasEventId &&
    advisoryLabelEvent?.createdAt
  ) {
    return VERDICT_MODE_ADVISORY_ONLY;
  }
  return VERDICT_MODE_ENFORCE;
}

async function fetchCurrentHeadVerdictMode({
  repo,
  prNumber,
  reviewerHeadSha = null,
  fetchPullRequestHeadAndStateImpl = fetchPullRequestHeadAndState,
  fetchLatestLabelEventImpl = fetchLatestLabelEvent,
  execFileImpl = execFileAsync,
  recordApiCallImpl = recordApiCall,
  log = console,
} = {}) {
  try {
    const current = await fetchPullRequestHeadAndStateImpl(repo, prNumber, {
      execFileImpl,
      recordApiCallImpl,
      withLabels: true,
    });
    const labels = current?.labels || [];
    const currentHeadSha = current?.headRefOid || null;
    // Normalize defensively: only a non-empty string author login is a confirmed
    // author. A malformed/loginless author object (e.g. `{}`) must resolve to null
    // so the non-author gate fails closed to enforce instead of comparing against
    // the stringified object `"[object Object]"`.
    const authorLogin = typeof current?.author === 'string'
      ? current.author
      : current?.author?.login;
    const prAuthor = (typeof authorLogin === 'string' && authorLogin.trim())
      ? authorLogin
      : null;
    const needsAdvisoryEvent = (
      reviewerHeadSha &&
      currentHeadSha &&
      String(reviewerHeadSha) === String(currentHeadSha) &&
      hasLabel(labels, ADVISORY_ONLY_REVIEW_LABEL)
    );
    const advisoryLabelEvent = needsAdvisoryEvent && typeof fetchLatestLabelEventImpl === 'function'
      ? await fetchLatestLabelEventImpl(repo, prNumber, ADVISORY_ONLY_REVIEW_LABEL, {
          execFileImpl,
          currentHeadSha,
        })
      : null;
    const verdictMode = resolveVerdictModeForHead({
      labels,
      currentHeadSha,
      reviewerHeadSha,
      advisoryLabelEvent,
      prAuthor,
    });
    if (needsAdvisoryEvent && verdictMode !== VERDICT_MODE_ADVISORY_ONLY) {
      log.warn?.(
        `[reviewer] WARN: advisory-only label for ${repo}#${prNumber}@${currentHeadSha || '<unknown-head>'} was ignored; missing current-head non-author label event audit fields`
      );
    }
    return {
      verdictMode,
      currentHeadSha,
      labels,
      advisoryLabelEvent,
      source: 'current-pr-head',
    };
  } catch (err) {
    log.warn?.(
      `[reviewer] WARN: failed to resolve advisory-only label for ${repo}#${prNumber}; using enforce mode: ${err?.message || err}`
    );
    return {
      verdictMode: VERDICT_MODE_ENFORCE,
      currentHeadSha: null,
      labels: [],
      source: 'fallback-enforce',
      error: err?.message || String(err),
    };
  }
}

function buildReviewCommentHeader({ reviewerMetadata, verdictMode }) {
  const mode = normalizeVerdictMode(verdictMode);
  if (mode === VERDICT_MODE_ADVISORY_ONLY) {
    // Keep the canonical `## Adversarial Review` marker heading and displayName in
    // advisory mode so the same heuristic used to locate enforce reviews still finds
    // advisory-only reviews; append the advisory disclaimer beneath it.
    return `## Adversarial Review (advisory-only) — ${reviewerMetadata.displayName} (${reviewerMetadata.reviewerIdentity})\n\n` +
      `**Advisory-only review** — findings below are informational; no automated remediation will run.\n\n`;
  }
  return `## Adversarial Review — ${reviewerMetadata.displayName} (${reviewerMetadata.reviewerIdentity})\n\n`;
}

function classifyReviewCommentHeader(reviewBody) {
  const [firstLine = ''] = String(reviewBody || '').split(/\r?\n/, 1);
  if (ADVISORY_ONLY_REVIEW_HEADER_RE.test(firstLine)) {
    return {
      isAdversarialReview: true,
      verdictMode: VERDICT_MODE_ADVISORY_ONLY,
      advisoryOnly: true,
    };
  }
  if (ENFORCE_REVIEW_HEADER_RE.test(firstLine)) {
    return {
      isAdversarialReview: true,
      verdictMode: VERDICT_MODE_ENFORCE,
      advisoryOnly: false,
    };
  }
  return {
    isAdversarialReview: false,
    verdictMode: null,
    advisoryOnly: false,
  };
}

function startsWithReviewCommentHeader(reviewBody) {
  const [firstLine = ''] = String(reviewBody || '').trimStart().split(/\r?\n/, 1);
  return ANY_ADVERSARIAL_REVIEW_HEADER_RE.test(firstLine.trim());
}

function insertAfterExistingReviewHeader(reviewBody, insertText) {
  const text = String(reviewBody || '').trimStart();
  const block = String(insertText || '');
  if (!block) return text;

  const lineBreakMatch = text.match(/\r?\n/);
  if (!lineBreakMatch) {
    return `${text}\n\n${block}`;
  }

  const headerLine = text.slice(0, lineBreakMatch.index);
  const rest = text
    .slice(lineBreakMatch.index + lineBreakMatch[0].length)
    .replace(/^(?:[ \t]*\r?\n)+/, '');
  return `${headerLine}\n\n${block}${rest}`;
}

function buildReviewCommentBody({
  reviewerMetadata,
  verdictMode,
  waiverAuditBlock = '',
  reviewText,
}) {
  const text = String(reviewText || '');
  if (startsWithReviewCommentHeader(text)) {
    return insertAfterExistingReviewHeader(text, waiverAuditBlock);
  }

  const header = buildReviewCommentHeader({ reviewerMetadata, verdictMode });
  return header + String(waiverAuditBlock || '') + text;
}

function normalizeReviewerFamily(reviewerModel) {
  const key = String(reviewerModel || '').trim().toLowerCase();
  return REVIEW_FAMILY_BY_REVIEWER_MODEL[key] || null;
}

function resolveLocalReviewShadowModel(env = process.env) {
  return String(env.ADVERSARIAL_REVIEW_LOCAL_SHADOW_MODEL || LOCAL_REVIEW_SHADOW_DEFAULT_MODEL).trim();
}

function resolveLocalReviewShadowFamily(model, {
  familyByModel = LOCAL_REVIEW_SHADOW_MODEL_FAMILY_BY_MODEL,
} = {}) {
  const key = String(model || '').trim().toLowerCase();
  return familyByModel[key] || null;
}

function resolveLocalReviewShadowTimeoutMs(env = process.env) {
  const parsed = Number.parseInt(env.ADVERSARIAL_REVIEW_LOCAL_SHADOW_TIMEOUT_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : LOCAL_REVIEW_SHADOW_DEFAULT_TIMEOUT_MS;
}

function evaluateLocalReviewShadowEligibility({
  labels,
  builderTag,
  reviewerModel,
  env = process.env,
  familyByModel = LOCAL_REVIEW_SHADOW_MODEL_FAMILY_BY_MODEL,
} = {}) {
  if (!hasLocalReviewShadowLabel(labels)) {
    return { eligible: false, reason: 'label-absent' };
  }

  const localModel = resolveLocalReviewShadowModel(env);
  const localFamily = resolveLocalReviewShadowFamily(localModel, { familyByModel });
  if (!localModel) {
    return { eligible: false, reason: 'local-model-missing' };
  }
  if (!localFamily) {
    return { eligible: false, reason: 'local-model-family-unproven', localModel };
  }

  const builderClass = normalizeBuilderTag(builderTag);
  const builderFamily = builderClass ? REVIEW_FAMILY_BY_BUILDER_CLASS[builderClass] : null;
  const hostedReviewerFamily = normalizeReviewerFamily(reviewerModel);
  const comparedFamilies = [...new Set([builderFamily, hostedReviewerFamily].filter(Boolean))];
  if (!builderFamily) {
    return { eligible: false, reason: 'builder-family-unproven', localModel, localFamily };
  }
  if (!hostedReviewerFamily) {
    return { eligible: false, reason: 'hosted-reviewer-family-unproven', localModel, localFamily, builderClass };
  }
  if (comparedFamilies.includes(localFamily)) {
    return {
      eligible: false,
      reason: 'local-model-same-family',
      localModel,
      localFamily,
      builderClass,
      builderFamily,
      hostedReviewerFamily,
    };
  }

  return {
    eligible: true,
    label: LOCAL_REVIEW_SHADOW_LABEL,
    localModel,
    localFamily,
    builderClass,
    builderFamily,
    hostedReviewerFamily,
  };
}

function safePathPart(value) {
  return String(value || 'unknown')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'unknown';
}

function localReviewShadowKey({ repo, prNumber, headSha, label = LOCAL_REVIEW_SHADOW_LABEL }) {
  return [
    safePathPart(repo).replaceAll('/', '__'),
    `pr-${safePathPart(prNumber)}`,
    safePathPart(headSha || 'unknown-head'),
    safePathPart(label),
  ].join('__');
}

function localReviewShadowDir(rootDir = ROOT) {
  return join(rootDir, 'data', 'local-review-shadow');
}

function localReviewShadowPaths(rootDir, request) {
  const key = localReviewShadowKey({
    repo: request?.repo,
    prNumber: request?.prNumber,
    headSha: request?.headSha,
    label: request?.label || LOCAL_REVIEW_SHADOW_LABEL,
  });
  const dir = localReviewShadowDir(rootDir);
  return {
    dir,
    key,
    requestPath: join(dir, 'requests', `${key}.json`),
    artifactPath: join(dir, 'artifacts', `${key}.md`),
    statePath: join(dir, 'states', `${key}.json`),
  };
}

function readJsonFileIfExists(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function ensureLocalReviewShadowWritable(paths, targets = ['requestPath', 'artifactPath', 'statePath']) {
  for (const key of targets) {
    const dir = dirname(paths[key]);
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
  }
}

function persistLocalReviewShadowRequest({
  rootDir = ROOT,
  repo,
  prNumber,
  headSha,
  builderTag,
  reviewerModel,
  hostedReviewerIdentity = null,
  eligibility,
  requestedAt = new Date().toISOString(),
  writeFileAtomicImpl = writeFileAtomic,
  ensureWritableImpl = ensureLocalReviewShadowWritable,
} = {}) {
  if (!eligibility?.eligible) {
    return { persisted: false, reason: eligibility?.reason || 'not-eligible' };
  }
  const request = {
    schemaVersion: 1,
    kind: 'local-review-shadow-request',
    label: LOCAL_REVIEW_SHADOW_LABEL,
    repo,
    prNumber: Number(prNumber),
    headSha: headSha || null,
    builderTag: builderTag || null,
    reviewerModel,
    hostedReviewerIdentity,
    localModel: eligibility.localModel,
    localFamily: eligibility.localFamily,
    builderFamily: eligibility.builderFamily,
    hostedReviewerFamily: eligibility.hostedReviewerFamily,
    status: 'requested',
    requestedAt,
    hostedPostedAt: null,
  };
  const paths = localReviewShadowPaths(rootDir, request);
  ensureWritableImpl(paths, ['requestPath']);
  const existing = readJsonFileIfExists(paths.requestPath);
  const next = existing
    ? {
        ...existing,
        ...request,
        requestedAt: existing.requestedAt || requestedAt,
        hostedPostedAt: existing.hostedPostedAt || null,
      }
    : request;
  writeFileAtomicImpl(paths.requestPath, `${JSON.stringify(next, null, 2)}\n`);
  return { persisted: true, request: next, ...paths };
}

function markLocalReviewShadowHostedPosted({
  rootDir = ROOT,
  request,
  hostedPostedAt = new Date().toISOString(),
  writeFileAtomicImpl = writeFileAtomic,
  ensureWritableImpl = ensureLocalReviewShadowWritable,
} = {}) {
  if (!request) return { marked: false, reason: 'missing-request' };
  const paths = localReviewShadowPaths(rootDir, request);
  ensureWritableImpl(paths, ['requestPath']);
  const current = readJsonFileIfExists(paths.requestPath) || request;
  const next = {
    ...current,
    status: current.status === 'completed' ? 'completed' : 'hosted-posted',
    hostedPostedAt: current.hostedPostedAt || hostedPostedAt,
  };
  writeFileAtomicImpl(paths.requestPath, `${JSON.stringify(next, null, 2)}\n`);
  return { marked: true, request: next, ...paths };
}

function buildLocalReviewShadowPrompt({ hostedReviewText, diff, extraContext = '' }) {
  return [
    'You are producing a non-gating local OSS model shadow review for an already-posted hosted adversarial review.',
    'Do not claim to be Codex, Claude, Gemini, or the merge-blocking reviewer.',
    'Focus on independently useful findings. If there are no material findings, say so clearly.',
    '',
    'Already-posted hosted review:',
    '```markdown',
    String(hostedReviewText || '').trim(),
    '```',
    '',
    extraContext ? `Additional PR context:\n${extraContext.trim()}\n` : '',
    'PR diff:',
    '```diff',
    String(diff || '').trim(),
    '```',
  ].filter(Boolean).join('\n');
}

function formatAdvisoryFindingsContext(advisoryFindings = []) {
  const findings = (Array.isArray(advisoryFindings) ? advisoryFindings : [])
    .filter((finding) => finding && typeof finding === 'object');
  if (findings.length === 0) return '';
  return [
    '',
    '## Watcher Advisory Findings',
    '',
    'These findings are informational context from the watcher. Do not place them in `## Blocking Issues`, and do not change the verdict solely because of them.',
    '',
    '```json',
    JSON.stringify(findings, null, 2),
    '```',
    '',
  ].join('\n');
}

async function buildReviewerExtraContext({
  repo,
  prNumber,
  prContext = null,
  diff = '',
  advisoryFindings = [],
  repoRoot = join(ROOT, '..', '..'),
  fetchLinkedSpecContentsImpl = fetchLinkedSpecContents,
  buildHardeningReviewContextImpl = buildHardeningReviewContext,
  fetchPRContextImpl = fetchPRContext,
  execFileImpl = execFileAsync,
  log = console,
} = {}) {
  let extraContext = buildObviousDocsGuidance();
  try {
    const linkedContext = await fetchLinkedSpecContentsImpl(repo, prNumber, {
      prContext,
      fetchPRContextImpl,
      execFileImpl,
    });
    if (linkedContext) {
      extraContext = `${linkedContext}${buildObviousDocsGuidance({ repoRootRelative: true, includeSelfContainedHint: true })}`;
      log?.error?.(`[reviewer] DEBUG: fetched linked PR context (${linkedContext.length} bytes)`);
    } else {
      log?.error?.('[reviewer] DEBUG: no linked PR context found; using obvious-docs fallback guidance');
    }
  } catch (err) {
    log?.error?.(`[reviewer] WARN: failed to fetch linked PR context: ${err.message}`);
  }

  const advisoryContext = formatAdvisoryFindingsContext(advisoryFindings);
  if (advisoryContext) {
    extraContext = `${extraContext}${advisoryContext}`;
  }

  try {
    const hardeningContext = await buildHardeningReviewContextImpl(diff, {
      repoRoot,
      logger: log,
    });
    if (hardeningContext) {
      extraContext = `${extraContext}${hardeningContext}`;
      log?.error?.(`[reviewer] DEBUG: added hardening-ledger context (${hardeningContext.length} bytes)`);
    }
  } catch (err) {
    log?.error?.(`[reviewer] WARN: failed to build hardening-ledger review context: ${err.message}`);
  }

  return extraContext;
}

function formatLocalReviewShadowArtifact({ request, reviewText, status = 'completed', reason = null }) {
  const provenance = [
    '# Local OSS Model Shadow Review (Non-Gating)',
    '',
    `Provenance: generated by local OSS model \`${request.localModel}\` via LiteLLM for opt-in label \`${LOCAL_REVIEW_SHADOW_LABEL}\`.`,
    'This artifact is not the hosted adversarial reviewer, not Codex/Claude/Gemini reviewer identity, and not a merge gate verdict.',
    '',
    `Repo/PR: ${request.repo}#${request.prNumber}`,
    `Head SHA: ${request.headSha || 'unknown'}`,
    `Hosted reviewer model: ${request.reviewerModel || 'unknown'}`,
    `Shadow status: ${status}${reason ? ` (${reason})` : ''}`,
    '',
    '---',
    '',
  ].join('\n');
  return `${provenance}${String(reviewText || '').trim()}\n`;
}

class LocalReviewShadowFailure extends Error {
  constructor(message, {
    retryable = true,
    skipReason = null,
    statusCode = null,
    category = null,
  } = {}) {
    super(message);
    this.name = 'LocalReviewShadowFailure';
    this.retryable = retryable;
    this.skipReason = skipReason || message;
    this.statusCode = statusCode;
    this.category = category;
  }
}

function classifyLocalReviewShadowHttpFailure(status) {
  const code = Number(status);
  if (code === 401 || code === 403) {
    return { retryable: false, reason: 'local-shadow-auth-failed', category: 'auth' };
  }
  if (code === 408 || code === 425 || code === 429 || code >= 500) {
    return { retryable: true, reason: 'local-shadow-transient-http', category: 'transient-http' };
  }
  if (code >= 400 && code < 500) {
    return { retryable: false, reason: 'local-shadow-client-or-config-error', category: 'client-or-config' };
  }
  return { retryable: true, reason: 'local-shadow-http-error', category: 'http' };
}

function classifyLocalReviewShadowFailure(err) {
  if (err instanceof LocalReviewShadowFailure) {
    return {
      retryable: Boolean(err.retryable),
      reason: err.message,
      skipReason: err.skipReason || err.message,
      statusCode: err.statusCode || null,
      category: err.category || null,
    };
  }
  if (err?.name === 'AbortError') {
    return {
      retryable: true,
      reason: 'local-review-shadow-timeout',
      skipReason: 'local-shadow-timeout',
      statusCode: null,
      category: 'timeout',
    };
  }
  return {
    retryable: true,
    reason: err?.message || String(err),
    skipReason: err?.message || String(err),
    statusCode: null,
    category: 'transport-or-runtime',
  };
}

function normalizeLocalReviewShadowHostname(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
}

function isLoopbackLocalReviewShadowHostname(hostname) {
  const normalized = normalizeLocalReviewShadowHostname(hostname);
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1';
}

function resolveAllowedLocalReviewShadowBaseUrl(env = process.env) {
  const rawBaseUrl = String(
    env.ADVERSARIAL_REVIEW_LOCAL_SHADOW_BASE_URL || LOCAL_REVIEW_SHADOW_DEFAULT_BASE_URL
  ).trim();
  let parsed;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new LocalReviewShadowFailure(
      'local shadow LiteLLM URL is invalid',
      { retryable: false, skipReason: 'local-shadow-url-invalid', category: 'config' }
    );
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !isLoopbackLocalReviewShadowHostname(parsed.hostname)) {
    throw new LocalReviewShadowFailure(
      'local shadow LiteLLM URL must use HTTP(S) loopback',
      { retryable: false, skipReason: 'local-shadow-url-not-loopback', category: 'config' }
    );
  }
  return parsed.toString().replace(/\/+$/, '');
}

async function callLiteLLMLocalReviewShadow({
  request,
  diff,
  hostedReviewText,
  extraContext = '',
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = resolveLocalReviewShadowTimeoutMs(env),
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch unavailable for LiteLLM local review shadow');
  }
  const baseUrl = resolveAllowedLocalReviewShadowBaseUrl(env);
  const token = env.ADVERSARIAL_REVIEW_LOCAL_SHADOW_API_KEY || env.LITELLM_API_KEY || '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('local-review-shadow-timeout')), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        model: request.localModel,
        messages: [
          {
            role: 'user',
            content: buildLocalReviewShadowPrompt({ hostedReviewText, diff, extraContext }),
          },
        ],
        temperature: 0.1,
      }),
    });
    if (!response?.ok) {
      const classification = classifyLocalReviewShadowHttpFailure(response?.status);
      throw new LocalReviewShadowFailure(
        `LiteLLM local review shadow failed: HTTP ${response?.status || 'unknown'} (${classification.reason})`,
        {
          retryable: classification.retryable,
          skipReason: classification.reason,
          statusCode: response?.status || null,
          category: classification.category,
        }
      );
    }
    let parsed;
    try {
      parsed = await response.json();
    } catch (err) {
      throw new LocalReviewShadowFailure(
        `LiteLLM local review shadow returned invalid JSON: ${err?.message || String(err)}`,
        {
          retryable: false,
          skipReason: 'local-shadow-invalid-response',
          category: 'invalid-response',
        }
      );
    }
    const text = parsed?.choices?.[0]?.message?.content;
    if (!String(text || '').trim()) {
      throw new LocalReviewShadowFailure(
        'LiteLLM local review shadow returned empty output',
        {
          retryable: false,
          skipReason: 'local-shadow-empty-response',
          category: 'invalid-response',
        }
      );
    }
    return String(text).trim();
  } finally {
    clearTimeout(timer);
  }
}

async function completeLocalReviewShadowRequest({
  rootDir = ROOT,
  request,
  diff,
  hostedReviewText,
  extraContext = '',
  fetchImpl = globalThis.fetch,
  env = process.env,
  log = console,
  writeFileAtomicImpl = writeFileAtomic,
  ensureWritableImpl = ensureLocalReviewShadowWritable,
  callLiteLLMImpl = callLiteLLMLocalReviewShadow,
} = {}) {
  if (!request) return { completed: false, reason: 'missing-request' };
  const paths = localReviewShadowPaths(rootDir, request);
  let existingState = null;
  try {
    existingState = readJsonFileIfExists(paths.statePath);
  } catch (err) {
    log.warn?.(`[local-review-shadow] WARNING: ${request.repo}#${request.prNumber} ignored unreadable shadow state before retry: ${err?.message || String(err)}`);
  }
  if (['completed', 'skipped'].includes(existingState?.status) && existsSync(paths.artifactPath)) {
    return {
      completed: true,
      skipped: existingState.status === 'skipped',
      idempotent: true,
      reason: existingState.reason || null,
      artifactPath: paths.artifactPath,
    };
  }

  try {
    ensureWritableImpl(paths, ['artifactPath', 'statePath']);
  } catch (err) {
    const reason = 'shadow-storage-unwritable';
    log.warn?.(`[local-review-shadow] WARNING: ${request.repo}#${request.prNumber} skipped: ${reason}: ${err?.message || String(err)}`);
    return {
      completed: false,
      skipped: true,
      retryable: true,
      reason,
      error: err?.message || String(err),
    };
  }

  try {
    const shadowText = await callLiteLLMImpl({
      request,
      diff,
      hostedReviewText,
      extraContext,
      fetchImpl,
      env,
      timeoutMs: resolveLocalReviewShadowTimeoutMs(env),
    });
    const artifact = formatLocalReviewShadowArtifact({
      request,
      reviewText: shadowText,
      status: 'completed',
    });
    const completedAt = new Date().toISOString();
    writeFileAtomicImpl(paths.artifactPath, artifact);
    writeFileAtomicImpl(paths.statePath, `${JSON.stringify({
      schemaVersion: 1,
      kind: 'local-review-shadow-state',
      status: 'completed',
      repo: request.repo,
      prNumber: request.prNumber,
      headSha: request.headSha || null,
      label: LOCAL_REVIEW_SHADOW_LABEL,
      artifactPath: paths.artifactPath,
      completedAt,
      localModel: request.localModel,
      localFamily: request.localFamily,
    }, null, 2)}\n`);
    return { completed: true, artifactPath: paths.artifactPath };
  } catch (err) {
    const failure = classifyLocalReviewShadowFailure(err);
    const skippedAt = new Date().toISOString();
    const reason = failure.reason || 'local-review-shadow-failed';
    const retryable = Boolean(failure.retryable);
    const status = retryable ? 'warn-skip' : 'skipped';
    const artifactStatus = retryable ? 'warn-skip' : 'skipped';
    const skipReason = retryable ? reason : (failure.skipReason || reason);
    const artifact = formatLocalReviewShadowArtifact({
      request,
      reviewText: retryable
        ? `WARNING: local OSS shadow review skipped or retryable after hosted review posted.\n\nReason: ${reason}`
        : `Local OSS shadow review skipped after hosted review posted.\n\nReason: ${skipReason}`,
      status: artifactStatus,
      reason: skipReason,
    });
    writeFileAtomicImpl(paths.artifactPath, artifact);
    writeFileAtomicImpl(paths.statePath, `${JSON.stringify({
      schemaVersion: 1,
      kind: 'local-review-shadow-state',
      status,
      reason: skipReason,
      lastError: reason,
      retryable,
      category: failure.category || null,
      statusCode: failure.statusCode || null,
      repo: request.repo,
      prNumber: request.prNumber,
      headSha: request.headSha || null,
      label: LOCAL_REVIEW_SHADOW_LABEL,
      artifactPath: paths.artifactPath,
      skippedAt,
      localModel: request.localModel,
      localFamily: request.localFamily,
    }, null, 2)}\n`);
    log.warn?.(`[local-review-shadow] WARNING: ${request.repo}#${request.prNumber} skipped: ${reason}`);
    return {
      completed: !retryable,
      skipped: true,
      retryable,
      reason,
      artifactPath: paths.artifactPath,
    };
  }
}

function persistLocalReviewShadowRequestFailOpen({
  log = console,
  ...args
} = {}) {
  try {
    return persistLocalReviewShadowRequest(args);
  } catch (err) {
    logStructuredEvent(log, {
      event: 'local-review-shadow',
      level: 'warning',
      repo: args.repo,
      prNumber: args.prNumber,
      phase: 'request',
      eligible: true,
      reason: 'request-persist-failed',
      error: err?.message || String(err),
    });
    return { persisted: false, reason: 'request-persist-failed', error: err?.message || String(err) };
  }
}

function startLocalReviewShadowCompletion({
  rootDir = ROOT,
  request,
  diff,
  hostedReviewText,
  extraContext = '',
  fetchImpl = globalThis.fetch,
  env = process.env,
  log = console,
  callLiteLLMImpl = callLiteLLMLocalReviewShadow,
} = {}) {
  if (!request) return { started: false, reason: 'missing-request' };
  const shadowStartedAt = Date.now();
  const completion = (async () => {
    try {
      const shadow = await completeLocalReviewShadowRequest({
        rootDir,
        request,
        diff,
        hostedReviewText,
        extraContext,
        fetchImpl,
        env,
        log,
        callLiteLLMImpl,
      });
      logStructuredEvent(log, {
        event: 'local-review-shadow',
        level: shadow.completed ? 'info' : 'warning',
        repo: request.repo,
        prNumber: request.prNumber,
        phase: 'artifact',
        completed: Boolean(shadow.completed),
        skipped: Boolean(shadow.skipped),
        retryable: Boolean(shadow.retryable),
        reason: shadow.reason || null,
        artifactPath: shadow.artifactPath || null,
        durationMs: Date.now() - shadowStartedAt,
      });
      return shadow;
    } catch (err) {
      logStructuredEvent(log, {
        event: 'local-review-shadow',
        level: 'warning',
        repo: request.repo,
        prNumber: request.prNumber,
        phase: 'artifact',
        completed: false,
        retryable: true,
        reason: err?.message || String(err),
        durationMs: Date.now() - shadowStartedAt,
      });
      return { completed: false, retryable: true, reason: err?.message || String(err) };
    }
  })();
  completion.catch(() => {});
  return { started: true, completion };
}

async function reconcileLocalReviewShadow({
  rootDir = ROOT,
  repo,
  prNumber,
  headSha,
  labels,
  builderTag,
  reviewerModel,
  hostedReviewPosted = false,
  hostedReviewText = '',
  diff = '',
  extraContext = '',
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console,
  writeFileAtomicImpl = writeFileAtomic,
  callLiteLLMImpl = callLiteLLMLocalReviewShadow,
  ensureWritableImpl = ensureLocalReviewShadowWritable,
} = {}) {
  const eligibility = evaluateLocalReviewShadowEligibility({ labels, builderTag, reviewerModel, env });
  if (!eligibility.eligible) {
    return { reconciled: false, reason: eligibility.reason };
  }
  const persisted = persistLocalReviewShadowRequest({
    rootDir,
    repo,
    prNumber,
    headSha,
    builderTag,
    reviewerModel,
    eligibility,
    writeFileAtomicImpl,
    ensureWritableImpl,
  });
  if (!hostedReviewPosted) {
    return { reconciled: false, reason: 'hosted-review-not-posted', requestPath: persisted.requestPath };
  }
  const marked = markLocalReviewShadowHostedPosted({
    rootDir,
    request: persisted.request,
    writeFileAtomicImpl,
    ensureWritableImpl,
  });
  const completed = await completeLocalReviewShadowRequest({
    rootDir,
    request: marked.request,
    diff,
    hostedReviewText,
    extraContext,
    fetchImpl,
    env,
    log,
    writeFileAtomicImpl,
    callLiteLLMImpl,
    ensureWritableImpl,
  });
  return { reconciled: true, requestPath: marked.requestPath, ...completed };
}

// LAC-545: forensic preservation of codex outputs that the sanitizer
// rejects. Persists into `data/codex-review-rejected/` with a stable
// `<owner>__<repo>__pr-<N>__<iso>.md` name. The directory is gitignored
// so the forensic snapshots don't accumulate into the repo. Capped at
// 50 KB per file so a runaway codex output can't fill the disk.
const REJECTED_CODEX_OUTPUT_CAP_BYTES = 50 * 1024;

function persistRejectedCodexOutput({ repo, prNumber, rejectionReason, rawReviewText }) {
  // Resolve the persistence directory relative to this module so the
  // path is stable whether the watcher is running from a worktree or
  // from the deploy checkout.
  const rootDir = join(
    fileURLToPath(import.meta.url),
    '..',
    '..',
    'data',
    'codex-review-rejected'
  );
  mkdirSync(rootDir, { recursive: true });
  const safeRepo = String(repo || 'unknown')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .slice(0, 80);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `${safeRepo}__pr-${prNumber}__${ts}.md`;
  const filePath = join(rootDir, fileName);
  const header = [
    `<!-- LAC-545 forensic dump of codex output that sanitizeCodexReviewPayload rejected -->`,
    `<!-- repo: ${repo} -->`,
    `<!-- prNumber: ${prNumber} -->`,
    `<!-- rejectedAt: ${new Date().toISOString()} -->`,
    `<!-- rejectionReason: ${String(rejectionReason || '').slice(0, 400)} -->`,
    `<!-- rawLengthBytes: ${Buffer.byteLength(String(rawReviewText || ''), 'utf8')} -->`,
    '',
  ].join('\n');
  const truncated = String(rawReviewText || '').slice(0, REJECTED_CODEX_OUTPUT_CAP_BYTES);
  const truncationNotice = String(rawReviewText || '').length > REJECTED_CODEX_OUTPUT_CAP_BYTES
    ? `\n\n<!-- truncated to ${REJECTED_CODEX_OUTPUT_CAP_BYTES} bytes -->\n`
    : '';
  writeFileSync(filePath, `${header}${truncated}${truncationNotice}`, { encoding: 'utf8', mode: 0o600 });
  console.error(`[reviewer] persisted rejected codex output: ${filePath}`);
  return filePath;
}

// ── Adversarial prompt (NON-NEGOTIABLE) ──────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

function deriveSpecTouchProject(path) {
  const normalizedPath = String(path ?? '');
  let match = normalizedPath.match(/^(?:projects|modules|tools)\/([^/]+)\/SPEC\.md$/);
  if (match) return match[1];
  match = normalizedPath.match(/^docs\/(?:SPEC|RUNBOOK)-(.+?)\.md$/);
  if (match) return match[1];
  return null;
}

function specTouchMatchesProject(path, project) {
  if (!path || !project) return false;
  const normalizedPath = String(path);
  const normalizedProject = String(project);
  return (
    normalizedPath === `projects/${normalizedProject}/SPEC.md` ||
    normalizedPath === `modules/${normalizedProject}/SPEC.md` ||
    normalizedPath === `tools/${normalizedProject}/SPEC.md` ||
    normalizedPath === `docs/SPEC-${normalizedProject}.md` ||
    normalizedPath.startsWith(`docs/SPEC-${normalizedProject}-`) ||
    normalizedPath === `docs/RUNBOOK-${normalizedProject}.md` ||
    normalizedPath.startsWith(`docs/RUNBOOK-${normalizedProject}-`)
  );
}

function describeTrackedContractChange({ path, patch }) {
  if (/^platform\/session-ledger\/src\/.*\.py$/.test(path)) {
    const signatureMatch = patch.match(/^[+-]def\s+([A-Za-z][A-Za-z0-9_]*)\s*\(/m);
    if (signatureMatch) {
      return {
        project: 'session-ledger',
        thing: `public Python signature \`${signatureMatch[1]}(...)\` in \`${path}\``,
      };
    }
  }

  if (/^modules\/([^/]+)\/(?:lib\/python|lib|server)\/.*\.py$/.test(path)) {
    const project = path.match(/^modules\/([^/]+)\//)?.[1];
    const signatureMatch = patch.match(/^[+-]def\s+([A-Za-z][A-Za-z0-9_]*)\s*\(/m);
    if (project && signatureMatch) {
      return {
        project,
        thing: `public Python signature \`${signatureMatch[1]}(...)\` in \`${path}\``,
      };
    }
  }

  if (/^platform\/session-ledger\/src\/session_ledger\/migrations\/.+\.sql$/.test(path)) {
    return {
      project: 'session-ledger',
      thing: `SQL migration \`${path}\``,
    };
  }

  if (/worker_events/i.test(path)) {
    return {
      project: path.match(/^modules\/([^/]+)\//)?.[1] || 'worker-pool',
      thing: `worker_events payload shape in \`${path}\``,
    };
  }

  if (/^modules\/worker-pool\/bin\/hq(?:-[^/]+)?$/.test(path)) {
    return {
      project: 'worker-pool',
      thing: `CLI contract in \`${path}\``,
    };
  }

  return null;
}

function detectSpecTouchViolations(diffText) {
  const files = parseDiffFiles(diffText);
  const touchedSpecProjects = new Set(
    files
      .map((file) => deriveSpecTouchProject(file.path))
      .filter(Boolean)
  );

  const violations = [];
  for (const file of files) {
    const contract = describeTrackedContractChange(file);
    if (!contract) continue;

    const publicSignatureNames = [...file.patch.matchAll(/^[+-]def\s+([A-Za-z][A-Za-z0-9_]*)\s*\(/gm)].map((match) => match[1]);
    if (publicSignatureNames.length > 0 && publicSignatureNames.every((name) => name.startsWith('_'))) {
      continue;
    }

    const specTouched =
      touchedSpecProjects.has(contract.project) ||
      files.some((candidate) => specTouchMatchesProject(candidate.path, contract.project));
    if (specTouched) continue;

    violations.push({
      project: contract.project,
      thing: contract.thing,
      message: `Contract changed without spec update. The diff modifies ${contract.thing} but no canonical spec doc for \`${contract.project}\` was touched. The default remediation is to update the corresponding SPEC/RUNBOOK entry to match the new behavior; revert only for a concrete production regression or an explicit operator-policy conflict.`,
    });
  }

  return violations;
}

// ── Critical-issue detection ─────────────────────────────────────────────────

const CRITICAL_WORDS = ['critical', 'vulnerability', 'security', 'injection'];

function isCritical(reviewText) {
  const lower = reviewText.toLowerCase();
  return CRITICAL_WORDS.some((w) => lower.includes(w));
}

function shouldQueueFollowUpForReview(reviewText) {
  return Boolean(reviewText);
}

function queueFollowUpForPostedReview({
  rootDir = ROOT,
  repo,
  prNumber,
  baseBranch,
  revisionRef = null,
  reviewerModel,
  builderTag = null,
  linearTicketId = null,
  reviewText,
  reviewPostedAt = new Date().toISOString(),
  critical = false,
  verdictMode = VERDICT_MODE_ENFORCE,
  summarizePRRemediationLedgerImpl = summarizePRRemediationLedger,
  createFollowUpJobImpl = createFollowUpJob,
  resolveHandoffConfigImpl = () => resolveHandoffConfig({ getConfigImpl: getConfig }),
  signalFollowUpDaemonWakeImpl = signalFollowUpDaemonWake,
  scopeViolationFinding = null,
}) {
  const normalizedVerdictMode = normalizeVerdictMode(verdictMode);
  if (normalizedVerdictMode === VERDICT_MODE_ADVISORY_ONLY) {
    return {
      queued: false,
      reason: 'advisory-only-review',
      verdictMode: normalizedVerdictMode,
    };
  }
  if (!shouldQueueFollowUpForReview(reviewText)) {
    return { queued: false, reason: 'empty-review-body', verdictMode: normalizedVerdictMode };
  }
  if (scopeViolationFinding || reviewBodyHasScopeViolationFinding(reviewText)) {
    return { queued: false, reason: 'scope-violation' };
  }
  if (typeof baseBranch !== 'string' || baseBranch.trim() === '') {
    throw new Error('baseBranch is required to queue a follow-up handoff');
  }

  const priorLedger = summarizePRRemediationLedgerImpl(rootDir, { repo, prNumber });
  const tierResolution = resolveRoundBudgetForJob({ linearTicketId }, {
    rootDir,
    preferPersisted: false,
  });
  const latestMaxRounds = Number(priorLedger.latestMaxRounds);
  const elevatedPriorCap = Number.isInteger(latestMaxRounds) && latestMaxRounds > tierResolution.roundBudget
    ? latestMaxRounds
    : null;

  const { jobPath } = createFollowUpJobImpl({
    rootDir,
    repo,
    prNumber,
    baseBranch: baseBranch.trim(),
    revisionRef: revisionRef || null,
    reviewerModel,
    builderTag: builderTag || null,
    linearTicketId,
    reviewBody: reviewText,
    reviewPostedAt,
    critical,
    verdictMode: normalizedVerdictMode,
    riskClass: tierResolution.riskClass,
    priorCompletedRounds: priorLedger.completedRoundsForPR,
    ...(elevatedPriorCap ? { maxRemediationRounds: elevatedPriorCap } : {}),
  });
  let handoffWake = { attempted: false };
  try {
    const handoffConfig = resolveHandoffConfigImpl();
    if (handoffConfig.enabled && handoffConfig.reviewToRemediation) {
      const wake = signalFollowUpDaemonWakeImpl({
        rootDir,
        reason: 'review-to-remediation',
        repo,
        prNumber,
        headSha: revisionRef,
      });
      handoffWake = { attempted: true, ok: true, ...wake };
    }
  } catch (err) {
    handoffWake = {
      attempted: true,
      ok: false,
      error: err?.message || String(err),
    };
  }
  return { queued: true, jobPath, verdictMode: normalizedVerdictMode, handoffWake };
}

// ── PR diff fetch ────────────────────────────────────────────────────────────

async function fetchPRDiff(repo, prNumber, headSha, {
  execFileImpl = execFileAsync,
  execGhWithRetryImpl = execGhWithRetry,
  getCachedDiffImpl = getCachedDiff,
  putCachedDiffImpl = putCachedDiff,
  recordApiCallImpl = recordApiCall,
  apiStatusFromErrorImpl = apiStatusFromError,
  ghRetrySleepImpl = sleep,
  log = console,
} = {}) {
  const cacheLookupStartedAt = Date.now();
  const cached = headSha ? getCachedDiffImpl(repo, prNumber, headSha) : null;
  if (cached) {
    recordApiCallImpl({
      category: 'cache_hit_diff_fetch',
      repo,
      prNumber,
      status: 'hit',
      durationMs: Date.now() - cacheLookupStartedAt,
    });
    return cached.bytes;
  }

  const { stdout } = await execGhWithRetryImpl({
    execFileImpl: async (command, args, options) => {
      const attemptStartedAt = Date.now();
      try {
        const result = await execFileImpl(
          command,
          args,
          { ...options, encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 }
        );
        recordApiCallImpl({
          category: 'diff_fetch',
          repo,
          prNumber,
          status: 200,
          durationMs: Date.now() - attemptStartedAt,
        });
        return result;
      } catch (err) {
        recordApiCallImpl({
          category: 'diff_fetch',
          repo,
          prNumber,
          status: apiStatusFromErrorImpl(err),
          durationMs: Date.now() - attemptStartedAt,
        });
        throw err;
      }
    },
    args: ['pr', 'diff', String(prNumber), '--repo', repo],
    timeoutMs: Math.max(GH_LOOKUP_TIMEOUT_MS, 60_000),
    sleep: ghRetrySleepImpl,
  });
  if (headSha) {
    try {
      putCachedDiffImpl(repo, prNumber, headSha, stdout);
    } catch (err) {
      log.warn?.(`[reviewer] WARN: failed to write diff cache for ${repo}#${prNumber}@${headSha}: ${err?.message || err}`);
    }
  }
  return stdout;
}

async function fetchPRContext(repo, prNumber) {
  return fetchPullRequestReviewContext(repo, prNumber, {
    execFileImpl: execFileAsync,
    recordApiCallImpl: recordApiCall,
  });
}

// ── GitHub review posting ────────────────────────────────────────────────────

class ReviewerPostAuthRefreshRetryableError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'ReviewerPostAuthRefreshRetryableError';
    this.cause = cause;
  }
}

function isReviewerPostAuthFailure(err, { preWriteSaw401 = false } = {}) {
  const detail = buildGhErrorDetail(err);
  if (
    /\b401\b/.test(detail)
    || /\bunauthorized\b/.test(detail)
    || /\bbad credentials?\b/.test(detail)
    || /\bauthentication (?:failed|required)\b/.test(detail)
    || /\brequires authentication\b/.test(detail)
    || /\bnot logged in\b/.test(detail)
    || /\blogin required\b/.test(detail)
  ) {
    return true;
  }
  return preWriteSaw401 && (
    /\boauth\b/.test(detail)
    || /\bcredentials?\b/.test(detail)
    || /\b(?:access|bearer|installation|github app)\s+token\b/.test(detail)
    || /\bgh auth\b/.test(detail)
    || /\bkeychain\b/.test(detail)
  );
}

function isRetryableGhTransportError(err, { allowAuthRefresh = false, preWriteSaw401 = false } = {}) {
  const detail = buildGhErrorDetail(err);
  if (allowAuthRefresh && isReviewerPostAuthFailure(err, { preWriteSaw401 })) {
    return true;
  }
  return /\b(etimedout|econnreset|econnrefused|ehostunreach|eai_again|enotfound|epipe|eagain)\b/.test(detail)
    || detail.includes('timeout')
    || detail.includes('timed out')
    || detail.includes('temporary failure')
    || detail.includes('temporarily unavailable')
    || detail.includes('rate limit')
    || detail.includes('secondary rate limit')
    || detail.includes('502 bad gateway')
    || detail.includes('503 service unavailable')
    || detail.includes('504 gateway timeout');
}

async function withGhRetry(operation, {
  retryDelaysMs = REVIEW_POST_RETRY_DELAYS_MS,
  isRetryable = () => false,
} = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt >= retryDelaysMs.length) {
        throw err;
      }
      await sleep(retryDelaysMs[attempt]);
    }
  }
  throw lastErr;
}

function createReviewerPreWriteLogProxy(log = console) {
  const base = log || console;
  const tracker = { saw401: false };
  return {
    tracker,
    log: {
      ...base,
      warn(message, ...args) {
        const rendered = String(message || '');
        if (/\[reviewer-pre-write\].*http 401/i.test(rendered)) {
          tracker.saw401 = true;
        }
        return base.warn?.(message, ...args);
      },
    },
  };
}

// GitHub's GraphQL `addPullRequestReview` mutation refuses to create a second
// pending review per (user, PR) tuple. If a previous reviewer subprocess was
// SIGTERM'd between `gh pr review --comment` initiating the review and the
// body submission completing, GitHub may have already accepted the review
// CREATION but not the body submission — leaving a PENDING review draft
// scoped to the bot, invisible to other accounts via the standard reviews
// list. Every subsequent reviewer attempt then dies with:
//
//   GraphQL: User can only have one pending review per pull request (addPullRequestReview)
//
// The watcher's failure classifier returns `failure-class=unknown` (no pattern
// match), so it schedules another retry, which fails the same way. Indefinite
// loop, never recovers without operator manual DELETE.
//
// Bot-self-housekeeping: before each post, list the bot's own reviews on the
// PR via the REST API (which DOES surface our own pending drafts), and DELETE
// any with state=PENDING. The bot is the only writer of its own reviews, so
// this is race-free against itself. Best-effort: if the list/delete calls
// fail, log and continue — the post may still succeed, and a failure here is
// strictly less bad than the leak it's trying to prevent.
async function postGitHubReview(repo, prNumber, reviewBody, botTokenEnv, execFileImpl = execFileAsync, opts = {}) {
  const sourceEnv = opts.env || process.env;
  // GMW-06 safety net: a gemini reviewer must never silently mis-post under
  // another identity's token, and the legacy GEMINI_REVIEWER_GH_TOKEN item name
  // must never leak into the runtime. Fails closed with a legible error before
  // we read/use any token.
  preflightGeminiReviewerToken({
    env: sourceEnv,
    botTokenEnv,
    reviewerIdentity: opts.reviewerIdentity,
  });
  let token = sourceEnv[botTokenEnv];
  if (!token) {
    throw new Error(`Missing env var: ${botTokenEnv}`);
  }

  const prepareReviewWrite = opts.prepareReviewWrite || clearPendingReviewsForSelf;
  const log = opts.log || console;
  const refreshIdentity = resolveReviewerIdentityForBotTokenEnv(botTokenEnv, opts.reviewerIdentity);
  const appSelfLogin = resolveGitHubAppBotLogin({
    identity: refreshIdentity,
    botTokenEnv,
    env: sourceEnv,
    log,
  });
  const writeIdentity = appSelfLogin || refreshIdentity;
  let refreshedAfterAuthFailure = false;

  const stateDir = resolveAdversarialReviewStateDir(opts.rootDir || ROOT, sourceEnv);
  let reviewerFence = null;
  try {
    reviewerFence = openReviewerFence({
      stateDir,
      spawnToken: opts.reviewerSpawnToken,
      repo,
      pr: prNumber,
      identity: opts.reviewerIdentity,
      graceSeconds: resolveSigtermFenceGraceSeconds(opts.env || process.env),
    });
  } catch (err) {
    if (err?.code === 'EWOULDBLOCK' || err?.code === 'EAGAIN') {
      throw err;
    }
    (opts.log || console).warn?.(
      `[reviewer] reviewer fence unavailable; posting review without fence: ${err?.message || err}`
    );
  }
  const startedAt = Date.now();
  try {
    await withGhRetry(
      async () => {
        const preWriteLog = createReviewerPreWriteLogProxy(log);
        await prepareReviewWrite({
          repo,
          prNumber,
          token,
          // The reviewer bot tokens are GitHub App tokens — `GET /user` returns
          // 403 ("Resource not accessible by integration"), so pass the known
          // GitHub author login to skip the self-login probe. (PAT path still
          // falls back to /user when no app/provider identity is supplied.)
          selfLogin: appSelfLogin,
          fetchImpl: opts.fetchImpl,
          log: preWriteLog.log,
        });
        try {
          await awaitThrottleIfNeeded();
          const adapterEnv = {
            PATH: sourceEnv.PATH ?? '/usr/bin:/bin',
            HOME: sourceEnv.HOME ?? '',
            GH_TOKEN: token,
            [botTokenEnv]: token,
          };
          for (const key of REVIEW_ADAPTER_ENV_KEYS) {
            if (sourceEnv[key] !== undefined) adapterEnv[key] = sourceEnv[key];
          }
          for (const suffix of ['_SOURCE', '_BROKER_PROVIDER']) {
            const key = `${botTokenEnv}${suffix}`;
            if (sourceEnv[key] !== undefined) adapterEnv[key] = sourceEnv[key];
          }
          let adapterHandled = false;
          try {
            const adapterResult = await writeAdapterPullRequestReview(
              repo,
              prNumber,
              { body: reviewBody, reviewerLogin: writeIdentity },
              { execFileImpl, env: adapterEnv, rootDir: opts.rootDir || ROOT }
            );
            adapterHandled = adapterResult?.ran === true;
          } catch (adapterErr) {
            if (!adapterUnsupportedError(adapterErr)) {
              throw adapterErr;
            }
          }
          if (!adapterHandled) {
            await execFileImpl(
              'gh',
              ['pr', 'review', String(prNumber), '--repo', repo, '--comment', '--body', reviewBody],
              {
                env: adapterEnv,
                maxBuffer: 5 * 1024 * 1024,
              }
            );
          }
        } catch (err) {
          const authRetryable = isReviewerPostAuthFailure(err, {
            preWriteSaw401: preWriteLog.tracker.saw401,
          });
          if (!refreshedAfterAuthFailure && authRetryable) {
            const refreshed = await resolveReviewerAppToken(refreshIdentity, {
              env: sourceEnv,
              fetchImpl: opts.fetchImpl,
              readFileImpl: opts.readFileImpl,
              timeoutMs: opts.reviewerTokenFetchTimeoutMs,
            }).catch((refreshErr) => {
              log.warn?.(
                `[reviewer] failed to refresh ${botTokenEnv} after GitHub auth failure: ${refreshErr?.message || refreshErr}`
              );
              return null;
            });
            if (refreshed?.token && refreshed.envVar === botTokenEnv) {
              refreshedAfterAuthFailure = true;
              token = refreshed.token;
              log.warn?.(
                `[reviewer] refreshed ${botTokenEnv} after GitHub auth failure; retrying review post once`
              );
              throw new ReviewerPostAuthRefreshRetryableError(
                `Retry GitHub review post after refreshing ${botTokenEnv}`,
                { cause: err }
              );
            }
            if (refreshed?.token && refreshed.envVar !== botTokenEnv) {
              log.warn?.(
                `[reviewer] refused refreshed ${refreshed.envVar || '<unknown>'} token for ${botTokenEnv} after GitHub auth failure`
              );
            }
          }
          throw err;
        }
      },
      {
        retryDelaysMs: REVIEW_POST_RETRY_DELAYS_MS,
        isRetryable: (err) => err instanceof ReviewerPostAuthRefreshRetryableError,
      }
    );
    recordApiCall({
      category: 'review_post',
      repo,
      prNumber,
      status: 200,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    recordApiCall({
      category: 'review_post',
      repo,
      prNumber,
      status: apiStatusFromError(err),
      durationMs: Date.now() - startedAt,
    });
    throw err;
  } finally {
    reviewerFence?.clear();
  }
}

async function postGitHubReviewWithCapture({
  rootDir = ROOT,
  repo,
  prNumber,
  attemptNumber,
  reviewerModel,
  reviewerHeadSha = null,
  reviewBody,
  botTokenEnv,
  passKind,
  postedAt = null,
  execFileImpl = execFileAsync,
  attestExecFileImpl = execFileImpl,
  log = console,
  fetchImpl = globalThis.fetch,
  readFileImpl = undefined,
  prepareReviewWrite = clearPendingReviewsForSelf,
  reviewerSpawnToken = null,
  reviewerIdentity = null,
  reviewerTokenFetchTimeoutMs = undefined,
} = {}) {
  const normalizedHeadSha = String(reviewerHeadSha || '').trim();
  const capturedReviewBody = normalizedHeadSha
    ? findCapturedReviewerBody(rootDir, {
      repo,
      prNumber,
      attemptNumber: Number(attemptNumber),
      passKind,
      headSha: normalizedHeadSha,
      reviewerModel,
    })
    : null;
  const alreadyCaptured = capturedReviewBody !== null;
  const effectiveReviewBody = capturedReviewBody ?? reviewBody;
  let initialToken = null;
  if (!alreadyCaptured) {
    // GMW-06: run the gemini-reviewer preflight before the generic env check so a
    // gemini post with an unresolved token fails with the legible runbook-naming
    // error (and the legacy-conflict guard fires) rather than the bare
    // "Missing env var" — and never falls through to another identity's token.
    preflightGeminiReviewerToken({ env: process.env, botTokenEnv, reviewerIdentity });
    initialToken = process.env[botTokenEnv];
    if (!initialToken) {
      throw new Error(`Missing env var: ${botTokenEnv}`);
    }
    await postGitHubReview(repo, prNumber, reviewBody, botTokenEnv, execFileImpl, {
      rootDir,
      fetchImpl,
      readFileImpl,
      log,
      prepareReviewWrite,
      reviewerSpawnToken,
      reviewerIdentity,
      reviewerTokenFetchTimeoutMs,
    });
  }

  // Capture postedAt AFTER the gh post returns so the candidate window
  // bounds the artifact's GitHub-assigned timestamp, which is set during
  // post handling — not before the request leaves.
  const effectivePostedAt = postedAt || new Date().toISOString();

  // Normalize 'unknown' to null so the reviewer_passes.verdict CHECK
  // constraint (approved / comment-only / request-changes / dismissed / NULL)
  // does not abort the body-capture UPDATE when a reviewer goes off-script.
  // Losing the parsed-verdict shortcut is preferable to losing body capture
  // entirely; downstream consumers already treat NULL as "verdict unknown".
  const normalizedVerdict = normalizeEffectiveReviewVerdict(effectiveReviewBody, {
    log,
    context: `${repo}#${prNumber} attempt=${attemptNumber} reviewer=${reviewerModel}`,
  });
  const persistedVerdict = normalizedVerdict === 'unknown' ? null : normalizedVerdict;

  if (!alreadyCaptured) await captureReviewerBodyAfterPost(rootDir, {
    repo,
    prNumber,
    attemptNumber: Number(attemptNumber),
    reviewerModel,
    botTokenEnv,
    reviewBody,
    verdict: persistedVerdict,
    passKind,
    postedAt: effectivePostedAt,
    execFileImpl,
    env: { ...process.env, [botTokenEnv]: process.env[botTokenEnv] || initialToken },
    log,
  });

  if (!normalizedHeadSha) {
    log.warn?.(
      `[reviewer] reviewed attestation skipped for ${repo}#${prNumber}: reviewerHeadSha is unavailable`
    );
    return;
  }

  await emitReviewedAttestation({
    repo,
    prNumber,
    headSha: normalizedHeadSha,
    reviewerIdentity: resolveReviewerIdentityForBotTokenEnv(
      botTokenEnv,
      reviewerIdentity || reviewerModel
    ),
    verdict: normalizedVerdict,
    reviewBody: effectiveReviewBody,
    execFileImpl: attestExecFileImpl,
    env: process.env,
    log,
  });
}

// ── Clio alert (OAuth failure) ───────────────────────────────────────────────

/**
 * Alert Paul via Clio when OAuth credentials are unavailable.
 * Uses the OpenClaw wake hook to deliver a Telegram message.
 */
async function alertClioOAuthFailure(model, repo, prNumber, reason) {
  const msg = `🔐 Adversarial reviewer STOPPED — ${model} OAuth credentials unavailable.\n\nRepo: ${repo} PR #${prNumber}\nReason: ${reason}\n\nAction needed: re-authenticate ${model} (run the CLI and log in). PR review is paused until credentials are restored.`;

  console.error(`[reviewer] ALERT: ${msg}`);

  // Try to wake Clio via the OpenClaw hook
  try {
    await execFileAsync(
      'curl',
      [
        '-s', '-X', 'POST',
        'http://127.0.0.1:8787/hooks/wake',
        '-H', 'Content-Type: application/json',
        '-d', JSON.stringify({ message: msg }),
      ],
      { timeout: 10_000 }
    );
    console.log('[reviewer] Clio alert sent via wake hook');
  } catch (err) {
    console.error('[reviewer] Failed to send Clio alert:', err.message);
    // Alert is best-effort — the error is already in watcher logs
  }
}

async function alertClioOversizedAgyFailure({
  repo,
  prNumber,
  promptBytes,
  maxBytes,
  reason,
}, {
  execFileImpl = execFileAsync,
  retryDelaysMs = WAKE_HOOK_RETRY_DELAYS_MS,
  sleepImpl = sleep,
} = {}) {
  const msg = `Adversarial reviewer oversized agy prompt could not be reviewed.\n\nRepo: ${repo} PR #${prNumber}\nPrompt bytes: ${promptBytes ?? 'unknown'}\nAgy argv budget: ${maxBytes ?? 'unknown'}\nReason: ${reason}\n\nThis is the #3074/#3122/#3124 no-review prevention guard; operator action is required because both cross-model routing and chunk fallback were unavailable.`;

  console.error(`[reviewer] ALERT: ${msg}`);

  try {
    await execFileWithTransientRetry(
      'curl',
      [
        '-sS', '-f', '--max-time', '10', '-X', 'POST',
        'http://127.0.0.1:8787/hooks/wake',
        '-H', 'Content-Type: application/json',
        '-d', JSON.stringify({ message: msg }),
      ],
      {
        execFileImpl,
        retryDelaysMs,
        sleepImpl,
      }
    );
    console.log('[reviewer] oversized agy prompt alert sent via wake hook');
  } catch (err) {
    console.error('[reviewer] Failed to send oversized agy prompt alert:', err.message);
  }
}

// ── Linear integration (LAC-13) ──────────────────────────────────────────────

const linearTriage = createLinearTriageAdapter({
  logger: console,
  criticalWords: CRITICAL_WORDS,
});

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const rawArgs = process.argv[2];
  if (!rawArgs) {
    console.error('[reviewer] Usage: node src/reviewer.mjs \'<JSON args>\'');
    process.exit(1);
  }

  let args;
  try {
    args = JSON.parse(rawArgs);
  } catch {
    console.error('[reviewer] Invalid JSON args:', rawArgs);
    process.exit(1);
  }

  const {
    repo,
    prNumber,
    reviewerModel,
    botTokenEnv,
    linearTicketId,
    builderTag,
    reviewerHeadSha,
    reviewAttemptNumber,
    reviewDbAttemptNumber,
    completedRemediationRounds,
    maxRemediationRounds,
    passKind,
    reviewerSessionUuid,
    reviewerSpawnToken,
    labels = [],
    ticketPipelinePaused = false,
    advisoryFindings = [],
    crossModelReviewWaived = false,
    crossModelReviewWaiverReason = null,
  } = args;

  if (!repo || !prNumber || !reviewerModel || !botTokenEnv) {
    console.error('[reviewer] Missing required fields in args:', args);
    process.exit(1);
  }

  // The reviewer treats the final allowed review pass as a lenient
  // verdict round (only blocking on data corruption / secret leakage /
  // security regression / broken external contract). Computed from the
  // (1-indexed) attempt number and the remediation cap, both passed by
  // the watcher. Backward-compat: if either is missing (old watcher
  // calling new reviewer), default to non-final-round behavior so we
  // don't accidentally downgrade reviews on older deployments.
  const reviewerCompletedRemediationRounds = completedRemediationRounds ?? (
    Number.isFinite(Number(reviewAttemptNumber)) ? Number(reviewAttemptNumber) - 1 : undefined
  );
  const reviewerPromptStage = (
    reviewAttemptNumber === undefined &&
    completedRemediationRounds === undefined &&
    maxRemediationRounds === undefined
  )
    ? 'first'
    : pickReviewerStage({
        reviewAttemptNumber,
        completedRemediationRounds: reviewerCompletedRemediationRounds,
        maxRemediationRounds,
      });
  const isFinalRound = reviewerPromptStage === 'last';

  console.log(
    `[reviewer] Starting review: ${repo}#${prNumber} model=${reviewerModel}` +
    ` (OAuth-only mode; prompt stage=${reviewerPromptStage}${isFinalRound ? `; FINAL round attempt ${reviewAttemptNumber} of ${1 + Number(maxRemediationRounds || 0)} — lenient verdict threshold active` : ''})`
  );
  console.error(`[reviewer] DEBUG: args=${JSON.stringify(args)}`);
  if (reviewerSessionUuid && !process.env.REVIEWER_SESSION_UUID) {
    process.env.REVIEWER_SESSION_UUID = String(reviewerSessionUuid);
  }

  if (reviewerHeadSha) {
    try {
      await linearTriage.recordReviewerEngagement({
        domainId: 'code-pr',
        subjectExternalId: `${repo}#${prNumber}`,
        revisionRef: reviewerHeadSha,
        linearTicketId,
        labels,
        ticketPipelinePaused,
      }, {
        startedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[reviewer] LINEAR REVIEW-START UPDATE FAILED for ${linearTicketId}:`, err.message);
    }
  }

  // 1. Fetch diff
  let diff;
  try {
    console.error(`[reviewer] DEBUG: fetching diff for ${repo}#${prNumber}...`);
    const diffBytes = await fetchPRDiff(repo, prNumber, reviewerHeadSha);
    diff = diffBytes.toString('utf8');
    console.error(`[reviewer] DEBUG: fetched diff (${diffBytes.byteLength} bytes)`);
  } catch (err) {
    console.error(`[reviewer] Failed to fetch diff for ${repo}#${prNumber}:`, err.message);
    process.exit(1);
  }

  if (!diff.trim()) {
    console.log(`[reviewer] Empty diff for ${repo}#${prNumber} — nothing to review`);
    process.exit(0);
  }

  let prContext;
  try {
    prContext = await fetchPRContext(repo, prNumber);
  } catch (err) {
    console.error(`[reviewer] Failed to fetch required PR context for ${repo}#${prNumber}: ${err.message}`);
    process.exit(1);
  }

  const extraContext = await buildReviewerExtraContext({
    repo,
    prNumber,
    prContext,
    diff,
    advisoryFindings,
    repoRoot: join(ROOT, '..', '..'),
    log: console,
  });

  // 2. Run adversarial review (OAuth only — no API key fallback)
  let effectiveModel = reviewerModel;
  let effectiveBotTokenEnv = botTokenEnv;
  let oversizedAgyRoute = null;
  let useAgyChunkFallback = false;
  const geminiRuntimeForBudget = effectiveModel === 'gemini'
    ? resolveGeminiRuntimeForReview(resolveGeminiRuntime, console)
    : null;
  oversizedAgyRoute = resolveAgyOversizedReviewRoute({
    reviewerModel: effectiveModel,
    botTokenEnv: effectiveBotTokenEnv,
    builderTag,
    diff,
    extraContext,
    promptStage: reviewerPromptStage,
    geminiRuntime: geminiRuntimeForBudget,
  });
  if (oversizedAgyRoute.oversized) {
    if (oversizedAgyRoute.route) {
      effectiveModel = oversizedAgyRoute.route.reviewerModel;
      effectiveBotTokenEnv = oversizedAgyRoute.route.botTokenEnv;
      console.warn(
        `[reviewer] reviewer-selection repo=${repo} pr=${prNumber} reason=agy-argv-budget-exceeded ` +
          `size=${oversizedAgyRoute.promptBytes} budget=${oversizedAgyRoute.maxBytes} ` +
          `routed=${effectiveModel} original=gemini refs=#3074,#3122,#3124`
      );
    } else {
      useAgyChunkFallback = true;
      console.warn(
        `[reviewer] reviewer-selection repo=${repo} pr=${prNumber} reason=agy-argv-budget-exceeded ` +
          `size=${oversizedAgyRoute.promptBytes} budget=${oversizedAgyRoute.maxBytes} ` +
          `routed=agy-chunks original=gemini refs=#3074,#3122,#3124`
      );
    }
  }
  logStructuredEvent(console, {
    event: 'hosted-reviewer-selection',
    level: 'info',
    repo,
    prNumber,
    reviewerModel: effectiveModel,
    botTokenEnv: effectiveBotTokenEnv,
    builderTag: builderTag || null,
    label: hasLocalReviewShadowLabel(labels) ? LOCAL_REVIEW_SHADOW_LABEL : null,
    oversizedAgyPromptBytes: oversizedAgyRoute?.oversized ? oversizedAgyRoute.promptBytes : null,
    oversizedAgyBudgetBytes: oversizedAgyRoute?.oversized ? oversizedAgyRoute.maxBytes : null,
  });

  let reviewText;
  let rawReviewText;
  let tokenUsage = null;
  try {
    console.error(`[reviewer] DEBUG: starting ${effectiveModel} review...`);
    // Single selection site (GMW-01): claude / gemini / codex. gemini routes
    // to reviewWithGemini and never falls through to codex.
    let dispatch;
    try {
      dispatch = useAgyChunkFallback
        ? await reviewAgyOversizedInChunks(diff, extraContext, {
            promptStage: reviewerPromptStage,
            promptBytes: oversizedAgyRoute?.promptBytes,
            maxBytes: oversizedAgyRoute?.maxBytes,
          })
        : await dispatchReviewerModel(effectiveModel, diff, extraContext, {
            promptStage: reviewerPromptStage,
          });
    } catch (firstErr) {
      if (!oversizedAgyRoute?.oversized || useAgyChunkFallback) throw firstErr;
      console.warn(
        `[reviewer] oversized agy routed reviewer unavailable for ${repo}#${prNumber}: ` +
          `${firstErr?.message || firstErr}; falling back to bounded agy chunks`
      );
      effectiveModel = 'gemini';
      effectiveBotTokenEnv = 'GH_GEMINI_REVIEWER_TOKEN';
      dispatch = await reviewAgyOversizedInChunks(diff, extraContext, {
        promptStage: reviewerPromptStage,
        promptBytes: oversizedAgyRoute.promptBytes,
        maxBytes: oversizedAgyRoute.maxBytes,
      });
    }
    rawReviewText = dispatch.rawReviewText;
    tokenUsage = dispatch.tokenUsage;
    if (dispatch.needsSanitize) {
      console.error(`[reviewer] DEBUG: raw Codex review length=${rawReviewText.length}; preview=${previewText(rawReviewText)}`);
      try {
        reviewText = sanitizeCodexReviewPayload(rawReviewText);
      } catch (sanitizeErr) {
        console.error(`[reviewer] SANITIZE FAILED: ${sanitizeErr.message}`);
        console.error(`[reviewer] SANITIZE INPUT PREVIEW: ${previewText(rawReviewText, 400)}`);
        // LAC-545: forensic preservation. Persist the rejected raw codex
        // output so a future fix to the sanitizer / prompt / codex CLI
        // can be diagnosed without re-triggering the failure. Before
        // this, every rejection was lost — the codex output file was
        // unlinked inside reviewWithCodex and the watcher's classifier
        // silenced the stderr. Truncate to 50 KB to bound disk usage.
        try {
          persistRejectedCodexOutput({
            repo,
            prNumber,
            rejectionReason: sanitizeErr.message,
            rawReviewText,
          });
        } catch (persistErr) {
          console.error(`[reviewer] WARN: failed to persist rejected codex output: ${persistErr.message}`);
        }
        throw sanitizeErr;
      }
    } else {
      reviewText = dispatch.reviewText;
    }
    console.error(`[reviewer] DEBUG: review completed (${reviewText.length} bytes)`);
  } catch (err) {
    if (err.isOAuthError) {
      // OAuth failure — stop work and alert Paul
      await alertClioOAuthFailure(reviewerModel, repo, prNumber, err.message);
      console.error(`[reviewer] Stopped: OAuth credentials unavailable for ${reviewerModel}`);
      process.exit(2); // exit code 2 = auth failure (distinct from other errors)
    }
    if (oversizedAgyRoute?.oversized) {
      await alertClioOversizedAgyFailure({
        repo,
        prNumber,
        promptBytes: oversizedAgyRoute.promptBytes,
        maxBytes: oversizedAgyRoute.maxBytes,
        reason: err.message || String(err),
      });
    }
    console.error(`[reviewer] AI review failed for ${repo}#${prNumber}:`, err.message);
    console.error(`[reviewer] ERROR STACK: ${err.stack}`);
    process.exit(1);
  }

  if (!tokenUsage && effectiveModel === 'gemini') {
    // Antigravity (agy) reviewers emit no local token usage (server-side
    // conversations, no JSON surface). Persist a heuristic LOWER-BOUND estimate
    // from the prompt (diff + context) and the review body, tagged distinctly so
    // it stays separable from exact counts. Mirrors the worker-pool antigravity
    // estimate-floor (source gemini-antigravity-estimate).
    const estInput = estimateTokensFromText(`${diff}\n${extraContext || ''}`);
    const estOutput = estimateTokensFromText(reviewText);
    if (estInput > 0 || estOutput > 0) {
      tokenUsage = {
        input: estInput,
        output: estOutput,
        reasoning: null,
        cacheRead: null,
        cacheWrite: 0,
        toolContext: null,
        total: estInput + estOutput,
        source: 'gemini-antigravity-estimate',
      };
    }
  }

  if (tokenUsage) {
    const hasExplicitGuardrail = Object.prototype.hasOwnProperty.call(tokenUsage, 'guardrail')
      && tokenUsage.guardrail !== undefined;
    console.log(JSON.stringify({
      type: 'reviewer.token_usage',
      tokenUsage: {
        ...tokenUsage,
        usageTag: tokenUsage.usageTag || 'guardrail',
        guardrail: hasExplicitGuardrail
          ? tokenUsage.guardrail
          : (tokenUsage.total ?? ((tokenUsage.input || 0) + (tokenUsage.output || 0))),
      },
    }));
  }
  console.log(`[reviewer] Review generated (${reviewText.length} chars)`);

  // 3. Post to GitHub
  const reviewerMetadata = resolveReviewerMetadata(effectiveModel);
  const verdictModeResolution = await fetchCurrentHeadVerdictMode({
    repo,
    prNumber,
    reviewerHeadSha,
  });
  const verdictMode = verdictModeResolution.verdictMode;
  console.log(
    `[reviewer] Verdict mode for ${repo}#${prNumber}@${reviewerHeadSha || '<unknown-head>'}: ${verdictMode}` +
      (verdictModeResolution.currentHeadSha ? ` (current head ${verdictModeResolution.currentHeadSha})` : '')
  );
  const waiverAuditBlock = crossModelReviewWaived
    ? `> Cross-model review waiver: ${String(crossModelReviewWaiverReason || 'operator override selected the same reviewer family as the builder for this pass.')}\n\n`
    : '';
  let scopeViolationFinding = null;
  try {
    const scopeReview = await resolveAdditiveOnlyScopeReview({
      repo,
      prNumber,
      logger: console,
    });
    scopeViolationFinding = scopeReview.finding || null;
    if (scopeViolationFinding) {
      console.error(
        `[reviewer] additive-only scope violation detected for ${repo}#${prNumber}: ` +
          `${scopeViolationFinding.violating_files.join(', ')}`
      );
    }
  } catch (err) {
    console.error(
      `[reviewer] WARN: additive-only scope check failed for ${repo}#${prNumber}; continuing normal review: ${err?.message || err}`
    );
  }
  const reviewTextForPost = scopeViolationFinding
    ? appendScopeViolationFinding(reviewText, scopeViolationFinding)
    : reviewText;
  const fullComment = buildReviewCommentBody({
    reviewerMetadata,
    verdictMode,
    waiverAuditBlock,
    reviewText: reviewTextForPost,
  });
  const localShadowEligibility = evaluateLocalReviewShadowEligibility({
    labels,
    builderTag,
    reviewerModel: effectiveModel,
  });
  const localShadowRequest = localShadowEligibility.eligible
    ? persistLocalReviewShadowRequestFailOpen({
        log: console,
        rootDir: ROOT,
        repo,
        prNumber,
        headSha: reviewerHeadSha || null,
        builderTag,
        reviewerModel: effectiveModel,
        hostedReviewerIdentity: resolveReviewerIdentityForBotTokenEnv(
          effectiveBotTokenEnv,
          reviewerMetadata.reviewerIdentity
        ),
        eligibility: localShadowEligibility,
      })
    : { persisted: false, reason: localShadowEligibility.reason };
  logStructuredEvent(console, {
    event: 'local-review-shadow',
    level: localShadowEligibility.eligible ? 'info' : (hasLocalReviewShadowLabel(labels) ? 'warning' : 'info'),
    repo,
    prNumber,
    phase: 'request',
    eligible: localShadowEligibility.eligible,
    reason: localShadowEligibility.reason || null,
    requestPath: localShadowRequest.requestPath || null,
    localModel: localShadowEligibility.localModel || null,
    localFamily: localShadowEligibility.localFamily || null,
    builderTag: builderTag || null,
    reviewerModel: effectiveModel,
  });

  try {
    console.error(`[reviewer] DEBUG: posting GitHub review body length=${fullComment.length}; preview=${previewText(fullComment, 300)}`);
    // Use reviewDbAttemptNumber to match the row beginReviewerPass created
    // in watcher.spawnReviewer. reviewAttemptNumber (ledger.completedRoundsForPR + 1)
    // only advances on round completion, while reviewDbAttemptNumber
    // (review_attempts + 1) advances on every launch attempt — they diverge
    // on retry-within-round, and the row key is the launch-attempt counter.
    const captureAttemptNumber = Number.isFinite(Number(reviewDbAttemptNumber))
      ? Number(reviewDbAttemptNumber)
      : Number(reviewAttemptNumber);
    await postGitHubReviewWithCapture({
      rootDir: ROOT,
      repo,
      prNumber,
      attemptNumber: captureAttemptNumber,
      reviewerModel: effectiveModel,
      reviewerHeadSha: reviewerHeadSha || null,
      reviewBody: fullComment,
      botTokenEnv: effectiveBotTokenEnv,
      passKind,
      reviewerSpawnToken,
      reviewerIdentity: resolveReviewerIdentityForBotTokenEnv(
        effectiveBotTokenEnv,
        reviewerMetadata.reviewerIdentity
      ),
      execFileImpl: execFileAsync,
      log: console,
    });
    console.log(`[reviewer] Review posted to ${repo}#${prNumber}`);
  } catch (err) {
    console.error(`[reviewer] GITHUB POST FAILED for ${repo}#${prNumber}:`, err.message);
    process.exit(1);
  }

  const critical = isCritical(reviewText);
  const reviewPostedAt = new Date().toISOString();
  let postedLocalShadowRequest = null;
  if (localShadowRequest.persisted) {
    try {
      const marked = markLocalReviewShadowHostedPosted({
        rootDir: ROOT,
        request: localShadowRequest.request,
        hostedPostedAt: reviewPostedAt,
      });
      postedLocalShadowRequest = marked.request;
      logStructuredEvent(console, {
        event: 'local-review-shadow',
        level: 'info',
        repo,
        prNumber,
        phase: 'hosted-posted',
        requestPath: marked.requestPath,
      });
    } catch (err) {
      console.error(`[reviewer] WARN: failed to mark local shadow hosted-posted for ${repo}#${prNumber}: ${err.message}`);
    }
  }

  try {
    const baseBranch = typeof prContext?.baseRefName === 'string' ? prContext.baseRefName.trim() : '';
    const queued = queueFollowUpForPostedReview({
      rootDir: ROOT,
      repo,
      prNumber,
      baseBranch,
      revisionRef: reviewerHeadSha || null,
      reviewerModel: effectiveModel,
      builderTag,
      linearTicketId,
      reviewText: fullComment,
      reviewPostedAt,
      critical,
      verdictMode,
      scopeViolationFinding,
    });
    if (queued.queued) {
      console.log(`[reviewer] Follow-up handoff queued at ${queued.jobPath}`);
    } else {
      console.error(`[reviewer] Follow-up handoff skipped for ${repo}#${prNumber}: ${queued.reason}`);
    }
  } catch (err) {
    console.error(`[reviewer] Failed to queue follow-up handoff for ${repo}#${prNumber}:`, err.message);
  }

  if (postedLocalShadowRequest) {
    startLocalReviewShadowCompletion({
      rootDir: ROOT,
      request: postedLocalShadowRequest,
      diff,
      hostedReviewText: fullComment,
      extraContext,
      fetchImpl: globalThis.fetch,
      env: process.env,
      log: console,
    });
  }

  // 4. Update Linear (LAC-13)
  try {
    console.error(`[reviewer] DEBUG: updating Linear ticket ${linearTicketId || '<none>'}; critical=${critical}`);
    await linearTriage.recordReviewCompleted({
      domainId: 'code-pr',
      subjectExternalId: `${repo}#${prNumber}`,
      revisionRef: reviewerHeadSha || null,
      linearTicketId,
      labels,
      ticketPipelinePaused,
    }, {
      critical,
      reviewSummary: reviewText,
    });
  } catch (err) {
    console.error(`[reviewer] LINEAR UPDATE FAILED for ${linearTicketId}:`, err.message);
    // Non-fatal — review was posted, just log and continue
  }

  if (critical) {
    console.log(`[reviewer] CRITICAL issues detected in ${repo}#${prNumber} — Paul flagged in Linear`);
  }

  console.log(`[reviewer] Done: ${repo}#${prNumber}`);
}

const __test__ = {
  // Model-execution surface now lives in reviewer-harness.mjs; spread its
  // test handles so this module’s __test__ contract is unchanged.
  ...harnessTest,
  // Prompt assembly + codex token parsing (extracted leaves).
  buildAgyReviewerPromptPrefix,
  buildPromptForReviewerModel,
  buildReviewerPrompt,
  parseCodexJsonTokenUsage,
  // Artifact emission, GitHub posting, local-shadow review, and verdict-mode
  // helpers that remain in reviewer.mjs.
  ADVISORY_ONLY_REVIEW_LABEL,
  alertClioOversizedAgyFailure,
  buildReviewCommentBody,
  buildReviewCommentHeader,
  buildReviewerExtraContext,
  classifyReviewCommentHeader,
  completeLocalReviewShadowRequest,
  ensureLocalReviewShadowWritable,
  evaluateLocalReviewShadowEligibility,
  fetchCurrentHeadVerdictMode,
  fetchPRDiff,
  formatAdvisoryFindingsContext,
  formatLocalReviewShadowArtifact,
  hasLocalReviewShadowLabel,
  isRetryableGhTransportError,
  isReviewerPostAuthFailure,
  LOCAL_REVIEW_SHADOW_LABEL,
  LOCAL_REVIEW_SHADOW_MODEL_FAMILY_BY_MODEL,
  localReviewShadowPaths,
  markLocalReviewShadowHostedPosted,
  normalizeVerdictMode,
  persistLocalReviewShadowRequest,
  persistLocalReviewShadowRequestFailOpen,
  postGitHubReview,
  postGitHubReviewWithCapture,
  queueFollowUpForPostedReview,
  readJsonFileIfExists,
  reconcileLocalReviewShadow,
  resolveReviewerIdentityForBotTokenEnv,
  resolveVerdictModeForHead,
  shouldQueueFollowUpForReview,
  startLocalReviewShadowCompletion,
  startsWithReviewCommentHeader,
  VERDICT_MODE_ADVISORY_ONLY,
  VERDICT_MODE_ENFORCE,
};

export {
  CLAUDE_CLI,
  CODEX_CLI,
  GEMINI_CLI,
  AGY_CLI,
  assertClaudeOAuth,
  assertCodexOAuth,
  sanitizeCodexReviewPayload,
  buildReviewerPromptPrefix,
  spawnCaptured,
  resolveReviewerTimeoutMs,
  isFinalReviewRound,
  detectSpecTouchViolations,
  clearPendingReviewsForSelf,
  ADVERSARIAL_PROMPT,
  ADVERSARIAL_PROMPT_FINAL_ROUND_ADDENDUM,
  REVIEWER_DOMAIN_ID,
  REVIEWER_PROMPT_SET,
  __test__,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[reviewer] Unhandled error:', err);
    process.exit(1);
  });
}

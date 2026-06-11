/**
 * AMA-03 — Adversarial Merge Authority closer dispatch path.
 *
 * The watcher's settled-success hook calls `maybeDispatchAmaCloser`
 * BEFORE the existing merge-agent dispatch. When AMA is enabled and the
 * canonical eligibility predicate from SPEC §4.2 returns `eligible:true`,
 * this module dispatches a closer worker (`codex` or
 * `cfg.workerClass`) via `hq dispatch` and returns
 * `{ dispatched: true, lrqId, dispatchId }`. The caller skips the
 * merge-agent dispatch on that tick.
 *
 * When `cfg.enabled === false` OR the eligibility predicate fails, this
 * module is a no-op — returns `{ dispatched: false, reason }` and the
 * caller falls through to the existing merge-agent dispatch path
 * (preserved verbatim until AMA-06A/06N flips that around).
 *
 * Default-off discipline (SPEC §4.8):
 *
 *   - With no operator config, `cfg.enabled` is `false` per the
 *     AMA-01 schema defaults. The whole dispatch path is dark.
 *   - There is NO `enabled=true` fallthrough that overrides
 *     eligibility — the predicate is the only gate.
 *
 * @module ama/dispatch-closer
 */

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { writeFileAtomic } from '../atomic-write.mjs';
import { writeAmaAuditEntry } from './audit.mjs';
import { isEligibleForAmaClosure } from './eligibility.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SUBMODULE_ROOT = resolve(__dirname, '..', '..');

const DEFAULT_HQ_PATH = '/Users/airlock/.local/bin/hq';
const DEFAULT_HQ_ROOT = '/Users/airlock/agent-os-hq';
const DEFAULT_PROJECT = 'adversarial-merge-authority';
const TEMPLATE_PATH = join(SUBMODULE_ROOT, 'templates', 'ama-closer-prompt.md');
const AMA_CLOSER_DISPATCH_SCHEMA_VERSION = 1;
const AMA_CLOSER_DISPATCH_TRANSIENT_RETRY_DELAYS_MS = [1_000, 5_000];
const AMA_CLOSER_STATUS_TRANSIENT_RETRY_DELAYS_MS = [250, 1_000, 5_000];
const AMA_CLOSER_REDISPATCH_BOUND = 2;
const AMA_CLOSER_ACTIVE_STATUSES = new Set(['running', 'starting', 'blocked', 'stalled']);
const AMA_CLOSER_TERMINAL_HOLD_STATUSES = new Set(['succeeded']);
const AMA_CLOSER_RETRYABLE_STATUSES = new Set(['failed', 'cancelled', 'canceled', 'superseded', 'not-found']);

/**
 * @typedef {Object} DispatchResult
 * @property {boolean}  dispatched
 * @property {string=}  reason       — populated when `dispatched=false`.
 * @property {string[]=} reasons     — populated when `reason=not-eligible`.
 * @property {string=}  workerClass  — populated when `dispatched=true`.
 * @property {string=}  dispatchId   — populated when `dispatched=true`.
 * @property {string=}  launchRequestId — populated when `dispatched=true`.
 * @property {string=}  promptPath   — populated when `dispatched=true`.
 * @property {boolean=} skipMergeAgent — populated when AMA owns the
 * merge path for this tick even though no fresh launch occurred.
 */

function amaCloserDispatchDir(rootDir) {
  return join(rootDir, 'data', 'follow-up-jobs', 'ama-closer-dispatches');
}

function amaCloserPromptDir(rootDir) {
  return join(rootDir, 'data', 'follow-up-jobs', 'ama-closer-prompts');
}

function sanitizeDispatchPathSegment(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '-');
}

function amaCloserDispatchFilePath(rootDir, { repo, prNumber, headSha } = {}) {
  const safeRepo = sanitizeDispatchPathSegment(String(repo ?? '').replace(/\//g, '__'));
  const safeSha = sanitizeDispatchPathSegment(String(headSha || 'no-sha'));
  return join(
    amaCloserDispatchDir(rootDir),
    `${safeRepo}-pr-${Number(prNumber)}-${safeSha}.json`
  );
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readAmaCloserDispatchRecord(rootDir, identity) {
  return readJsonFile(amaCloserDispatchFilePath(rootDir, identity));
}

function writeAmaCloserDispatchRecord(rootDir, identity, doc) {
  mkdirSync(amaCloserDispatchDir(rootDir), { recursive: true });
  const filePath = amaCloserDispatchFilePath(rootDir, identity);
  writeFileAtomic(filePath, `${JSON.stringify(doc, null, 2)}\n`);
  return filePath;
}

function updateAmaCloserDispatchRecord(rootDir, identity, mutate) {
  const existing = readAmaCloserDispatchRecord(rootDir, identity);
  const next = mutate(existing ? { ...existing } : null);
  if (!next) return existing;
  writeAmaCloserDispatchRecord(rootDir, identity, next);
  return next;
}

function errorDiagnosticLines(err) {
  return [err?.message, err?.stderr, err?.stdout]
    .filter(Boolean)
    .flatMap((value) => String(value).split('\n'))
    .map(line => line.trim())
    .filter(Boolean);
}

function isExecTimeout(err) {
  return err?.code === 'ETIMEDOUT'
    || err?.killed === true
    || String(err?.message || '').toLowerCase().includes('timed out');
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

function resolveHqOwner(hqRoot) {
  if (!hqRoot) return null;
  const config = readJsonFile(join(hqRoot, '.hq', 'config.json'));
  const ownerUser = String(config?.ownerUser || '').trim();
  return ownerUser || null;
}

function hasAuthoritativeOwnerVisibility(asOwner) {
  return Boolean(String(asOwner || '').trim());
}

function isNotFoundDispatchStatusError(err) {
  if (!err) return false;
  const code = err.code ?? err.status ?? null;
  return (code === 1 || code === '1') && /no dispatch with id/i.test(String(err.stderr || ''));
}

function parseAmaCloserDispatchStatusOutput(stdout) {
  const parsed = parseAmaCloserDispatchOutput(stdout);
  const status = typeof parsed?.status === 'string'
    ? parsed.status.trim().toLowerCase()
    : null;
  return status ? { status } : null;
}

async function probeAmaCloserDispatchStatus({
  hqPath,
  launchRequestId,
  asOwner = null,
  execFileImpl = execFileAsync,
  env = {},
} = {}) {
  if (!hqPath || !launchRequestId) return null;
  const args = asOwner
    ? ['dispatch', 'status', launchRequestId, '--as-owner', asOwner]
    : ['dispatch', 'status', launchRequestId];
  for (let attempt = 0; attempt <= AMA_CLOSER_STATUS_TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const { stdout } = await execFileImpl(hqPath, args, {
        env: { ...env },
        maxBuffer: 1024 * 1024,
        timeout: 5_000,
      });
      const parsed = parseAmaCloserDispatchStatusOutput(stdout);
      if (parsed) return parsed;
      if (attempt < AMA_CLOSER_STATUS_TRANSIENT_RETRY_DELAYS_MS.length) {
        await sleep(AMA_CLOSER_STATUS_TRANSIENT_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return { status: 'unknown', degraded: true };
    } catch (err) {
      if (hasAuthoritativeOwnerVisibility(asOwner) && isNotFoundDispatchStatusError(err)) {
        return { status: 'not-found' };
      }
      if (isTransientHqDispatchError(err) && attempt < AMA_CLOSER_STATUS_TRANSIENT_RETRY_DELAYS_MS.length) {
        await sleep(AMA_CLOSER_STATUS_TRANSIENT_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return { status: 'unknown', degraded: true, error: err?.message || String(err) };
    }
  }
  return { status: 'unknown', degraded: true };
}

function parseAmaCloserDispatchOutput(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {}

  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines.slice(index).join('\n').trim();
    if (!candidate.startsWith('{')) continue;
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  let dispatchId = null;
  let launchRequestId = null;
  for (const line of lines) {
    const trimmed = line.trim();
    const dispatchMatch = /^dispatchId=([A-Za-z0-9_-]+)/.exec(trimmed);
    if (dispatchMatch) dispatchId = dispatchMatch[1];
    const lrqMatch = /^(?:launchRequestId|lrq)=([A-Za-z0-9_-]+)/.exec(trimmed);
    if (lrqMatch) launchRequestId = lrqMatch[1];
  }
  return (dispatchId || launchRequestId) ? { dispatchId, launchRequestId } : null;
}

function normalizeDispatchIdentifiers(payload) {
  if (!payload || typeof payload !== 'object') return { dispatchId: null, launchRequestId: null };
  return {
    dispatchId: String(payload.dispatchId || '').trim() || null,
    launchRequestId: String(payload.launchRequestId || payload.lrq || payload.dispatchId || '').trim() || null,
  };
}

/**
 * Substitute `<<PLACEHOLDER>>` markers in the template body.
 *
 * Pure string substitution — no escaping logic (the template author
 * controls the markup). The substituted values come from validated
 * inputs (PR number is numeric, reviewedSha is a Git SHA, etc.) so
 * the surface area for injection is bounded.
 *
 * @param {string} body
 * @param {Object<string, string|number>} substitutions
 * @returns {string}
 */
export function substituteTemplate(body, substitutions) {
  let out = body;
  for (const [key, value] of Object.entries(substitutions)) {
    const placeholder = new RegExp(`<<${key}>>`, 'g');
    out = out.replace(placeholder, String(value));
  }
  return out;
}

/**
 * Compose the closer worker prompt body from the substitutions the
 * dispatch site provides. Exported for the golden-snapshot test.
 *
 * @param {Object} args
 * @param {string} args.prUrl
 * @param {string} args.repo            — owner/name
 * @param {number} args.prNumber
 * @param {string} args.reviewedSha
 * @param {string} args.riskClass
 * @param {string} args.workerClass
 * @param {string} args.mergeMethod     — 'squash' | 'merge'
 * @param {string} args.requiredGateContext
 * @param {string} args.auditPath       — absolute path inside HQ_ROOT
 * @param {string} args.hqRoot          — HQ root path (closer passes to `ama-audit append --hq-root`)
 * @param {string} args.hqOwnerUser     — HQ owner user required for direct audit writes
 * @param {string} args.reviewedBy
 * @param {string} args.dispatchedAt    — ISO 8601 UTC
 * @param {string} args.templateBody    — raw template content
 * @returns {string}
 */
export function composeCloserPrompt({
  prUrl,
  repo,
  prNumber,
  reviewedSha,
  riskClass,
  workerClass,
  mergeMethod,
  requiredGateContext,
  auditPath,
  hqRoot,
  hqOwnerUser,
  reviewedBy,
  dispatchedAt,
  templateBody,
}) {
  return substituteTemplate(templateBody, {
    PR_URL: prUrl,
    REPO: repo,
    PR_NUMBER: prNumber,
    REVIEWED_SHA: reviewedSha,
    RISK_CLASS: riskClass,
    WORKER_CLASS: workerClass,
    MERGE_METHOD: mergeMethod,
    REQUIRED_GATE_CONTEXT: requiredGateContext,
    AUDIT_PATH: auditPath,
    HQ_ROOT: hqRoot,
    HQ_OWNER: hqOwnerUser,
    REVIEWED_BY: reviewedBy,
    DISPATCHED_AT: dispatchedAt,
  });
}

/**
 * Watcher's settled-success hook calls this BEFORE its existing
 * merge-agent dispatch. Returns `{ dispatched: true }` when AMA owns
 * the close; the caller skips merge-agent on that tick. Returns
 * `{ dispatched: false }` with a structured reason otherwise; the
 * caller falls through to the existing merge-agent dispatch path.
 *
 * @param {Object} args
 * @param {Object} args.reviewState
 * @param {Object} args.prMetadata
 * @param {Object} args.cfg              — resolved AMA cfg subtree (camelCase)
 * @param {Object=} args.options         — passed to the eligibility predicate
 * @param {Object} args.dispatchContext  — operator-controlled values
 * @param {string} args.dispatchContext.repo           owner/name (e.g. `acme/myrepo`)
 * @param {string} args.dispatchContext.prUrl          PR URL (e.g. `https://github.com/acme/myrepo/pull/123`)
 * @param {string} args.dispatchContext.reviewedSha    PR head SHA the watcher authorized
 * @param {string} args.dispatchContext.riskClass      resolved risk class
 * @param {string} args.dispatchContext.requiredGateContext
 * @param {string} args.dispatchContext.reviewedBy
 * @param {string} args.dispatchContext.parentSession
 * @param {string=} args.dispatchContext.hqProject
 * @param {string=} args.dispatchContext.hqPath
 * @param {string=} args.dispatchContext.hqRoot
 * @param {string=} args.dispatchContext.templatePath
 * @param {string=} args.dispatchContext.dispatchedAt  ISO 8601 UTC (caller-provided to keep the function deterministic for tests)
 * @param {Object=} args.execFileImpl    — DI for tests
 * @param {Object=} args.readTemplateImpl — DI for tests
 * @param {Object=} args.writeFileImpl   — DI for tests
 * @returns {Promise<DispatchResult>}
 */
export async function maybeDispatchAmaCloser({
  reviewState,
  prMetadata,
  cfg,
  options,
  dispatchContext,
  execFileImpl = execFileAsync,
  readTemplateImpl = null,
  writeFileImpl = null,
}) {
  // The master gate. With no operator config, this is `false` per
  // AMA-01 schema defaults and the entire path is a no-op.
  if (!cfg?.enabled) {
    return { dispatched: false, reason: 'ama-disabled' };
  }

  // The eligibility predicate is the second gate. There is no
  // fallthrough path that overrides it.
  const verdict = isEligibleForAmaClosure(reviewState, prMetadata, cfg, options);
  if (!verdict.eligible) {
    return {
      dispatched: false,
      reason: 'not-eligible',
      reasons: verdict.reasons,
    };
  }

  // Compose the prompt body. Template loaded from disk via DI so
  // tests can pass a literal.
  const templatePath = dispatchContext.templatePath || TEMPLATE_PATH;
  const templateBody = readTemplateImpl
    ? readTemplateImpl(templatePath)
    : readFileSync(templatePath, 'utf8');

  const repo = dispatchContext.repo;
  const prNumber = Number(prMetadata?.prNumber);
  const reviewedSha = dispatchContext.reviewedSha;
  const mergeMethod = String(cfg.mergeMethod || 'squash').toLowerCase();
  const rootDir = dispatchContext.rootDir || SUBMODULE_ROOT;
  const hqRoot = dispatchContext.hqRoot || DEFAULT_HQ_ROOT;
  const promptDir = dispatchContext.promptDir || amaCloserPromptDir(rootDir);
  const ownerUser = resolveHqOwner(hqRoot);
  const auditPath = join(
    hqRoot,
    'dispatch',
    'audit',
    'adversarial-merge-authority',
    `${repo.replace('/', '-')}-pr-${prNumber}-${reviewedSha}.json`,
  );
  const prompt = composeCloserPrompt({
    prUrl: dispatchContext.prUrl,
    repo,
    prNumber,
    reviewedSha,
    riskClass: dispatchContext.riskClass,
    workerClass: String(cfg.workerClass || 'codex'),
    mergeMethod,
    requiredGateContext: dispatchContext.requiredGateContext,
    auditPath,
    hqRoot,
    hqOwnerUser: ownerUser || 'unknown',
    reviewedBy: dispatchContext.reviewedBy,
    dispatchedAt: dispatchContext.dispatchedAt,
    templateBody,
  });

  const dispatchIdentity = { repo, prNumber, headSha: reviewedSha };
  const workerClass = String(cfg.workerClass || 'codex');
  const hqPath = dispatchContext.hqPath || process.env.HQ_BIN || DEFAULT_HQ_PATH;
  const hqProject = dispatchContext.hqProject || DEFAULT_PROJECT;
  const existingRecord = readAmaCloserDispatchRecord(rootDir, dispatchIdentity);
  if (existingRecord?.launchRequestId) {
    const statusProbe = await probeAmaCloserDispatchStatus({
      hqPath,
      launchRequestId: existingRecord.launchRequestId,
      asOwner: ownerUser,
      execFileImpl,
      env: process.env,
    });
    const status = statusProbe?.status || null;
    if (AMA_CLOSER_ACTIVE_STATUSES.has(status) || AMA_CLOSER_TERMINAL_HOLD_STATUSES.has(status)) {
      updateAmaCloserDispatchRecord(rootDir, dispatchIdentity, (current) => ({
        ...(current || existingRecord),
        lastObservedStatus: status,
        lastObservedAt: dispatchContext.dispatchedAt,
        lastError: statusProbe?.error || null,
      }));
      return {
        dispatched: false,
        skipMergeAgent: true,
        reason: `existing-dispatch-${status}`,
        workerClass: existingRecord.workerClass || workerClass,
        dispatchId: existingRecord.dispatchId || existingRecord.launchRequestId || null,
        launchRequestId: existingRecord.launchRequestId || null,
        promptPath: existingRecord.promptPath || null,
      };
    }
    if (status === 'unknown') {
      updateAmaCloserDispatchRecord(rootDir, dispatchIdentity, (current) => ({
        ...(current || existingRecord),
        lastObservedStatus: status,
        lastObservedAt: dispatchContext.dispatchedAt,
        lastError: statusProbe?.error || 'dispatch-status-unknown',
      }));
      return {
        dispatched: false,
        reason: 'dispatch-status-unknown',
        workerClass: existingRecord.workerClass || workerClass,
        dispatchId: existingRecord.dispatchId || existingRecord.launchRequestId || null,
        launchRequestId: existingRecord.launchRequestId || null,
        promptPath: existingRecord.promptPath || null,
      };
    }
    if (!AMA_CLOSER_RETRYABLE_STATUSES.has(status)) {
      return { dispatched: false, reason: `dispatch-status-${status || 'unknown'}` };
    }
  } else if (existingRecord && Number(existingRecord.retryCount || 0) >= AMA_CLOSER_REDISPATCH_BOUND) {
    return { dispatched: false, reason: 'dispatch-retry-exhausted' };
  }

  // Persist the prompt under watcher-owned repo state and pass that path
  // to `hq dispatch --prompt`. This avoids cross-user writes into HQ_ROOT.
  const promptPath = join(
    promptDir,
    `${repo.replace('/', '-')}-pr-${prNumber}-${reviewedSha}.md`,
  );
  if (writeFileImpl) {
    writeFileImpl(promptDir, promptPath, prompt);
  } else {
    mkdirSync(promptDir, { recursive: true });
    writeFileSync(promptPath, prompt, { encoding: 'utf8' });
  }

  writeAmaAuditEntry({
    hqRoot,
    repo,
    prNumber,
    headSha: reviewedSha,
    attempt: { outcome: 'in_progress' },
    metadata: {
      reviewedBy: dispatchContext.reviewedBy,
      reviewSha: reviewedSha,
      reviewerEvidence: {
        reviewerLogin: dispatchContext.reviewedBy || null,
        reviewSha: reviewedSha,
      },
      operatorApprovalEvidence: reviewState?.operatorApprovedEvidence || null,
      mergeAgentRequestedEvidence: options?.mergeAgentRequested || null,
      requiredGateContexts: dispatchContext.requiredGateContext
        ? [dispatchContext.requiredGateContext]
        : [],
      riskClass: dispatchContext.riskClass,
      riskClassSource: 'watcher-review-state',
      eligibilityReasons: verdict.reasons.length
        ? verdict.reasons
        : [
            'latest-review-settled-success',
            'head-sha-matches-review',
            'risk-class-permitted',
            'ci-green',
            'branch-protection-gate-present',
          ],
      mergeMethod,
      reconciliation: {
        needsRepair: false,
      },
    },
    now: dispatchContext.dispatchedAt,
  });

  const priorRetryCount = Number(existingRecord?.retryCount || 0);
  writeAmaCloserDispatchRecord(rootDir, dispatchIdentity, {
    schemaVersion: AMA_CLOSER_DISPATCH_SCHEMA_VERSION,
    repo,
    prNumber,
    headSha: reviewedSha,
    workerClass,
    promptPath,
    promptDir,
    hqRoot,
    lastAttemptedAt: dispatchContext.dispatchedAt,
    dispatchedAt: null,
    dispatchId: existingRecord?.dispatchId || null,
    launchRequestId: existingRecord?.launchRequestId || null,
    retryCount: priorRetryCount + 1,
    state: 'dispatching',
    lastObservedStatus: existingRecord?.lastObservedStatus || null,
    lastObservedAt: existingRecord?.lastObservedAt || null,
    lastError: null,
  });

  // `hq dispatch` args mirror the existing merge-agent dispatch (see
  // src/follow-up-merge-agent.mjs around line 3866). Differences:
  //
  //   - `--worker-class` reads from cfg (default `codex`); merge-agent
  //     uses the `merge-agent` resolver.
  //   - `--task-kind merge` matches merge-agent.
  //   - `--completion-shape decision-only` because the closer worker
  //     writes the audit JSON artifact; it does NOT open a PR. This
  //     prevents the dispatcher from injecting the default `pr`
  //     close-out (CLAUDE.md §"_apply_prompt_closeouts").
  //   - `--project adversarial-merge-authority` to keep audit + token
  //     accounting separate from the merge-agent stream.
  //   - `--ticket AMA-PR-<n>` so the launch is traceable per-PR.
  const args = [
    'dispatch',
    '--worker-class', workerClass,
    '--task-kind', 'merge',
    '--completion-shape', 'decision-only',
    '--project', hqProject,
    '--repo', repo.split('/')[1] || repo,
    '--pr', String(prNumber),
    '--ticket', `AMA-PR-${prNumber}`,
    '--parent-session', dispatchContext.parentSession,
    '--prompt', promptPath,
    '--root', hqRoot,
  ];

  let execResult;
  let transientRetryIndex = 0;
  for (;;) {
    try {
      execResult = await execFileImpl(hqPath, args, {
        env: process.env,
        maxBuffer: 5 * 1024 * 1024,
        timeout: 90_000,
        killSignal: 'SIGTERM',
      });
      break;
    } catch (err) {
      if (isTransientHqDispatchError(err) && transientRetryIndex < AMA_CLOSER_DISPATCH_TRANSIENT_RETRY_DELAYS_MS.length) {
        const delayMs = Number(AMA_CLOSER_DISPATCH_TRANSIENT_RETRY_DELAYS_MS[transientRetryIndex]) || 0;
        transientRetryIndex += 1;
        await sleep(delayMs);
        continue;
      }
      const parsedFailure = normalizeDispatchIdentifiers(parseAmaCloserDispatchOutput(err?.stdout || ''));
      const ambiguousLaunch = Boolean(parsedFailure.launchRequestId || parsedFailure.dispatchId);
      updateAmaCloserDispatchRecord(rootDir, dispatchIdentity, (current) => ({
        ...(current || {}),
        schemaVersion: AMA_CLOSER_DISPATCH_SCHEMA_VERSION,
        repo,
        prNumber,
        headSha: reviewedSha,
        workerClass,
        promptPath,
        promptDir,
        hqRoot,
        lastAttemptedAt: dispatchContext.dispatchedAt,
        dispatchedAt: ambiguousLaunch ? dispatchContext.dispatchedAt : null,
        dispatchId: parsedFailure.dispatchId,
        launchRequestId: parsedFailure.launchRequestId,
        retryCount: Number(current?.retryCount || priorRetryCount + 1),
        state: ambiguousLaunch ? 'dispatched' : 'dispatch-failed',
        lastObservedStatus: ambiguousLaunch ? 'unknown' : null,
        lastObservedAt: ambiguousLaunch ? dispatchContext.dispatchedAt : null,
        lastError: String(err?.stderr || err?.message || err),
      }));
      return {
        dispatched: false,
        skipMergeAgent: ambiguousLaunch || (
          isTransientHqDispatchError(err)
          && Number((existingRecord?.retryCount || 0) + 1) < AMA_CLOSER_REDISPATCH_BOUND
        ),
        reason: ambiguousLaunch ? 'dispatch-response-ambiguous' : 'dispatch-failed',
        error: String(err?.stderr || err?.message || err),
        workerClass,
        dispatchId: parsedFailure.dispatchId || null,
        launchRequestId: parsedFailure.launchRequestId || null,
        promptPath,
      };
    }
  }

  const parsed = normalizeDispatchIdentifiers(parseAmaCloserDispatchOutput(execResult?.stdout || ''));
  updateAmaCloserDispatchRecord(rootDir, dispatchIdentity, (current) => ({
    ...(current || {}),
    schemaVersion: AMA_CLOSER_DISPATCH_SCHEMA_VERSION,
    repo,
    prNumber,
    headSha: reviewedSha,
    workerClass,
    promptPath,
    promptDir,
    hqRoot,
    lastAttemptedAt: dispatchContext.dispatchedAt,
    dispatchedAt: dispatchContext.dispatchedAt,
    dispatchId: parsed.dispatchId,
    launchRequestId: parsed.launchRequestId,
    retryCount: Number(current?.retryCount || priorRetryCount + 1),
    state: 'dispatched',
    lastObservedStatus: 'starting',
    lastObservedAt: dispatchContext.dispatchedAt,
    lastError: null,
  }));

  return {
    dispatched: true,
    workerClass,
    dispatchId: parsed.dispatchId || parsed.launchRequestId || null,
    launchRequestId: parsed.launchRequestId || null,
    promptPath,
    eligibilityReasons: verdict.reasons,
  };
}

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

import { amaAuditPath, buildAmaInProgressRecord, readAmaAuditRecord, writeAmaAuditRecord } from './audit.mjs';
import { isEligibleForAmaClosure } from './eligibility.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SUBMODULE_ROOT = resolve(__dirname, '..', '..');

const DEFAULT_HQ_PATH = '/Users/airlock/.local/bin/hq';
const DEFAULT_HQ_ROOT = '/Users/airlock/agent-os-hq';
const DEFAULT_PROJECT = 'adversarial-merge-authority';
const TEMPLATE_PATH = join(SUBMODULE_ROOT, 'templates', 'ama-closer-prompt.md');
const HQ_DISPATCH_TIMEOUT_MS = 90_000;
const HQ_DISPATCH_TRANSIENT_RETRY_DELAYS_MS = [1_000, 5_000];

/**
 * @typedef {Object} DispatchResult
 * @property {boolean}  dispatched
 * @property {string=}  reason       — populated when `dispatched=false`.
 * @property {string[]=} reasons     — populated when `reason=not-eligible`.
 * @property {string=}  workerClass  — populated when `dispatched=true`.
 * @property {string=}  dispatchId   — populated when `dispatched=true`.
 * @property {string=}  promptPath   — populated when `dispatched=true`.
 */

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
 * @param {string} args.mergeMethod     — 'squash' | 'merge'
 * @param {string} args.requiredGateContext
 * @param {string} args.auditPath       — absolute path inside HQ_ROOT
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
  mergeMethod,
  requiredGateContext,
  auditPath,
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
    MERGE_METHOD: mergeMethod,
    REQUIRED_GATE_CONTEXT: requiredGateContext,
    AUDIT_PATH: auditPath,
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
  const hqRoot = dispatchContext.hqRoot || DEFAULT_HQ_ROOT;
  const auditPath = amaAuditPath({
    hqRoot,
    repo,
    prNumber,
    headSha: reviewedSha,
  });
  const prompt = composeCloserPrompt({
    prUrl: dispatchContext.prUrl,
    repo,
    prNumber,
    reviewedSha,
    riskClass: dispatchContext.riskClass,
    mergeMethod,
    requiredGateContext: dispatchContext.requiredGateContext,
    auditPath,
    reviewedBy: dispatchContext.reviewedBy,
    dispatchedAt: dispatchContext.dispatchedAt,
    templateBody,
  });

  // Persist the prompt under `<hqRoot>/dispatch/ama-closer-prompts/`
  // so `hq dispatch --prompt <path>` can read it. The directory mirrors
  // the existing `merge-agent-prompts/` convention.
  const promptDir = join(hqRoot, 'dispatch', 'ama-closer-prompts');
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

  const hqPath = dispatchContext.hqPath || process.env.HQ_BIN || DEFAULT_HQ_PATH;
  const hqProject = dispatchContext.hqProject || DEFAULT_PROJECT;
  const workerClass = String(cfg.workerClass || 'codex');
  const now = dispatchContext.dispatchedAt || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const existingRecord = readAmaAuditRecord(auditPath);
  if (existingRecord?.status === 'in_progress') {
    return {
      dispatched: true,
      workerClass,
      dispatchId: existingRecord?.closerDispatch?.dispatchId || null,
      launchRequestId: existingRecord?.closerDispatch?.launchRequestId || null,
      promptPath,
      auditPath,
      existingDispatch: true,
      eligibilityReasons: verdict.trace,
    };
  }

  const auditRecord = buildAmaInProgressRecord({
    repo,
    prNumber,
    headSha: reviewedSha,
    reviewState,
    prMetadata,
    dispatchContext,
    eligibilityReasons: verdict.reasons,
    now,
  });
  writeAmaAuditRecord(auditPath, auditRecord);

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

  let parsed;
  try {
    parsed = await dispatchAmaWithRetry({ execFileImpl, hqPath, args });
  } catch (err) {
    // Surface the error to the caller. The watcher's existing catch
    // block treats this as a fall-through to the merge-agent path so
    // the PR isn't stranded by an AMA dispatch failure.
    writeAmaAuditRecord(auditPath, {
      ...auditRecord,
      status: 'deferred',
      deferredReason: 'dispatch-failed',
      dispatchFailure: String(err?.message || err),
      reconciliation: {
        ...auditRecord.reconciliation,
        lastVerifiedAt: now,
      },
    });
    return {
      dispatched: false,
      reason: 'dispatch-failed',
      error: String(err?.stderr || err?.message || err),
    };
  }

  const nextAuditRecord = {
    ...auditRecord,
    closerDispatch: {
      workerClass,
      dispatchId: parsed?.dispatchId || null,
      launchRequestId: parsed?.lrq || parsed?.launchRequestId || null,
      dispatchedAt: now,
      promptPath,
    },
  };
  writeAmaAuditRecord(auditPath, nextAuditRecord);

  return {
    dispatched: true,
    workerClass,
    dispatchId: parsed?.dispatchId || null,
    launchRequestId: parsed?.lrq || parsed?.launchRequestId || null,
    promptPath,
    auditPath,
    eligibilityReasons: verdict.trace,
  };
}

/**
 * Parse the dispatchId from `hq dispatch` stdout. Format the helper
 * emits is `dispatchId=<id>\n` (single line, key=value). Robust to
 * other lines around it. Returns null on parse failure — the caller
 * treats null as "dispatch succeeded but we lost the id"; the watcher
 * will re-issue via duplicate-dispatch protection on the next tick.
 *
 * @param {string} stdout
 * @returns {string|null}
 */
function parseDispatchOutput(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) {
    throw new Error('hq dispatch returned empty stdout');
  }
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
  for (const line of lines) {
    const match = /^dispatchId=([A-Za-z0-9_\-]+)/.exec(line.trim());
    if (match) return { dispatchId: match[1] };
  }
  throw new Error('hq dispatch did not return machine-readable JSON');
}

function formatExecFailure(command, err) {
  const stderrText = String(err?.stderr ?? '').trim();
  const stdoutText = String(err?.stdout ?? '').trim();
  const augmented = new Error(
    `${command} failed (exit code ${err?.code ?? 'unknown'}): ${err?.message || 'no message'}`
    + (stderrText ? `\n  stderr:\n${stderrText.split('\n').map((line) => `    ${line}`).join('\n')}` : '')
    + (stdoutText ? `\n  stdout:\n${stdoutText.split('\n').map((line) => `    ${line}`).join('\n')}` : '')
  );
  augmented.code = err?.code;
  augmented.stderr = err?.stderr;
  augmented.stdout = err?.stdout;
  augmented.cause = err;
  return augmented;
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
  ].filter(Boolean).join('\n').toLowerCase();
  return /\b(etimedout|econnreset|econnrefused|ehostunreach|eagain|epipe)\b/.test(detail)
    || detail.includes('database is locked')
    || detail.includes('sqlite_busy')
    || detail.includes('resource temporarily unavailable')
    || detail.includes('temporary failure')
    || detail.includes('temporarily unavailable');
}

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function dispatchAmaWithRetry({ execFileImpl, hqPath, args }) {
  let transientRetryIndex = 0;
  for (;;) {
    try {
      const { stdout } = await execFileImpl(hqPath, args, {
        env: process.env,
        maxBuffer: 5 * 1024 * 1024,
        timeout: HQ_DISPATCH_TIMEOUT_MS,
        killSignal: 'SIGTERM',
      });
      return parseDispatchOutput(stdout);
    } catch (err) {
      if (isTransientHqDispatchError(err) && transientRetryIndex < HQ_DISPATCH_TRANSIENT_RETRY_DELAYS_MS.length) {
        const delayMs = Number(HQ_DISPATCH_TRANSIENT_RETRY_DELAYS_MS[transientRetryIndex]) || 0;
        transientRetryIndex += 1;
        await sleep(delayMs);
        continue;
      }
      throw formatExecFailure('hq dispatch', err);
    }
  }
}

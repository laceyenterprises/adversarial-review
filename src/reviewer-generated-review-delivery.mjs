// REVPOSTSTALL-01: a generated review must survive a stalled delivery.
//
// Between "Review generated" and the GitHub write, reviewer.mjs makes
// read-only side calls: the token refresh, the current-head verdict-mode read,
// scope reads and head grounding. On 2026-11-03 a completed Gemini review
// (adversarial-review#1700) logged "Review generated" and posted nothing for
// 20+ minutes. In the same second, the deployed API-call log recorded an
// unscoped default-credential core throttle sleep of about 57 minutes. Nothing
// bounded that phase except the whole-process deadline. That deadline throws
// the finished review away, and the retry pays for the model again.
//
// This module:
//   1. preserves the generated review, bound to its exact head, reviewer
//      identity, pass, prompt stage and diff, before any pre-post side call;
//   2. bounds the pre-write delivery phase. On expiry it exits with the
//      existing uncharged `[reviewer-stalled]` class, but only while no
//      GitHub write has started, so this process cannot publish late;
//   3. lets the next same-head claim redeliver the preserved review through
//      the normal post path (verdict mode, grounding, scope gates, exact-head
//      post, capture) without rerunning the model.
//
// A record whose write has started is never redelivered blindly. That write
// is ambiguous, and the existing post reconciliation and capture controls own
// it. Redelivery keeps the original execution and attribution: a retry's
// session cannot claim the original model run.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { writeFileAtomic } from './atomic-write.mjs';
import { loadAwareTimeoutMs, timerDelayMs } from './load-aware-timeout.mjs';
import { validateReviewerAttribution } from './reviewer-attribution.mjs';

const SCHEMA_VERSION = 1;
const GENERATED_REVIEW_DIR_PARTS = ['data', 'reviewer-generated-reviews'];
// Healthy pre-write side calls take seconds. Transient gh/adapter retries can
// take several minutes, so the nominal bound leaves room for them. Host load
// scales it, capped so a loaded host still frees the reviewer slot.
const DELIVERY_DEADLINE_NOMINAL_MS = 10 * 60 * 1000;
const DELIVERY_DEADLINE_MAX_MS = 20 * 60 * 1000;
// The parent's process timer started before this process armed its own
// deadline. Leave margin so the uncharged deferral wins that race.
const PROCESS_DEADLINE_MARGIN_MS = 60 * 1000;
const MIN_DELIVERY_DEADLINE_MS = 1000;
const REDELIVERY_TOKEN_USAGE_SOURCE = 'preserved-review-redelivery';
const DELIVERY_STATES = Object.freeze(['pending-delivery', 'deferred', 'write-started', 'delivered']);
const REUSABLE_STATES = new Set(['pending-delivery', 'deferred']);
const BINDING_FIELDS = Object.freeze([
  'repo', 'prNumber', 'headSha', 'passKind', 'reviewerModel', 'botTokenEnv',
  'reviewAttemptNumber', 'promptStage', 'verdictOnly', 'diffSha256',
]);

function sha256(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

function normalizeHeadSha(value) {
  const head = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(head) ? head : null;
}

function repoSlug(repo) {
  return String(repo).replaceAll('/', '--');
}

function headPrefix(binding) {
  return `${repoSlug(binding.repo)}-${binding.prNumber}-${binding.headSha}-`;
}

function recordFileName(binding, sessionUuid) {
  const session = String(sessionUuid || 'unknown-session').replace(/[^A-Za-z0-9_.-]/g, '_');
  return `${headPrefix(binding)}${binding.passKind}-${binding.reviewerModel}-${session}.json`;
}

function generatedReviewDir(rootDir) {
  return join(rootDir, ...GENERATED_REVIEW_DIR_PARTS);
}

function resolveDeliveryDeadlineMs({
  env = process.env,
  processDeadlineAt = null,
  now = Date.now,
  loadAwareTimeoutMsImpl = loadAwareTimeoutMs,
} = {}) {
  const configured = Number.parseInt(String(env.ADVERSARIAL_REVIEW_DELIVERY_DEADLINE_MS ?? ''), 10);
  let deadlineMs = Number.isInteger(configured) && configured > 0
    ? configured
    : loadAwareTimeoutMsImpl(DELIVERY_DEADLINE_NOMINAL_MS, { maxMs: DELIVERY_DEADLINE_MAX_MS });
  if (Number.isFinite(processDeadlineAt)) {
    deadlineMs = Math.min(deadlineMs, processDeadlineAt - now() - PROCESS_DEADLINE_MARGIN_MS);
  }
  return timerDelayMs(Math.max(MIN_DELIVERY_DEADLINE_MS, deadlineMs));
}

function zeroRedeliveryTokenUsage() {
  return {
    input: 0, output: 0, reasoning: null, cacheRead: null, cacheWrite: 0,
    toolContext: null, total: 0, source: REDELIVERY_TOKEN_USAGE_SOURCE,
  };
}

function safeAttribution(value) {
  if (!value) return null;
  try {
    return validateReviewerAttribution(value);
  } catch {
    return null;
  }
}

function createGeneratedReviewDelivery({
  rootDir,
  repo,
  prNumber,
  headSha,
  passKind,
  reviewerModel,
  botTokenEnv,
  reviewAttemptNumber,
  promptStage,
  verdictOnly = false,
  diff,
  sessionUuid = null,
  reviewDbAttemptNumber = null,
  env = process.env,
  log = console,
  now = Date.now,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  exitImpl = (code) => process.exit(code),
  writeFileAtomicImpl = writeFileAtomic,
  readFileImpl = readFileSync,
  readdirImpl = readdirSync,
  loadAwareTimeoutMsImpl = loadAwareTimeoutMs,
} = {}) {
  const normalizedHead = normalizeHeadSha(headSha);
  const binding = normalizedHead ? {
    repo: String(repo),
    prNumber: Number(prNumber),
    headSha: normalizedHead,
    passKind: String(passKind || 'first-pass'),
    reviewerModel: String(reviewerModel),
    botTokenEnv: String(botTokenEnv),
    reviewAttemptNumber: Number.isFinite(Number(reviewAttemptNumber)) ? Number(reviewAttemptNumber) : null,
    promptStage: String(promptStage || ''),
    verdictOnly: verdictOnly === true,
    diffSha256: sha256(diff),
  } : null;
  const dir = generatedReviewDir(rootDir);
  let activeRecordPath = null;
  let activeRecord = null;
  let reusedRecord = false;

  function writeRecord(record) {
    writeFileAtomicImpl(activeRecordPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    activeRecord = record;
  }

  function updateRecord(patch) {
    if (!activeRecordPath || !activeRecord) return false;
    try {
      writeRecord({ ...activeRecord, ...patch(activeRecord) });
      return true;
    } catch (err) {
      log.warn?.(`[reviewer] REVPOSTSTALL-01: generated review record update failed for ${repo}#${prNumber}: ${err?.message || err}`);
      return false;
    }
  }

  function bindingMismatch(record) {
    return BINDING_FIELDS.filter((field) => record?.[field] !== binding[field]);
  }

  // The newest same-head, same-binding record that has not reached the GitHub
  // write. Mismatched or write-started records are left as evidence.
  function readReusable() {
    if (!binding) return null;
    let names;
    try {
      names = readdirImpl(dir).filter((name) => name.startsWith(headPrefix(binding)) && name.endsWith('.json'));
    } catch (err) {
      if (err?.code !== 'ENOENT') log.warn?.(`[reviewer] REVPOSTSTALL-01: generated review store unreadable: ${err?.message || err}`);
      return null;
    }
    const candidates = [];
    for (const name of names) {
      const path = join(dir, name);
      let record;
      try {
        record = JSON.parse(readFileImpl(path, 'utf8'));
      } catch {
        log.warn?.(`[reviewer] REVPOSTSTALL-01: ignoring unreadable generated review record ${name}`);
        continue;
      }
      if (record?.schemaVersion !== SCHEMA_VERSION) continue;
      const mismatched = bindingMismatch(record);
      if (mismatched.length) {
        if (record.passKind === binding.passKind && record.reviewerModel === binding.reviewerModel) {
          log.log?.(`[reviewer] REVPOSTSTALL-01: preserved review ${name} not reused; binding differs on ${mismatched.join(',')}`);
        }
        continue;
      }
      if (record.deliveryState === 'write-started') {
        log.warn?.(
          `[reviewer] REVPOSTSTALL-01: preserved review ${name} reached a GitHub write in session ${record.writeStartedSessionUuid || 'unknown'}; `
          + 'not redelivering blindly (existing post reconciliation owns that outcome)'
        );
        continue;
      }
      if (!REUSABLE_STATES.has(record.deliveryState)) continue;
      if (typeof record.rawReviewText !== 'string' || sha256(record.rawReviewText) !== record.rawReviewSha256) {
        log.warn?.(`[reviewer] REVPOSTSTALL-01: preserved review ${name} failed its body digest; not reused`);
        continue;
      }
      const cachedTextValid = record.reviewText === null
        ? record.reviewTextSha256 === null
        : typeof record.reviewText === 'string' && sha256(record.reviewText) === record.reviewTextSha256;
      if (!cachedTextValid) {
        log.warn?.(`[reviewer] REVPOSTSTALL-01: preserved review ${name} failed its cached text digest; not reused`);
        continue;
      }
      if (record.reviewerAttribution && !safeAttribution(record.reviewerAttribution)) {
        log.warn?.(`[reviewer] REVPOSTSTALL-01: preserved review ${name} carries invalid attribution; not reused`);
        continue;
      }
      candidates.push({ path, record });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => String(b.record.generatedAt).localeCompare(String(a.record.generatedAt)));
    const { path, record } = candidates[0];
    activeRecordPath = path;
    activeRecord = record;
    reusedRecord = true;
    updateRecord((current) => ({
      redeliveries: [...(current.redeliveries || []), { sessionUuid, reviewDbAttemptNumber, startedAt: new Date(now()).toISOString() }],
    }));
    log.log?.(JSON.stringify({
      ts: new Date(now()).toISOString(),
      event: 'reviewer-generated-review-redelivery',
      repo: binding.repo, prNumber: binding.prNumber, headSha: binding.headSha,
      passKind: binding.passKind, reviewerModel: binding.reviewerModel,
      originSessionUuid: record.originSessionUuid || null, sessionUuid,
      generatedAt: record.generatedAt, priorDeferrals: (record.deferrals || []).length,
      record: relative(rootDir, path),
    }));
    return {
      reviewText: typeof record.reviewText === 'string' ? record.reviewText : undefined,
      rawReviewText: record.rawReviewText,
      needsSanitize: record.needsSanitize === true,
      chunked: record.chunked === true,
      elisions: Array.isArray(record.elisions) ? record.elisions : [],
      execution: record.execution ?? null,
      tokenUsage: zeroRedeliveryTokenUsage(),
      reviewerAttribution: record.reviewerAttribution ? safeAttribution(record.reviewerAttribution) : null,
      preservedRedelivery: { originSessionUuid: record.originSessionUuid || null, record: relative(rootDir, path) },
    };
  }

  // Initial preservation is best-effort. Once reusable bytes exist, the
  // write-started checkpoint below must be durable before public effects.
  // The record binds the model and identity that actually produced the review:
  // an oversized-route fallback can change both after dispatch began.
  function preserve({
    rawReviewText, dispatch = {}, execution = null, reviewerAttribution = null,
    reviewerModel: producedBy = binding?.reviewerModel, botTokenEnv: producedFor = binding?.botTokenEnv,
  } = {}) {
    if (!binding || reusedRecord) return Boolean(reusedRecord);
    if (typeof rawReviewText !== 'string' || !rawReviewText.trim()) return false;
    const recordBinding = { ...binding, reviewerModel: String(producedBy), botTokenEnv: String(producedFor) };
    activeRecordPath = join(dir, recordFileName(recordBinding, sessionUuid));
    try {
      writeRecord({
        schemaVersion: SCHEMA_VERSION,
        ...recordBinding,
        originSessionUuid: sessionUuid,
        originReviewDbAttemptNumber: reviewDbAttemptNumber ?? null,
        generatedAt: new Date(now()).toISOString(),
        deliveryState: 'pending-delivery',
        rawReviewText,
        rawReviewSha256: sha256(rawReviewText),
        reviewText: typeof dispatch.reviewText === 'string' ? dispatch.reviewText : null,
        reviewTextSha256: typeof dispatch.reviewText === 'string' ? sha256(dispatch.reviewText) : null,
        needsSanitize: dispatch.needsSanitize === true,
        chunked: dispatch.chunked === true,
        elisions: Array.isArray(dispatch.elisions) ? dispatch.elisions : [],
        execution,
        reviewerAttribution: safeAttribution(reviewerAttribution),
        deferrals: [],
        redeliveries: [],
      });
      return true;
    } catch (err) {
      activeRecordPath = null;
      activeRecord = null;
      log.warn?.(`[reviewer] REVPOSTSTALL-01: failed to preserve generated review for ${repo}#${prNumber}: ${err?.message || err}`);
      return false;
    }
  }

  function armDeliveryDeadline({ processDeadlineAt = null } = {}) {
    const deadlineMs = resolveDeliveryDeadlineMs({ env, processDeadlineAt, now, loadAwareTimeoutMsImpl });
    const armedAt = now();
    const phases = [];
    let current = null;
    let writeStarted = false;
    let settled = false;
    let timer = null;

    function phaseReceipt() {
      return phases.map(({ phase, startedAt, durationMs }) => ({
        phase, startedAt: new Date(startedAt).toISOString(), durationMs: durationMs ?? null,
      }));
    }

    function expire() {
      timer = null;
      if (settled || writeStarted) return;
      settled = true;
      const at = now();
      const phase = current?.phase || 'generated';
      const preserved = updateRecord((record) => ({
        deliveryState: 'deferred',
        deferrals: [...(record.deferrals || []), {
          sessionUuid, at: new Date(at).toISOString(), phase, elapsedMs: at - armedAt, deadlineMs,
        }],
      }));
      log.error?.(`[reviewer-delivery-stall] ${JSON.stringify({
        event: 'reviewer-delivery-stalled',
        repo, prNumber, headSha: binding?.headSha || null, passKind, reviewerModel, sessionUuid,
        originSessionUuid: activeRecord?.originSessionUuid || null,
        phase, phaseStartedAt: current ? new Date(current.startedAt).toISOString() : null,
        armedAt: new Date(armedAt).toISOString(), decidedAt: new Date(at).toISOString(),
        elapsedMs: at - armedAt, deadlineMs, phases: phaseReceipt(),
        preserved, record: preserved ? relative(rootDir, activeRecordPath) : null,
      })}`);
      log.error?.(
        `[reviewer-stalled] Command timed out after ${deadlineMs}ms (review delivery deadline before GitHub write; `
        + `phase=${phase}; generated review ${preserved ? 'preserved for exact-head redelivery' : 'not preserved'})`
      );
      exitImpl(1);
    }

    timer = setTimeoutImpl(expire, deadlineMs);
    timer?.unref?.();

    function clear() {
      if (timer) clearTimeoutImpl(timer);
      timer = null;
    }

    let deliveredAt = null;
    return {
      deadlineMs,
      get deferred() { return settled && !writeStarted && deliveredAt === null; },
      get writeStarted() { return writeStarted; },
      get deliveredAt() { return deliveredAt; },
      // Records phase timing; the side call itself is unchanged.
      track(phase, promise) {
        const entry = { phase, startedAt: now(), durationMs: null };
        phases.push(entry);
        current = entry;
        return Promise.resolve(promise).finally(() => { entry.durationMs = now() - entry.startedAt; });
      },
      // Called synchronously immediately before the GitHub review write. From
      // here the post path's own timeouts and reconciliation own the outcome.
      markWriteStarted() {
        if (writeStarted || settled) return;
        const at = now();
        // Once a reusable record exists, its write boundary must be durable
        // before any public effect. Otherwise a later claim could replay a
        // review that posted before body capture. Initial preservation stays
        // best-effort when there is no reusable record to invalidate.
        if (activeRecord && !updateRecord(() => ({
          deliveryState: 'write-started',
          writeStartedAt: new Date(at).toISOString(),
          writeStartedSessionUuid: sessionUuid,
        }))) {
          const error = new Error('[reviewer-stalled] Preserved review write checkpoint unavailable before GitHub write; retry exact-head delivery');
          error.code = 'generated-review-write-checkpoint-failed';
          error.reviewerStalled = true;
          throw error;
        }
        writeStarted = true;
        clear();
        phases.push({ phase: 'github-write', startedAt: at, durationMs: null });
        current = phases.at(-1);
      },
      delivered() {
        if (settled && !writeStarted) return;
        settled = true;
        clear();
        const at = now();
        if (current && current.durationMs === null && current.phase === 'github-write') current.durationMs = at - current.startedAt;
        deliveredAt = new Date(at).toISOString();
        updateRecord(() => ({
          deliveryState: 'delivered',
          deliveredAt,
          deliveredSessionUuid: sessionUuid,
          deliveryPhases: phaseReceipt(),
        }));
        log.log?.(JSON.stringify({
          ts: deliveredAt, event: 'reviewer-delivery-phases', repo, prNumber,
          headSha: binding?.headSha || null, sessionUuid, redelivery: reusedRecord,
          elapsedMs: at - armedAt, deadlineMs, phases: phaseReceipt(),
        }));
      },
    };
  }

  return {
    binding,
    get recordPath() { return activeRecordPath; },
    readReusable,
    preserve,
    armDeliveryDeadline,
  };
}

export {
  DELIVERY_DEADLINE_MAX_MS,
  DELIVERY_DEADLINE_NOMINAL_MS,
  DELIVERY_STATES,
  GENERATED_REVIEW_DIR_PARTS,
  PROCESS_DEADLINE_MARGIN_MS,
  REDELIVERY_TOKEN_USAGE_SOURCE,
  createGeneratedReviewDelivery,
  resolveDeliveryDeadlineMs,
};

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { HANDOFF_EVENTS, recordHandoffEvent } from './handoff-telemetry.mjs';

export const HANDOFF_RATE_CAP_AUDIT_EVENT = 'handoff_rate_cap_hit';
export const DEFAULT_HANDOFF_RATE_CAP_AUDIT_PATH_SEGMENTS = [
  'data',
  'handoff-wake',
  'rate-cap-audit.jsonl',
];
export const DEFAULT_HANDOFF_RATE_CAP_RETENTION_MS = 24 * 60 * 60 * 1000;

function normalizeText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizePrNumber(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeSubject(payload = {}) {
  const safePayload = payload && typeof payload === 'object' ? payload : {};
  const repo = normalizeText(safePayload.repo);
  const prNumber = normalizePrNumber(safePayload.prNumber ?? safePayload.pr_number);
  const headSha = normalizeText(
    safePayload.headSha
    ?? safePayload.head_sha
    ?? safePayload.revisionRef
    ?? safePayload.revision_ref
  );
  if (!repo || !prNumber || !headSha) return null;
  return { repo, prNumber, headSha };
}

export function handoffRateCapAuditPath(rootDir) {
  return join(rootDir, ...DEFAULT_HANDOFF_RATE_CAP_AUDIT_PATH_SEGMENTS);
}

export function normalizeHandoffMaxPerPrHead(value, fallback = 20) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return fallback;
}

function normalizeRetentionMs(value, fallback = DEFAULT_HANDOFF_RATE_CAP_RETENTION_MS) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
}

function normalizeTimestampMs(value) {
  if (value instanceof Date) return value.getTime();
  if (Number.isFinite(value)) return Number(value);
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function createHandoffRateLimiter({
  maxPerPrHead = 20,
  retentionMs = DEFAULT_HANDOFF_RATE_CAP_RETENTION_MS,
  rootDir = null,
  auditPath = rootDir ? handoffRateCapAuditPath(rootDir) : null,
  now = () => new Date().toISOString(),
  logger = console,
  recordHandoffEventImpl = recordHandoffEvent,
} = {}) {
  const counts = new Map();
  let effectiveMax = normalizeHandoffMaxPerPrHead(maxPerPrHead);
  let effectiveRetentionMs = normalizeRetentionMs(retentionMs);

  function pruneCounts(nowMs) {
    for (const [key, entry] of counts.entries()) {
      if (nowMs - entry.lastSeenMs > effectiveRetentionMs) {
        counts.delete(key);
      }
    }
  }

  function writeAudit(entry) {
    const payload = `${JSON.stringify(entry)}\n`;
    if (auditPath) {
      try {
        mkdirSync(dirname(auditPath), { recursive: true });
        appendFileSync(auditPath, payload, 'utf8');
      } catch (err) {
        logger?.warn?.(`[handoff] rate-cap audit write failed: ${err?.message || err}`);
      }
    }
    logger?.warn?.(
      `[handoff] ${HANDOFF_RATE_CAP_AUDIT_EVENT} repo=${entry.repo} pr=${entry.pr_number} ` +
      `head=${String(entry.head_sha).slice(0, 12)} count=${entry.count} max=${entry.max_per_pr_head}`
    );
  }

  return {
    get maxPerPrHead() {
      return effectiveMax;
    },
    setMaxPerPrHead(value) {
      effectiveMax = normalizeHandoffMaxPerPrHead(value, effectiveMax);
      return effectiveMax;
    },
    setRetentionMs(value) {
      effectiveRetentionMs = normalizeRetentionMs(value, effectiveRetentionMs);
      return effectiveRetentionMs;
    },
    inspect(payload) {
      const inspectedAt = now();
      const inspectedAtMs = normalizeTimestampMs(inspectedAt);
      pruneCounts(inspectedAtMs);
      const subject = normalizeSubject(payload);
      if (!subject) {
        return { accepted: true, reason: 'unkeyed-wake' };
      }
      const key = `${subject.repo}\0${subject.prNumber}\0${subject.headSha}`;
      const count = (counts.get(key)?.count || 0) + 1;
      counts.set(key, { count, lastSeenMs: inspectedAtMs });
      if (count <= effectiveMax) {
        return { accepted: true, reason: 'within-cap', count, maxPerPrHead: effectiveMax, subject };
      }
      const audit = {
        event: HANDOFF_RATE_CAP_AUDIT_EVENT,
        at: inspectedAt,
        repo: subject.repo,
        pr_number: subject.prNumber,
        head_sha: subject.headSha,
        count,
        max_per_pr_head: effectiveMax,
      };
      writeAudit(audit);
      try {
        recordHandoffEventImpl({
          rootDir,
          event: HANDOFF_EVENTS.rateCapHit,
          at: inspectedAt,
          step: safePayloadReason(payload),
          repo: subject.repo,
          prNumber: subject.prNumber,
          headSha: subject.headSha,
          extra: {
            count,
            max_per_pr_head: effectiveMax,
          },
        });
      } catch {
        // Rate-cap enforcement must not depend on telemetry writes.
      }
      return {
        accepted: false,
        reason: HANDOFF_RATE_CAP_AUDIT_EVENT,
        count,
        maxPerPrHead: effectiveMax,
        subject,
        audit,
      };
    },
    snapshot() {
      return new Map([...counts.entries()].map(([key, entry]) => [key, entry.count]));
    },
  };
}

function safePayloadReason(payload) {
  return payload && typeof payload === 'object' ? payload.reason || null : null;
}

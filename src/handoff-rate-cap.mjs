import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const HANDOFF_RATE_CAP_AUDIT_EVENT = 'handoff_rate_cap_hit';
export const DEFAULT_HANDOFF_RATE_CAP_AUDIT_PATH_SEGMENTS = [
  'data',
  'handoff-wake',
  'rate-cap-audit.jsonl',
];

function normalizeText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizePrNumber(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeSubject(payload = {}) {
  const repo = normalizeText(payload.repo);
  const prNumber = normalizePrNumber(payload.prNumber ?? payload.pr_number);
  const headSha = normalizeText(
    payload.headSha
    ?? payload.head_sha
    ?? payload.revisionRef
    ?? payload.revision_ref
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

export function createHandoffRateLimiter({
  maxPerPrHead = 20,
  rootDir = null,
  auditPath = rootDir ? handoffRateCapAuditPath(rootDir) : null,
  now = () => new Date().toISOString(),
  logger = console,
} = {}) {
  const counts = new Map();
  let effectiveMax = normalizeHandoffMaxPerPrHead(maxPerPrHead);

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
    inspect(payload) {
      const subject = normalizeSubject(payload);
      if (!subject) {
        return { accepted: true, reason: 'unkeyed-wake' };
      }
      const key = `${subject.repo}\0${subject.prNumber}\0${subject.headSha}`;
      const count = (counts.get(key) || 0) + 1;
      counts.set(key, count);
      if (count <= effectiveMax) {
        return { accepted: true, reason: 'within-cap', count, maxPerPrHead: effectiveMax, subject };
      }
      const audit = {
        event: HANDOFF_RATE_CAP_AUDIT_EVENT,
        at: now(),
        repo: subject.repo,
        pr_number: subject.prNumber,
        head_sha: subject.headSha,
        count,
        max_per_pr_head: effectiveMax,
      };
      writeAudit(audit);
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
      return new Map(counts);
    },
  };
}

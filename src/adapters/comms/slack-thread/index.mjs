/**
 * Slack-thread JSONL fixture implementation of the comms-channel adapter.
 *
 * @typedef {import('../../../kernel/contracts.d.ts').CommsChannelAdapter} CommsChannelAdapter
 * @typedef {import('../../../kernel/contracts.d.ts').DeliveryKey} DeliveryKey
 * @typedef {import('../../../kernel/contracts.d.ts').DeliveryRecord} DeliveryRecord
 * @typedef {import('../../../kernel/contracts.d.ts').DeliveryReceipt} DeliveryReceipt
 * @typedef {import('../../../kernel/contracts.d.ts').OperatorEvent} OperatorEvent
 * @typedef {import('../../../kernel/contracts.d.ts').RemediationReply} RemediationReply
 * @typedef {import('../../../kernel/contracts.d.ts').Verdict} Verdict
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const DEFAULT_TRANSCRIPT_FILE = 'slack-thread.jsonl';
const DEFAULT_TRANSCRIPT_DIR = '.slack-thread-transcripts';
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5000;

function isoString(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value || new Date().toISOString());
}

function assertRootDir(rootDir) {
  if (!rootDir) throw new Error('slack-thread comms adapter requires rootDir');
  return resolve(rootDir);
}

function stableStringify(value) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function normalizeDeliveryKey(deliveryKey, { event = null } = {}) {
  const domainId = deliveryKey?.domainId ?? deliveryKey?.domain_id ?? null;
  const subjectExternalId = deliveryKey?.subjectExternalId ?? deliveryKey?.subject_external_id ?? null;
  const revisionRef = deliveryKey?.revisionRef ?? deliveryKey?.revision_ref ?? null;
  const round = Number(deliveryKey?.round);
  const kind = deliveryKey?.kind ?? deliveryKey?.deliveryKind ?? deliveryKey?.delivery_kind ?? null;
  const noticeRef = kind === 'operator-notice'
    ? (
      deliveryKey?.noticeRef
      ?? deliveryKey?.notice_ref
      ?? event?.eventExternalId
      ?? event?.type
      ?? null
    )
    : null;

  if (!domainId || !subjectExternalId || !revisionRef || !Number.isInteger(round) || round < 0 || !kind) {
    throw new TypeError('Delivery key must include domainId, subjectExternalId, revisionRef, round, and kind');
  }
  if (kind === 'operator-notice' && !noticeRef) {
    throw new TypeError('Operator notice delivery keys must include noticeRef or a stable operator event id/type');
  }

  return {
    domainId,
    subjectExternalId,
    revisionRef,
    round,
    kind,
    ...(noticeRef ? { noticeRef } : {}),
  };
}

function readTranscriptLines(transcriptPath) {
  if (!existsSync(transcriptPath)) return [];
  return readFileSync(transcriptPath, 'utf8')
    .split(/\n/)
    .filter((line) => line.trim());
}

function keyEquals(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function lineToDeliveryRecord(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return {
    key: parsed.key,
    deliveryExternalId: parsed.deliveryExternalId,
    attemptedAt: parsed.attemptedAt,
    deliveredAt: parsed.deliveredAt,
    delivered: parsed.delivered === true,
    ...(parsed.failureReason ? { failureReason: parsed.failureReason } : {}),
  };
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(lockPath) {
  const startedAt = Date.now();
  while (true) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx' });
      return;
    } catch (err) {
      if (err?.code !== 'EEXIST') {
        throw err;
      }
      if ((Date.now() - startedAt) >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for slack-thread lock: ${lockPath}`);
      }
      sleepMs(LOCK_RETRY_MS);
    }
  }
}

function withExclusiveLock(lockPath, callback) {
  mkdirSync(dirname(lockPath), { recursive: true });
  acquireLock(lockPath);
  try {
    return callback();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

function sanitizePathSegments(subjectExternalId) {
  return String(subjectExternalId || '')
    .split(/[\\/]+/u)
    .filter(Boolean)
    .map((segment) => segment.replace(/[^A-Za-z0-9._-]/gu, '_'))
    .filter((segment) => segment && segment !== '.' && segment !== '..');
}

function deliveryExternalIdForKey(key) {
  const digest = createHash('sha256')
    .update(stableStringify(key))
    .digest('hex');
  return `comms-slack-thread:${digest}`;
}

/**
 * @param {{
 *   rootDir?: string,
 *   transcriptPath?: string,
 *   transcriptFile?: string,
 *   now?: () => Date | string,
 * }} options
 * @returns {CommsChannelAdapter}
 */
function createSlackThreadCommsAdapter({
  rootDir,
  transcriptPath = null,
  transcriptFile = DEFAULT_TRANSCRIPT_FILE,
  now = () => new Date(),
} = {}) {
  const root = assertRootDir(rootDir);

  function transcriptPathForKey(key) {
    if (transcriptPath) {
      return resolve(transcriptPath);
    }
    const subjectSegments = sanitizePathSegments(key?.subjectExternalId);
    if (subjectSegments.length === 0) {
      throw new Error('slack-thread delivery key subjectExternalId must resolve to a subject transcript path');
    }
    return join(root, DEFAULT_TRANSCRIPT_DIR, ...subjectSegments, transcriptFile);
  }

  function lockPathForTranscript(transcriptPathValue) {
    return `${transcriptPathValue}.lock`;
  }

  function appendDelivery({ key, payload }) {
    const resolvedTranscriptPath = transcriptPathForKey(key);
    return withExclusiveLock(lockPathForTranscript(resolvedTranscriptPath), () => {
      mkdirSync(dirname(resolvedTranscriptPath), { recursive: true });
      const existing = readTranscriptLines(resolvedTranscriptPath)
        .map(lineToDeliveryRecord)
        .filter(Boolean)
        .find((record) => keyEquals(record.key, key));
      if (existing) {
        return {
          key,
          deliveryExternalId: existing.deliveryExternalId,
          deliveredAt: existing.deliveredAt,
        };
      }

      const deliveredAt = isoString(now());
      const deliveryExternalId = deliveryExternalIdForKey(key);
      const record = {
        adapter: 'comms-slack-thread',
        attemptedAt: deliveredAt,
        delivered: true,
        deliveredAt,
        deliveryExternalId,
        key,
        payload,
      };
      appendFileSync(resolvedTranscriptPath, `${stableStringify(record)}\n`, 'utf8');
      return {
        key,
        deliveryExternalId,
        deliveredAt,
      };
    });
  }

  async function postReview(verdict, deliveryKey) {
    const key = normalizeDeliveryKey(deliveryKey);
    return appendDelivery({
      key,
      payload: {
        type: 'reviewer-verdict',
        verdict,
      },
    });
  }

  async function postRemediationReply(reply, deliveryKey) {
    const key = normalizeDeliveryKey(deliveryKey);
    return appendDelivery({
      key,
      payload: {
        type: 'remediation-reply',
        reply,
      },
    });
  }

  async function postOperatorNotice(event, body, deliveryKey) {
    const key = normalizeDeliveryKey(deliveryKey, { event });
    return appendDelivery({
      key,
      payload: {
        type: 'operator-notice',
        event,
        body: String(body || ''),
      },
    });
  }

  async function lookupExistingDeliveries(deliveryKey) {
    const key = normalizeDeliveryKey(deliveryKey);
    return readTranscriptLines(transcriptPathForKey(key))
      .map(lineToDeliveryRecord)
      .filter(Boolean)
      .filter((record) => keyEquals(record.key, key));
  }

  return {
    postReview,
    postRemediationReply,
    postOperatorNotice,
    lookupExistingDeliveries,
  };
}

export {
  DEFAULT_TRANSCRIPT_FILE,
  createSlackThreadCommsAdapter,
  normalizeDeliveryKey,
  stableStringify,
};

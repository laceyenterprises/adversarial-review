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

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const DEFAULT_TRANSCRIPT_FILE = 'slack-thread.jsonl';

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
  const noticeRef = deliveryKey?.noticeRef
    ?? deliveryKey?.notice_ref
    ?? (kind === 'operator-notice' ? (event?.eventExternalId || event?.type || null) : null);

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
  const parsed = JSON.parse(line);
  return {
    key: parsed.key,
    deliveryExternalId: parsed.deliveryExternalId,
    attemptedAt: parsed.attemptedAt,
    deliveredAt: parsed.deliveredAt,
    delivered: parsed.delivered === true,
    ...(parsed.failureReason ? { failureReason: parsed.failureReason } : {}),
  };
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
  const resolvedTranscriptPath = transcriptPath
    ? resolve(transcriptPath)
    : join(root, transcriptFile);

  function appendDelivery({ key, payload }) {
    mkdirSync(dirname(resolvedTranscriptPath), { recursive: true });
    const priorCount = readTranscriptLines(resolvedTranscriptPath).length;
    const deliveredAt = isoString(now());
    const deliveryExternalId = `comms-slack-thread:${priorCount + 1}`;
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
    return readTranscriptLines(resolvedTranscriptPath)
      .map(lineToDeliveryRecord)
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

/**
 * Slack-thread implementation of the comms-channel adapter.
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
import { redactPublicSafeText } from '../github-pr-comments/redaction.mjs';

const DEFAULT_TRANSCRIPT_FILE = 'slack-thread.jsonl';
const DEFAULT_TRANSCRIPT_DIR = '.slack-thread-transcripts';
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5000;
const SLACK_API_URL = 'https://slack.com/api/chat.postMessage';

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
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function acquireLock(lockPath) {
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
      await sleepMs(LOCK_RETRY_MS);
    }
  }
}

async function withExclusiveLock(lockPath, callback) {
  mkdirSync(dirname(lockPath), { recursive: true });
  await acquireLock(lockPath);
  try {
    return await callback();
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

function resolveSlackConfig({ channelId, threadTs, token, env }) {
  return {
    channelId: String(channelId ?? env?.ADVERSARIAL_REVIEW_SLACK_CHANNEL_ID ?? '').trim(),
    threadTs: String(threadTs ?? env?.ADVERSARIAL_REVIEW_SLACK_THREAD_TS ?? '').trim(),
    token: String(token ?? env?.SLACK_BOT_TOKEN ?? env?.ADVERSARIAL_REVIEW_SLACK_BOT_TOKEN ?? '').trim(),
  };
}

function createSlackWebApiClient({
  token,
  channelId,
  threadTs,
  fetchImpl = globalThis.fetch,
  apiUrl = SLACK_API_URL,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('slack-thread comms adapter requires fetch or a slackClient');
  }
  if (!token) {
    throw new Error('slack-thread comms adapter requires SLACK_BOT_TOKEN or ADVERSARIAL_REVIEW_SLACK_BOT_TOKEN');
  }
  if (!channelId) {
    throw new Error('slack-thread comms adapter requires ADVERSARIAL_REVIEW_SLACK_CHANNEL_ID');
  }

  return {
    async postMessage({ text }) {
      const response = await fetchImpl(apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          channel: channelId,
          text,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          unfurl_links: false,
          unfurl_media: false,
        }),
      });
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (!response.ok || data?.ok !== true) {
        const reason = data?.error || `${response.status} ${response.statusText}`.trim();
        throw new Error(`Slack chat.postMessage failed: ${reason}`);
      }
      const ts = data?.ts ? String(data.ts) : '';
      const channel = data?.channel ? String(data.channel) : channelId;
      return {
        deliveryExternalId: ts ? `slack:${channel}:${ts}` : `slack:${channel}`,
      };
    },
  };
}

function renderReviewMessage(verdict) {
  return redactPublicSafeText(String(verdict?.body ?? verdict?.summary ?? ''), 40_000);
}

function redactJsonValue(value, limit = 2000) {
  if (typeof value === 'string') return redactPublicSafeText(value, limit);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, limit));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .map(([key, entryValue]) => [key, redactJsonValue(entryValue, limit)]),
  );
}

function normalizeRemediationReplyForDelivery(reply) {
  return redactJsonValue({
    kind: reply?.kind,
    schemaVersion: reply?.schemaVersion,
    jobId: reply?.jobId,
    outcome: reply?.outcome,
    summary: reply?.summary,
    validation: reply?.validation,
    addressed: reply?.addressed,
    nonBlocking: reply?.nonBlocking,
    pushback: reply?.pushback,
    blockers: reply?.blockers,
    operationalBlockers: reply?.operationalBlockers,
    reReview: reply?.reReview,
  });
}

function renderOperatorNoticeMessage({ event, body }) {
  return redactPublicSafeText(stableStringify({
    type: 'operator-notice',
    event: redactJsonValue(event),
    body: String(body || ''),
  }), 40_000);
}

/**
 * @param {{
 *   rootDir?: string,
 *   transcriptPath?: string,
 *   transcriptFile?: string,
 *   slackClient?: { postMessage: (message: { key: DeliveryKey, text: string, payload: unknown }) => Promise<{ deliveryExternalId?: string, ts?: string, channel?: string } | string> },
 *   token?: string,
 *   channelId?: string,
 *   threadTs?: string,
 *   fetchImpl?: typeof fetch,
 *   env?: NodeJS.ProcessEnv,
 *   now?: () => Date | string,
 * }} options
 * @returns {CommsChannelAdapter}
 */
function createSlackThreadCommsAdapter({
  rootDir,
  transcriptPath = null,
  transcriptFile = DEFAULT_TRANSCRIPT_FILE,
  slackClient = null,
  token = null,
  channelId = null,
  threadTs = null,
  fetchImpl = globalThis.fetch,
  env = process.env,
  now = () => new Date(),
} = {}) {
  const root = assertRootDir(rootDir);
  const slackConfig = resolveSlackConfig({ channelId, threadTs, token, env });
  const client = slackClient || createSlackWebApiClient({
    ...slackConfig,
    fetchImpl,
  });

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

  async function deliverToSlack({ key, text, payload }) {
    const result = await client.postMessage({ key, text, payload });
    if (typeof result === 'string') return result;
    if (result?.deliveryExternalId) return String(result.deliveryExternalId);
    if (result?.ts) return `slack:${result.channel || slackConfig.channelId}:${result.ts}`;
    return deliveryExternalIdForKey(key);
  }

  async function appendDelivery({ key, payload, text }) {
    const resolvedTranscriptPath = transcriptPathForKey(key);
    return withExclusiveLock(lockPathForTranscript(resolvedTranscriptPath), async () => {
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

      const attemptedAt = isoString(now());
      const deliveryExternalId = await deliverToSlack({ key, text, payload });
      const deliveredAt = isoString(now());
      const record = {
        adapter: 'comms-slack-thread',
        attemptedAt,
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
        verdict: {
          ...verdict,
          body: renderReviewMessage(verdict),
          ...(verdict?.summary !== undefined ? { summary: redactPublicSafeText(verdict.summary, 2000) } : {}),
        },
      },
      text: renderReviewMessage(verdict),
    });
  }

  async function postRemediationReply(reply, deliveryKey) {
    const key = normalizeDeliveryKey(deliveryKey);
    const safeReply = normalizeRemediationReplyForDelivery(reply);
    return appendDelivery({
      key,
      payload: {
        type: 'remediation-reply',
        reply: safeReply,
      },
      text: redactPublicSafeText(stableStringify(safeReply), 40_000),
    });
  }

  async function postOperatorNotice(event, body, deliveryKey) {
    const key = normalizeDeliveryKey(deliveryKey, { event });
    return appendDelivery({
      key,
      payload: {
        type: 'operator-notice',
        event: redactJsonValue(event),
        body: redactPublicSafeText(String(body || ''), 40_000),
      },
      text: renderOperatorNoticeMessage({ event, body }),
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
  createSlackWebApiClient,
  createSlackThreadCommsAdapter,
  deliveryExternalIdForKey,
  normalizeDeliveryKey,
  stableStringify,
};

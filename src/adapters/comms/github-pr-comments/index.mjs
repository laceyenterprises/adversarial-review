/**
 * GitHub Pull Request comments implementation of the comms-channel adapter.
 *
 * @typedef {import('../../../kernel/contracts.d.ts').CommsChannelAdapter} CommsChannelAdapter
 * @typedef {import('../../../kernel/contracts.d.ts').DeliveryKey} DeliveryKey
 * @typedef {import('../../../kernel/contracts.d.ts').DeliveryRecord} DeliveryRecord
 * @typedef {import('../../../kernel/contracts.d.ts').DeliveryReceipt} DeliveryReceipt
 * @typedef {import('../../../kernel/contracts.d.ts').OperatorEvent} OperatorEvent
 * @typedef {import('../../../kernel/contracts.d.ts').RemediationReply} RemediationReply
 * @typedef {import('../../../kernel/contracts.d.ts').Verdict} Verdict
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  ensureReviewStateSchema,
  lookupReviewRowDualRead,
  openReviewStateDb,
} from '../../../review-state.mjs';
import { CODE_PR_DOMAIN_ID } from '../../../identity-shapes.mjs';
import { parseCommentUrlFromStdout } from './pr-comments.mjs';
import { redactPublicSafeText } from './redaction.mjs';

const execFileAsync = promisify(execFile);
const COMMENT_DELIVERIES_SCHEMA_VERSION = 1;

function splitRepo(repoPath) {
  const [owner, repo] = String(repoPath || '').split('/');
  if (!owner || !repo) {
    throw new TypeError(`Invalid GitHub repo slug: ${repoPath}`);
  }
  return { owner, repo };
}

function parseSubjectExternalId(subjectExternalId) {
  const raw = String(subjectExternalId || '').trim();
  const match = /^([^#/]+\/[^#/]+)#(\d+)$/.exec(raw);
  if (!match) {
    throw new TypeError(`Invalid GitHub PR subjectExternalId: ${subjectExternalId}`);
  }
  return {
    repo: match[1],
    prNumber: Number(match[2]),
  };
}

function isoString(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value || new Date().toISOString());
}

function normalizeDeliveryKey(deliveryKey, { event = null } = {}) {
  const domainId = deliveryKey?.domainId ?? deliveryKey?.domain_id ?? null;
  const subjectExternalId = deliveryKey?.subjectExternalId ?? deliveryKey?.subject_external_id ?? null;
  const revisionRef = deliveryKey?.revisionRef ?? deliveryKey?.revision_ref ?? null;
  const round = Number(deliveryKey?.round);
  const kind = deliveryKey?.kind ?? deliveryKey?.deliveryKind ?? deliveryKey?.delivery_kind ?? null;
  const noticeRef = deliveryKey?.noticeRef
    ?? deliveryKey?.notice_ref
    ?? (kind === 'operator-notice'
      ? (event?.eventExternalId || event?.type || null)
      : null);

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

function ensureCommentDeliverySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS comment_deliveries (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      domain_id           TEXT NOT NULL,
      subject_external_id TEXT NOT NULL,
      revision_ref        TEXT NOT NULL,
      round               INTEGER NOT NULL,
      delivery_kind       TEXT NOT NULL,
      notice_ref          TEXT,
      delivery_external_id TEXT,
      attempted_at        TEXT NOT NULL,
      delivered_at        TEXT,
      delivered           INTEGER NOT NULL DEFAULT 0,
      failure_reason      TEXT,
      legacy_repo         TEXT,
      legacy_pr_number    INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS comment_deliveries_typed_key_unique
      ON comment_deliveries(
        domain_id,
        subject_external_id,
        revision_ref,
        round,
        delivery_kind,
        COALESCE(notice_ref, '')
      );

    CREATE INDEX IF NOT EXISTS comment_deliveries_subject_lookup_idx
      ON comment_deliveries(domain_id, subject_external_id, revision_ref);
  `);

  const current = Number(db.pragma('user_version', { simple: true }) || 0);
  if (current < COMMENT_DELIVERIES_SCHEMA_VERSION) {
    db.pragma(`user_version = ${COMMENT_DELIVERIES_SCHEMA_VERSION}`);
  }
}

function openDeliveryDb(rootDir) {
  if (!rootDir) return null;
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  ensureCommentDeliverySchema(db);
  return db;
}

function rowToDeliveryRecord(row) {
  return {
    key: {
      domainId: row.domain_id,
      subjectExternalId: row.subject_external_id,
      revisionRef: row.revision_ref,
      round: Number(row.round),
      kind: row.delivery_kind,
      ...(row.notice_ref ? { noticeRef: row.notice_ref } : {}),
    },
    deliveryExternalId: row.delivery_external_id || '',
    attemptedAt: row.attempted_at,
    deliveredAt: row.delivered_at || row.attempted_at,
    delivered: Boolean(row.delivered),
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
  };
}

function legacyRowToDeliveryRecord(row, key) {
  return {
    key,
    deliveryExternalId: `legacy-reviewed-pr:${row.id ?? `${row.repo}#${row.pr_number}`}`,
    attemptedAt: row.last_attempted_at || row.reviewed_at,
    deliveredAt: row.posted_at || row.reviewed_at,
    delivered: row.review_status !== 'failed',
  };
}

function insertDeliveryRecord(db, {
  key,
  deliveryExternalId,
  attemptedAt,
  deliveredAt,
  delivered,
  failureReason = null,
}) {
  const { repo, prNumber } = parseSubjectExternalId(key.subjectExternalId);
  db.prepare(
    `INSERT OR IGNORE INTO comment_deliveries
       (domain_id, subject_external_id, revision_ref, round, delivery_kind,
        notice_ref, delivery_external_id, attempted_at, delivered_at, delivered,
        failure_reason, legacy_repo, legacy_pr_number)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    key.domainId,
    key.subjectExternalId,
    key.revisionRef,
    key.round,
    key.kind,
    key.noticeRef || null,
    deliveryExternalId || null,
    attemptedAt,
    deliveredAt || null,
    delivered ? 1 : 0,
    failureReason,
    repo,
    prNumber
  );
}

function renderVerdictBody(verdict) {
  return String(verdict?.body ?? verdict?.summary ?? '');
}

function renderRemediationReplyBody(reply) {
  if (reply?.body) return String(reply.body);
  const lines = ['### Remediation Worker Reply', ''];
  if (reply?.summary) {
    lines.push('**Summary**', '', String(reply.summary), '');
  }
  if (Array.isArray(reply?.validation) && reply.validation.length > 0) {
    lines.push('**Validation**', '');
    for (const item of reply.validation) lines.push(`- ${String(item)}`);
    lines.push('');
  }
  if (Array.isArray(reply?.blockers) && reply.blockers.length > 0) {
    lines.push('**Blockers**', '');
    for (const item of reply.blockers) {
      lines.push(`- ${typeof item === 'string' ? item : (item?.finding || item?.reasoning || JSON.stringify(item))}`);
    }
  }
  return lines.join('\n').trim();
}

/**
 * @param {{
 *   octokit?: any,
 *   rootDir?: string,
 *   execFileImpl?: typeof execFileAsync,
 *   commentTimeoutMs?: number,
 *   now?: () => Date | string,
 *   log?: Console,
 * }} options
 * @returns {CommsChannelAdapter & {
 *   deliverReviewComment(verdict: Verdict, deliveryKey: DeliveryKey): Promise<DeliveryReceipt>,
 *   deliverRemediationReply(reply: RemediationReply, deliveryKey: DeliveryKey): Promise<DeliveryReceipt>,
 *   deliverOperatorNotice(event: OperatorEvent, body: string, deliveryKey: DeliveryKey): Promise<DeliveryReceipt>,
 *   loadPriorDeliveriesForSubject(deliveryKey: DeliveryKey): Promise<readonly DeliveryRecord[]>,
 * }}
 */
function createGitHubPRCommentsAdapter({
  octokit = null,
  rootDir = null,
  execFileImpl = execFileAsync,
  commentTimeoutMs = 30_000,
  now = () => new Date(),
  log = console,
} = {}) {
  async function postRawComment({ key, body }) {
    const { repo, prNumber } = parseSubjectExternalId(key.subjectExternalId);
    const safeBody = redactPublicSafeText(body, 60_000);

    if (octokit?.rest?.issues?.createComment) {
      const { owner, repo: repoName } = splitRepo(repo);
      const { data } = await octokit.rest.issues.createComment({
        owner,
        repo: repoName,
        issue_number: prNumber,
        body: safeBody,
      });
      return {
        deliveryExternalId: String(data?.id ?? data?.html_url ?? data?.url ?? `${repo}#${prNumber}`),
        deliveredBody: safeBody,
      };
    }

    const result = await execFileImpl('gh', [
      'pr',
      'comment',
      String(prNumber),
      '--repo',
      repo,
      '--body',
      safeBody,
    ], {
      maxBuffer: 5 * 1024 * 1024,
      timeout: commentTimeoutMs,
      killSignal: 'SIGTERM',
    });
    return {
      deliveryExternalId: parseCommentUrlFromStdout(result?.stdout) || `${repo}#${prNumber}:${Date.now()}`,
      deliveredBody: safeBody,
    };
  }

  async function lookupExistingDeliveries(deliveryKey) {
    const key = normalizeDeliveryKey(deliveryKey);
    const db = openDeliveryDb(rootDir);
    if (!db) return [];
    try {
      const rows = db.prepare(
        `SELECT *
           FROM comment_deliveries
          WHERE domain_id = ?
            AND subject_external_id = ?
            AND revision_ref = ?
            AND round = ?
            AND delivery_kind = ?
            AND COALESCE(notice_ref, '') = COALESCE(?, '')
          ORDER BY id DESC`
      ).all(
        key.domainId,
        key.subjectExternalId,
        key.revisionRef,
        key.round,
        key.kind,
        key.noticeRef || null
      );
      if (rows.length > 0) return rows.map(rowToDeliveryRecord);

      if (key.domainId === CODE_PR_DOMAIN_ID && (key.kind === 'review' || key.kind === 'review-verdict')) {
        const { repo, prNumber } = parseSubjectExternalId(key.subjectExternalId);
        const legacy = lookupReviewRowDualRead(db, {
          repo,
          prNumber,
          domainId: key.domainId,
          subjectExternalId: key.subjectExternalId,
          revisionRef: key.revisionRef,
        });
        if (legacy.found && legacy.row) {
          return [legacyRowToDeliveryRecord(legacy.row, key)];
        }
        if (legacy.legacyRow) {
          log.debug?.(
            `[github-pr-comments] ignoring stale legacy delivery hint for ${key.subjectExternalId}: ${legacy.reason}`
          );
        }
      }
      return [];
    } finally {
      db.close();
    }
  }

  async function postWithDedupe({ key, body }) {
    const existing = await lookupExistingDeliveries(key);
    const deliveredExisting = existing.find((record) => record.delivered);
    if (deliveredExisting) {
      return {
        key,
        deliveryExternalId: deliveredExisting.deliveryExternalId,
        deliveredAt: deliveredExisting.deliveredAt,
      };
    }

    const attemptedAt = isoString(now());
    let db = null;
    try {
      const posted = await postRawComment({ key, body });
      const deliveredAt = isoString(now());
      db = openDeliveryDb(rootDir);
      if (db) {
        insertDeliveryRecord(db, {
          key,
          deliveryExternalId: posted.deliveryExternalId,
          attemptedAt,
          deliveredAt,
          delivered: true,
        });
      }
      return {
        key,
        deliveryExternalId: posted.deliveryExternalId,
        deliveredAt,
      };
    } catch (err) {
      db = openDeliveryDb(rootDir);
      if (db) {
        insertDeliveryRecord(db, {
          key,
          deliveryExternalId: null,
          attemptedAt,
          deliveredAt: null,
          delivered: false,
          failureReason: err?.message || String(err),
        });
      }
      throw err;
    } finally {
      db?.close();
    }
  }

  async function postReview(verdict, deliveryKey) {
    const key = normalizeDeliveryKey(deliveryKey);
    return postWithDedupe({ key, body: renderVerdictBody(verdict) });
  }

  async function postRemediationReply(reply, deliveryKey) {
    const key = normalizeDeliveryKey(deliveryKey);
    return postWithDedupe({ key, body: renderRemediationReplyBody(reply) });
  }

  async function postOperatorNotice(event, body, deliveryKey) {
    const key = normalizeDeliveryKey(deliveryKey, { event });
    return postWithDedupe({ key, body });
  }

  return {
    postReview,
    postRemediationReply,
    postOperatorNotice,
    lookupExistingDeliveries,
    deliverReviewComment: postReview,
    deliverRemediationReply: postRemediationReply,
    deliverOperatorNotice: postOperatorNotice,
    loadPriorDeliveriesForSubject: lookupExistingDeliveries,
  };
}

export {
  COMMENT_DELIVERIES_SCHEMA_VERSION,
  createGitHubPRCommentsAdapter,
  ensureCommentDeliverySchema,
  normalizeDeliveryKey,
  parseSubjectExternalId,
};

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
<<<<<<< HEAD
=======
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
>>>>>>> 986782eb62007568c81e2e2b6f40d86a55492f85
import { promisify } from 'node:util';

import {
  ensureReviewStateSchema,
  lookupReviewRowDualRead,
  openReviewStateDb,
} from '../../../review-state.mjs';
import { CODE_PR_DOMAIN_ID } from '../../../identity-shapes.mjs';
<<<<<<< HEAD
=======
import { parseSubjectExternalId } from '../../subject/github-pr/index.mjs';
>>>>>>> 986782eb62007568c81e2e2b6f40d86a55492f85
import { parseCommentUrlFromStdout, resolveCommentBotTokenEnv } from './pr-comments.mjs';
import { redactPublicSafeText } from './redaction.mjs';

const execFileAsync = promisify(execFile);
const COMMENT_DELIVERIES_SCHEMA_VERSION = 1;
<<<<<<< HEAD
=======
const COMMENT_DELIVERY_CLAIM_STALE_MS = 5 * 60 * 1000;
const COMMENT_DELIVERY_CLAIM_WAIT_MS = 35_000;
const COMMENT_DELIVERY_CLAIM_POLL_MS = 200;
>>>>>>> 986782eb62007568c81e2e2b6f40d86a55492f85

function splitRepo(repoPath) {
  const [owner, repo] = String(repoPath || '').split('/');
  if (!owner || !repo) {
    throw new TypeError(`Invalid GitHub repo slug: ${repoPath}`);
  }
  return { owner, repo };
}

<<<<<<< HEAD
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

=======
>>>>>>> 986782eb62007568c81e2e2b6f40d86a55492f85
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
    delivered: row.review_status === 'posted',
  };
}

<<<<<<< HEAD
function buildAllowlistedGhEnv(env, token) {
  return {
    PATH: env?.PATH ?? '/usr/bin:/bin',
    HOME: env?.HOME ?? '',
    GH_TOKEN: token,
  };
=======
function buildAllowlistedGhEnv(env, {
  token = null,
  allowGhAuthFallback = false,
} = {}) {
  const allowlisted = {
    PATH: env?.PATH ?? '/usr/bin:/bin',
    HOME: env?.HOME ?? '',
  };
  if (token) {
    allowlisted.GH_TOKEN = token;
  } else if (allowGhAuthFallback && env?.GH_TOKEN) {
    allowlisted.GH_TOKEN = env.GH_TOKEN;
  } else if (allowGhAuthFallback && env?.GITHUB_TOKEN) {
    allowlisted.GITHUB_TOKEN = env.GITHUB_TOKEN;
  }
  return allowlisted;
>>>>>>> 986782eb62007568c81e2e2b6f40d86a55492f85
}

function resolveGhCommentAuth({
  env,
  workerClass,
  resolveGhToken,
  key,
  event = null,
}) {
  const explicit = typeof resolveGhToken === 'function'
    ? resolveGhToken({ key, event })
    : null;
<<<<<<< HEAD
  const tokenEnvName = explicit?.tokenEnvName
    || resolveCommentBotTokenEnv(explicit?.workerClass || workerClass);
  if (!tokenEnvName) {
    throw new Error(`No gh token routing configured for ${key.kind} delivery`);
  }
  const token = explicit?.token || env?.[tokenEnvName];
  if (!token) {
=======
  const fallbackTokenEnvNames = Array.isArray(explicit?.fallbackTokenEnvNames)
    ? explicit.fallbackTokenEnvNames.filter(Boolean)
    : [];
  const allowGhAuthFallback = explicit?.allowGhAuthFallback === true;
  const tokenEnvName = explicit?.tokenEnvName
    || resolveCommentBotTokenEnv(explicit?.workerClass || workerClass);
  if (!tokenEnvName && !explicit?.token) {
    throw new Error(`No gh token routing configured for ${key.kind} delivery`);
  }
  const token = explicit?.token
    || (tokenEnvName ? env?.[tokenEnvName] : null)
    || fallbackTokenEnvNames.map((name) => env?.[name]).find(Boolean)
    || null;
  if (!token && !allowGhAuthFallback) {
>>>>>>> 986782eb62007568c81e2e2b6f40d86a55492f85
    throw new Error(`${tokenEnvName} not set in env`);
  }
  return {
    tokenEnvName,
<<<<<<< HEAD
    env: buildAllowlistedGhEnv(env, token),
  };
}

=======
    env: buildAllowlistedGhEnv(env, { token, allowGhAuthFallback }),
  };
}

function commentDeliveryClaimsDir(rootDir) {
  return join(rootDir, 'data', 'comment-delivery-claims');
}

function commentDeliveryClaimName(key) {
  return createHash('sha256').update(JSON.stringify(key)).digest('hex');
}

function commentDeliveryClaimPath(rootDir, key) {
  mkdirSync(commentDeliveryClaimsDir(rootDir), { recursive: true });
  return join(commentDeliveryClaimsDir(rootDir), `${commentDeliveryClaimName(key)}.lock`);
}

function buildCommentDeliveryClaimerId() {
  return `${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}`;
}

function tryAcquireCommentDeliveryClaim(rootDir, key, claimerId, {
  now = () => new Date().toISOString(),
  staleMs = COMMENT_DELIVERY_CLAIM_STALE_MS,
} = {}) {
  const lockPath = commentDeliveryClaimPath(rootDir, key);
  const claim = { claimer: claimerId, claimedAt: now() };
  let fd;
  try {
    fd = openSync(lockPath, 'wx');
    writeSync(fd, JSON.stringify(claim));
    closeSync(fd);
    return { acquired: true, claimer: claimerId };
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }

  let existing = null;
  try {
    existing = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    existing = null;
  }
  const ageMs = existing?.claimedAt
    ? Math.max(0, Date.now() - new Date(existing.claimedAt).getTime())
    : Number.POSITIVE_INFINITY;
  if (ageMs <= staleMs) {
    return { acquired: false, claimer: existing?.claimer || null, ageMs };
  }

  writeFileSync(lockPath, JSON.stringify(claim), 'utf8');
  return { acquired: true, claimer: claimerId, reclaimedFromStale: true, previousAgeMs: ageMs };
}

function releaseCommentDeliveryClaim(rootDir, key) {
  try {
    rmSync(commentDeliveryClaimPath(rootDir, key), { force: true });
  } catch {
    // Best-effort.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

>>>>>>> 986782eb62007568c81e2e2b6f40d86a55492f85
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

/**
 * @param {{
 *   octokit?: any,
 *   rootDir?: string,
 *   execFileImpl?: typeof execFileAsync,
 *   commentTimeoutMs?: number,
 *   env?: NodeJS.ProcessEnv,
 *   workerClass?: string | null,
 *   resolveGhToken?: ((context: { key: DeliveryKey, event?: OperatorEvent | null }) => { tokenEnvName?: string, token?: string, workerClass?: string | null } | null) | null,
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
  env = process.env,
  workerClass = null,
  resolveGhToken = null,
  now = () => new Date(),
  log = console,
} = {}) {
  async function postRawComment({ key, body, event = null }) {
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

    const ghAuth = resolveGhCommentAuth({
      env,
      workerClass,
      resolveGhToken,
      key,
      event,
    });

    const result = await execFileImpl('gh', [
      'pr',
      'comment',
      String(prNumber),
      '--repo',
      repo,
      '--body',
      safeBody,
    ], {
      env: ghAuth.env,
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

  async function postWithDedupe({ key, body, event = null }) {
<<<<<<< HEAD
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
      const posted = await postRawComment({ key, body, event });
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
=======
    const deadline = Date.now() + COMMENT_DELIVERY_CLAIM_WAIT_MS;

    while (true) {
      const existing = await lookupExistingDeliveries(key);
      const deliveredExisting = existing.find((record) => record.delivered);
      if (deliveredExisting) {
        return {
          key,
          deliveryExternalId: deliveredExisting.deliveryExternalId,
          deliveredAt: deliveredExisting.deliveredAt,
        };
      }

      const claim = rootDir
        ? tryAcquireCommentDeliveryClaim(
            rootDir,
            key,
            buildCommentDeliveryClaimerId(),
            { now: () => isoString(now()) }
          )
        : { acquired: true };
      if (!claim.acquired) {
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for comment delivery claim for ${key.subjectExternalId}`);
        }
        await sleep(COMMENT_DELIVERY_CLAIM_POLL_MS);
        continue;
      }

      const attemptedAt = isoString(now());
      let db = null;
      try {
        const claimedExisting = await lookupExistingDeliveries(key);
        const claimedDelivered = claimedExisting.find((record) => record.delivered);
        if (claimedDelivered) {
          return {
            key,
            deliveryExternalId: claimedDelivered.deliveryExternalId,
            deliveredAt: claimedDelivered.deliveredAt,
          };
        }

        const posted = await postRawComment({ key, body, event });
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
        if (rootDir) {
          releaseCommentDeliveryClaim(rootDir, key);
        }
      }
>>>>>>> 986782eb62007568c81e2e2b6f40d86a55492f85
    }
  }

  async function postReview(verdict, deliveryKey) {
    const key = normalizeDeliveryKey(deliveryKey);
    return postWithDedupe({ key, body: renderVerdictBody(verdict) });
  }

  async function postRemediationReply(_reply, deliveryKey) {
    normalizeDeliveryKey(deliveryKey);
    throw new Error(
      'GitHub PR comments adapter does not support remediation-reply delivery; use the hardened remediation comment pipeline instead'
    );
  }

  async function postOperatorNotice(event, body, deliveryKey) {
    const key = normalizeDeliveryKey(deliveryKey, { event });
    return postWithDedupe({ key, body, event });
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

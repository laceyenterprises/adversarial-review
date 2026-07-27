import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

import { ensureReviewStateSchema, openReviewStateDb } from './review-state.mjs';

function isLoopbackRemoteAddress(remoteAddress) {
  const value = String(remoteAddress || '').trim();
  if (!value) return false;
  if (value === '::1' || value === '127.0.0.1') return true;
  if (value.startsWith('::ffff:')) return value.slice('::ffff:'.length) === '127.0.0.1';
  if (isIP(value) === 4) return value.startsWith('127.');
  return false;
}

function readBearerToken(secretFile) {
  const token = readFileSync(secretFile, 'utf8').trim();
  if (!token) throw new Error(`worker-completion secret file is empty: ${secretFile}`);
  return token;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function requireLaunchRequestId(payload) {
  const launchRequestId = String(payload?.launchRequestId || '').trim();
  if (!launchRequestId) {
    const error = new Error('launchRequestId is required');
    error.statusCode = 400;
    throw error;
  }
  return launchRequestId;
}

function writeJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(`${JSON.stringify(payload)}\n`);
}

function recordWorkerCompletionReceipt({
  rootDir,
  payload,
  authSubject = 'worker-completion-shared-secret',
  receivedAt = new Date().toISOString(),
}) {
  const launchRequestId = requireLaunchRequestId(payload);
  const payloadJson = JSON.stringify(payload);
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    const existing = db
      .prepare(
        `SELECT launch_request_id AS launchRequestId, payload_json AS payloadJson
           FROM worker_completion_webhook_receipts
          WHERE launch_request_id = ?`
      )
      .get(launchRequestId);
    if (existing) {
      return {
        accepted: true,
        idempotent: true,
        launchRequestId,
        duplicate: existing.payloadJson === payloadJson,
      };
    }
    db.prepare(
      `INSERT INTO worker_completion_webhook_receipts (
         launch_request_id, received_at, auth_subject, payload_json
       ) VALUES (?, ?, ?, ?)`
    ).run(launchRequestId, receivedAt, authSubject, payloadJson);
    return { accepted: true, idempotent: false, launchRequestId, duplicate: false };
  } finally {
    db.close();
  }
}

function createWorkerCompletionIngestHandler({
  rootDir,
  bearerToken = null,
  bearerTokenFile = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (!rootDir) throw new Error('rootDir is required');
  const resolvedBearerToken = bearerToken || (bearerTokenFile ? readBearerToken(bearerTokenFile) : null);
  if (!resolvedBearerToken) throw new Error('bearerToken or bearerTokenFile is required');
  return async function workerCompletionIngestHandler(req, res) {
    if (req.method !== 'POST' || req.url !== '/v1/worker-completion-ingest') {
      writeJson(res, 404, { error: { code: 'not_found', message: 'route not found' } });
      return;
    }
    if (!isLoopbackRemoteAddress(req.socket?.remoteAddress)) {
      writeJson(res, 403, { error: { code: 'loopback_required', message: 'worker-completion ingest only accepts loopback callers' } });
      return;
    }
    const authorization = String(req.headers.authorization || '');
    if (authorization !== `Bearer ${resolvedBearerToken}`) {
      writeJson(res, 401, { error: { code: 'unauthorized', message: 'missing or invalid bearer token' } });
      return;
    }
    try {
      const payload = await readJsonBody(req);
      const result = recordWorkerCompletionReceipt({
        rootDir,
        payload,
        receivedAt: now(),
      });
      writeJson(res, 202, result);
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 400;
      writeJson(res, statusCode, {
        error: {
          code: statusCode === 400 ? 'invalid_payload' : 'ingest_failed',
          message: error?.message || String(error),
        },
      });
    }
  };
}

function listWorkerCompletionReceipts(rootDir) {
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    return db
      .prepare(
        `SELECT launch_request_id AS launchRequestId,
                received_at AS receivedAt,
                auth_subject AS authSubject,
                payload_json AS payloadJson
           FROM worker_completion_webhook_receipts
       ORDER BY received_at ASC, launch_request_id ASC`
      )
      .all()
      .map((row) => ({
        ...row,
        payload: JSON.parse(row.payloadJson),
      }));
  } finally {
    db.close();
  }
}

export {
  createWorkerCompletionIngestHandler,
  isLoopbackRemoteAddress,
  listWorkerCompletionReceipts,
  recordWorkerCompletionReceipt,
};

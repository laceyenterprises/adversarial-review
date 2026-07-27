import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createWorkerCompletionIngestHandler,
  isLoopbackRemoteAddress,
  listWorkerCompletionReceipts,
} from '../src/worker-completion-ingest.mjs';

function samplePayload(overrides = {}) {
  return {
    schemaVersion: 1,
    launchRequestId: 'lrq_wcw_1',
    workerRunId: 'wrun_1',
    workerClass: 'codex',
    parentSessionRef: 'session:app-contract:demo-app',
    tokenUsage: { input: 5, output: 8, total: 13, source: 'session-ledger' },
    finalOutput: { disposition: 'succeeded', headSha: 'abc123', branch: 'codex/wcw-02', prUrl: null },
    ...overrides,
  };
}

async function withIngestServer(t, { rootDir, bearerToken = 'wcw-secret' } = {}) {
  const server = createServer(
    createWorkerCompletionIngestHandler({ rootDir, bearerToken, now: () => '2026-07-27T12:00:00.000Z' })
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/v1/worker-completion-ingest`,
    bearerToken,
  };
}

test('worker-completion ingest accepts authenticated loopback delivery', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'wcw-ingest-'));
  const { url, bearerToken } = await withIngestServer(t, { rootDir });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(samplePayload()),
  });
  assert.equal(response.status, 202);
  const payload = await response.json();
  assert.equal(payload.idempotent, false);
  const receipts = listWorkerCompletionReceipts(rootDir);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].launchRequestId, 'lrq_wcw_1');
});

test('worker-completion ingest rejects unauthenticated delivery', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'wcw-ingest-'));
  const { url } = await withIngestServer(t, { rootDir });
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(samplePayload()),
  });
  assert.equal(response.status, 401);
  assert.equal(listWorkerCompletionReceipts(rootDir).length, 0);
});

test('worker-completion ingest is idempotent on launchRequestId', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'wcw-ingest-'));
  const { url, bearerToken } = await withIngestServer(t, { rootDir });
  const request = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(samplePayload()),
  };
  const first = await fetch(url, request);
  const second = await fetch(url, request);
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  const duplicate = await second.json();
  assert.equal(duplicate.idempotent, true);
  assert.equal(listWorkerCompletionReceipts(rootDir).length, 1);
});

test('isLoopbackRemoteAddress accepts only loopback addresses', () => {
  assert.equal(isLoopbackRemoteAddress('127.0.0.1'), true);
  assert.equal(isLoopbackRemoteAddress('::1'), true);
  assert.equal(isLoopbackRemoteAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackRemoteAddress('10.0.0.1'), false);
  assert.equal(isLoopbackRemoteAddress('example.com'), false);
});

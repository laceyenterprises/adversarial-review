import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  appendOperatorMutationAuditRow,
  findOperatorMutationAuditRow,
} from '../src/operator-mutation-audit.mjs';

test('findOperatorMutationAuditRow skips malformed lines and continues scanning', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'operator-mutation-audit-'));
  const auditDir = path.join(rootDir, 'data', 'operator-mutations');
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(
    path.join(auditDir, '2026-05.jsonl'),
    '{"broken"\n{"idempotencyKey":"wanted","verb":"hq.adversarial.retrigger-review","repo":"laceyenterprises/agent-os","pr":238,"reason":"retry"}\n',
    'utf8'
  );

  const row = findOperatorMutationAuditRow(rootDir, 'wanted');
  assert.equal(row.idempotencyKey, 'wanted');
});

test('findOperatorMutationAuditRow prefers the latest committed row over earlier refusals', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'operator-mutation-audit-'));
  const auditDir = path.join(rootDir, 'data', 'operator-mutations');
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(
    path.join(auditDir, '2026-05.jsonl'),
    [
      JSON.stringify({ idempotencyKey: 'shared', outcome: 'refused:no-job', ts: '2026-05-05T05:00:00.000Z' }),
      JSON.stringify({ idempotencyKey: 'shared', outcome: 'bumped', ts: '2026-05-05T05:01:00.000Z' }),
      JSON.stringify({ idempotencyKey: 'shared', outcome: 'refused:job-active', ts: '2026-05-05T05:02:00.000Z' }),
      '',
    ].join('\n'),
    'utf8'
  );

  const row = findOperatorMutationAuditRow(rootDir, 'shared');
  assert.equal(row.outcome, 'bumped');
});

test('appendOperatorMutationAuditRow rejects invalid timestamps', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'operator-mutation-audit-'));
  assert.throws(
    () => appendOperatorMutationAuditRow(rootDir, {
      ts: null,
      idempotencyKey: 'wanted',
    }),
    /Invalid operator mutation timestamp/
  );
});

test('appendOperatorMutationAuditRow rejects impossible months', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'operator-mutation-audit-'));
  assert.throws(
    () => appendOperatorMutationAuditRow(rootDir, {
      ts: '2026-13-05T05:00:00.000Z',
      idempotencyKey: 'wanted',
    }),
    /Invalid operator mutation timestamp/
  );
});

test('appendOperatorMutationAuditRow writes ledgers with 0640 permissions', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'operator-mutation-audit-'));
  const filePath = appendOperatorMutationAuditRow(rootDir, {
    ts: '2026-05-05T05:00:00.000Z',
    idempotencyKey: 'wanted',
    verb: 'hq.adversarial.retrigger-review',
    repo: 'laceyenterprises/agent-os',
    pr: 238,
    reason: 'retry',
    outcome: 'triggered',
  });

  assert.equal(statSync(filePath).mode & 0o777, 0o640);
});

test('appendOperatorMutationAuditRow rejects oversized rows', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'operator-mutation-audit-'));
  const monthPath = path.join(rootDir, 'data', 'operator-mutations', '2026-05.jsonl');
  assert.throws(
    () => appendOperatorMutationAuditRow(rootDir, {
      ts: '2026-05-05T05:00:00.000Z',
      idempotencyKey: 'wanted',
      verb: 'hq.adversarial.retrigger-review',
      repo: 'laceyenterprises/agent-os',
      pr: 238,
      reason: 'x'.repeat(5000),
      outcome: 'triggered',
    }),
    /exceeds 4096 bytes/
  );
  assert.equal(existsSync(monthPath), false);
});

test('findOperatorMutationAuditRow prefers the newest committed row across months', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'operator-mutation-audit-'));
  const auditDir = path.join(rootDir, 'data', 'operator-mutations');
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(
    path.join(auditDir, '2026-04.jsonl'),
    `${JSON.stringify({ idempotencyKey: 'shared', outcome: 'bumped', ts: '2026-04-30T23:59:59.000Z' })}\n`,
    'utf8'
  );
  writeFileSync(
    path.join(auditDir, '2026-05.jsonl'),
    [
      JSON.stringify({ idempotencyKey: 'shared', outcome: 'refused:job-active', ts: '2026-05-01T00:00:00.000Z' }),
      JSON.stringify({ idempotencyKey: 'shared', outcome: 'bumped', ts: '2026-05-02T00:00:00.000Z' }),
      '',
    ].join('\n'),
    'utf8'
  );

  const row = findOperatorMutationAuditRow(rootDir, 'shared');
  assert.equal(row.ts, '2026-05-02T00:00:00.000Z');
});

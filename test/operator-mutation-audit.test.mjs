import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
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

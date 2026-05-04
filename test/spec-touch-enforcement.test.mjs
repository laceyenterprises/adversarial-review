import test from 'node:test';
import assert from 'node:assert/strict';

import { detectSpecTouchViolations } from '../src/reviewer.mjs';

test('flags tracked public Python contract changes in session-ledger when no canonical spec doc is touched', () => {
  const violations = detectSpecTouchViolations(`
diff --git a/platform/session-ledger/src/session_ledger/db.py b/platform/session-ledger/src/session_ledger/db.py
@@
-def lease_job(job_id: str) -> Lease:
+def lease_job(job_id: str, timeout_s: int = 30) -> Lease:
`);

  assert.equal(violations.length, 1);
  assert.equal(violations[0].project, 'session-ledger');
  assert.match(violations[0].message, /no canonical spec doc for `session-ledger` was touched/i);
});

test('does not flag tracked contract changes when a canonical docs/SPEC path is touched in the same diff', () => {
  const violations = detectSpecTouchViolations(`
diff --git a/platform/session-ledger/src/session_ledger/db.py b/platform/session-ledger/src/session_ledger/db.py
@@
-def lease_job(job_id: str) -> Lease:
+def lease_job(job_id: str, timeout_s: int = 30) -> Lease:
diff --git a/docs/SPEC-session-ledger.md b/docs/SPEC-session-ledger.md
@@
+Document lease_job timeout semantics.
`);

  assert.deepEqual(violations, []);
});

test('treats underscore-prefixed Python defs as private and excluded', () => {
  const violations = detectSpecTouchViolations(`
diff --git a/modules/example/server/service.py b/modules/example/server/service.py
@@
-def _normalize_widget(raw: dict[str, object]) -> Widget:
+def _normalize_widget(raw: dict[str, object], cache: Cache | None = None) -> Widget:
`);

  assert.deepEqual(violations, []);
});

test('accepts module-local SPEC docs for worker-pool CLI contract changes', () => {
  const violations = detectSpecTouchViolations(`
diff --git a/modules/worker-pool/bin/hq-requeue b/modules/worker-pool/bin/hq-requeue
@@
-  parser.add_argument('--limit', type=int)
+  parser.add_argument('--limit', type=int, default=20)
diff --git a/modules/worker-pool/SPEC.md b/modules/worker-pool/SPEC.md
@@
+Document the default requeue limit.
`);

  assert.deepEqual(violations, []);
});

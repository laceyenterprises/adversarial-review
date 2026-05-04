import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateSpecTouch } from '../src/spec-touch.mjs';

test('public worker-pool Python signature changes require the mapped SPEC touch', () => {
  const findings = evaluateSpecTouch(`
diff --git a/modules/worker-pool/lib/python/cwp_dispatch/dispatch.py b/modules/worker-pool/lib/python/cwp_dispatch/dispatch.py
@@
-def dispatch_worker(ticket_id: str) -> DispatchReceipt:
+def dispatch_worker(ticket_id: str, owner_user: str) -> DispatchReceipt:
`);

  assert.deepEqual(findings, [
    {
      ruleId: 'worker-pool-python',
      path: 'modules/worker-pool/lib/python/cwp_dispatch/dispatch.py',
      label: 'public Python signature changes in worker-pool dispatch code',
      specPaths: ['projects/worker-pool/SPEC.md'],
      covered: false,
    },
  ]);
});

test('mapped SPEC touches exempt otherwise-covered contract changes', () => {
  const findings = evaluateSpecTouch(`
diff --git a/platform/session-ledger/src/session_ledger/worker_handoff.py b/platform/session-ledger/src/session_ledger/worker_handoff.py
@@
-def claim_launch_request(launch_request_id: str) -> dict[str, object]:
+def claim_launch_request(launch_request_id: str, owner_user: str) -> dict[str, object]:
diff --git a/docs/SPEC-session-ledger-control-plane.md b/docs/SPEC-session-ledger-control-plane.md
@@
+- document owner_user launch-request ownership
`);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleId, 'session-ledger-python');
  assert.equal(findings[0].covered, true);
});

test('private helper signature changes stay outside the rule', () => {
  const findings = evaluateSpecTouch(`
diff --git a/modules/main-catchup/lib/python/main_catchup/pipeline.py b/modules/main-catchup/lib/python/main_catchup/pipeline.py
@@
-def _normalize_row(raw: dict[str, object]) -> dict[str, object]:
+def _normalize_row(raw: dict[str, object], now: str | None = None) -> dict[str, object]:
`);

  assert.deepEqual(findings, []);
});

test('hq shell library flag changes are anchored to the worker-pool SPEC', () => {
  const findings = evaluateSpecTouch(`
diff --git a/modules/worker-pool/lib/hq-common.sh b/modules/worker-pool/lib/hq-common.sh
@@
+    --json)
+      HQ_OUTPUT=json
+      shift
+      ;;
`);

  assert.deepEqual(findings, [
    {
      ruleId: 'worker-pool-hq-cli',
      path: 'modules/worker-pool/lib/hq-common.sh',
      label: 'hq CLI surfaces',
      specPaths: ['projects/worker-pool/SPEC.md'],
      covered: false,
    },
  ]);
});

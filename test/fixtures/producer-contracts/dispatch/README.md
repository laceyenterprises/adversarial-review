# Dispatch JSON producer captures (PRM-04)

Owner: `cwp_dispatch.dispatch`; wire types/reader: `cwp_dispatch.ticket`;
structured refusal type: `cwp_dispatch.dispatch_refusals`.
The [owner contract](../../../../../../README.md#dispatch-receipt-contract-prm-04)
documents presence, nullability, statuses, exit meanings and compatibility.

## Source revision

Producer and capture-harness revision: `513745e6c24f929f40b480991e9a32586c411c4e`. The following
blob IDs also pin the exact producer bytes.

Base checkout: `a235e9b040532beea1c09c8a87a0bdf3b9b75051`. Exact producer source revision is pinned by these
Git blob IDs (the source blobs committed in this PR):

| Producer source | Git blob revision |
|---|---|
| `dispatch.py` | `7b636f85a453fb51a7634f1d8e8cedd52381bcee` |
| `ticket.py` | `ba72a2bd3d2dd936b5d466e653d8218bd4bce28e` |
| `cli.py` | `b12cbb8172e1abb5001ac52670542f4edda1a312` |
| `dispatch_refusals.py` | `ba6e7035c66868ea4884bcd7dd1f33a9c7000a0a` |

The rest of the producer dependency tree, including the worker-class registry
and PRM-03 launch status owner, is unchanged from the base checkout. The
capture implementation is in the existing
[`test_dispatch_post_spawn_sqlite.py`](../../test_dispatch_post_spawn_sqlite.py).
No live dispatcher, daemon pass, publication, quota read or host database is
used to produce these examples.

## Inputs and boundary

The existing `enqueued_sqlite` fixture migrates a disposable SQLite ledger and
calls the actual `LedgerDatabase.enqueue_launch_request(LaunchRequestRecord)`
with adapter `test`, adapter request/idempotency key `post-spawn`, class `codex`
and task type `coding`. The actual post-enqueue serializer
`_dispatch_phase_post_spawn` creates its `DispatchTicket` and prints it. Its
inputs include ticket reference `DRAINQUEUE-02`, empty workspace repos and queue
position 1. The enqueue connection is closed before serialization, matching
the real orchestrator's boundary. Only the external daemon-liveness probe is
replaced; the advisory connection, drain read, queue serializer, JSON encoding,
stdout/stderr and return code are real. No spawn is performed.

| Capture | Disposable scenario and actual entrypoint |
|---|---|
| `accepted.json` | Durable requested LRQ; `_dispatch_phase_post_spawn`, exit 0. |
| `queued.json` | Same requested LRQ with drain epoch 7, fixed input start time `2026-10-19T00:00:00Z`, owner `test`, reason `deploy`; actual drain notice on stderr and JSON, exit 0. |
| `diagnostic-error-after-enqueue.json` | Same durable enqueue; injected `sqlite3.OperationalError` at the post-enqueue advisory connection boundary. The ticket and ID remain available, exit 0. |
| `running.json`, `completed.json` | Existing disposable row set to `running` or `succeeded` by the simulated daemon boundary. Actual `_print_existing_dispatch_ticket` reads it, calculates queue position, and serializes the idempotent watch handle. No second enqueue; status alone does not prove publication. |
| `refused.json` | Actual CLI `_main` with a disposable active fleet-stop marker, explicit root/ticket/class/prompt/idempotency flags and `--no-infer`; real admission refuses before ledger access, exit 6, empty stdout. |
| `dry-run-refused.json` | Actual CLI `_main --dry-run --model not-an-allowed-model`; real worker-spec normalization against the checked-in registry. Only the external provision capability probe returns an actual-shaped ok result. Exit 65, dry-run JSON, no LRQ or intent. |
| `structured-refused.json` | Actual CLI `_main --ignore-external-blockers` without a reason; actual override validation/argparse emits its structured error on stderr, exit 2, empty stdout. |

Refusal scenarios initialize the disposable root with `.hq/config.json`
(`schemaVersion: 1`, `ownerUser` from the test process account). Each scenario
asserts its exact expected exit before comparing or refreshing the capture.
Refusal invocations use `--root <temporary-directory> --ticket PRM-04
--prompt prompt.md --worker-class codex --no-infer --idempotency-key prm04-refused`
plus the scenario flags above. `_main` is the actual command body; the outer
`main` timing/telemetry wrapper is not invoked for these captures. No stderr
lines are stripped. The serialization tests attach the producer logger to the
captured stderr stream without changing the log message. Accepted serializer
captures deliberately test the receipt boundary, rather than claiming to cover
workspace provisioning or the full launch transaction.

## Recapture and verification

From the repository root, with a provisioned readable `NETGUARD_ROOT` containing
`bin/` and `site/`:

```bash
test -n "$NETGUARD_ROOT" && test -d "$NETGUARD_ROOT/bin" && test -d "$NETGUARD_ROOT/site"
PRM04_RECAPTURE=1 AGENT_OS_SESSION_LEDGER_VDB=false NETGUARD_LOG=/tmp/prm04-capture-netguard.log \
  PATH="$NETGUARD_ROOT/bin:$PATH" PYTHONPATH="$NETGUARD_ROOT/site" \
  pytest modules/worker-pool/lib/python/cwp_dispatch/test/test_dispatch_post_spawn_sqlite.py -q -k capture_parity
AGENT_OS_SESSION_LEDGER_VDB=false NETGUARD_LOG=/tmp/prm04-parity-netguard.log \
  PATH="$NETGUARD_ROOT/bin:$PATH" PYTHONPATH="$NETGUARD_ROOT/site" \
  pytest modules/worker-pool/lib/python/cwp_dispatch/test/test_dispatch_post_spawn_sqlite.py -q
```

Use a 180-second foreground timeout for each command. Existing conftests provide
the package source roots and isolate configuration; do not add production DSNs
or run a real dispatch for recapture. After an intentional producer change,
refresh this source revision with `git hash-object` on the four files above.

Only the volatile LRQ identifier (including occurrences inside watch commands)
is replaced with `<launch-request-id>`. Fixed drain times are scenario inputs.
No keys, nulls, values, statuses, errors, output modes or exit codes are rewritten.
Each capture records the actual stdout string, stderr string and integer exit.
`test_dispatch_receipt_capture_parity`/`test_dispatch_refusal_capture_parity`
compare the real normalized result to these examples. Reader tests and the
chain-dispatch shell suite consume the same `accepted.json`.

Malformed/non-object JSON, missing/invalid identity and unrecognized status
cases are explicitly negative mutations of the real accepted capture, never
positive producer examples. Synthetic legacy alias/watch-array compatibility
mutations retain existing reader policy; they are not evidence of current
producer output. Missing status remains a producer/field diagnostic without
introducing a new hold. PRM-02 quota evidence and PRM-03 lifecycle meanings remain
with their existing owners; dispatch receipts cannot independently attest
running work, completion or delivered publication.

[Measured validation results and exact test-file scope](validation.md) record
the completed checks, unchanged baseline failures and bounded wider-run limits.

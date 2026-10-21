# Publication producer captures

The [owner contract](../../../../../../docs/pr-publication-contract.md) defines
meaning, compatibility and the command inventory. These are producer outputs,
not payloads assembled to satisfy consumer assumptions.

## Revision and inputs

Base revision: `9b93b168d040786e99c9c145b2700cafe067b361`. Dependencies outside the
listed source blobs are from that base. The captures preserve complete JSON
keys, nulls, flags, statuses, numbers, units, output strings and process exits.

`test_pr_open_required_identity.py::test_publication_capture_parity` executes
the production shell's adapter/create/readback/sidecar/identity-closeout block
and actual `write_sidecar` function in a disposable directory. A tiny fake HQ
binary calls the real `GhCliTransport.create_pr`, `list_prs_by_head` and
`get_pr_state` implementations and the real adapter `cli.emit` serializer. Only
`gh` execution is replaced: raw GitHub CLI responses contain the PR URL, a 403
refusal, or the open PR fields. No positive adapter envelope is invented.
The workspace is a real Git repository with a real commit. Shell owner/log and
local completion/attestation/harvest sinks are bounded test seams; they do not
contact the ledger or HCP in these scenarios. Separate completion captures
below exercise real ledger serialization.

Fixed shell inputs: worker `worker`, class `codex`, ticket `PRM-05`, branch
`branch`, trunk `main`, repo short name `repo`, qualified repo `example/repo`,
LRQ `lrq-capture`, open time `2026-10-20T00:00:00Z`, finality `infer`, medium risk,
no draft/salvage, empty lineage and plan/action provenance. Fake GitHub responses
use PR number 2 and `https://github.com/example/repo/pull/2`; the expected head is
read from the disposable Git repository. The tests record every emitted adapter
envelope, stdout, stderr, exit and D1 when present.

| Example | Actual producer scenario |
|---|---|
| `accepted.json` | GitHub CLI returns a URL; required local sinks succeed, exit 0. |
| `capture-failed.json` | Same accepted create and D1; completion sink fails, attestation sink still runs, exit 3. |
| `missing-url.json` | GitHub CLI accepts with empty output; actual adapter emits empty URL/output; D1 is `opened_url_missing`, exit 4. |
| `refused.json` | GitHub CLI returns 403; actual adapter auth failure; readback list is empty, no D1, exit 1. |
| `same-head-adopted.json` | Same failed response, but real adapter readback observes the same head/base/owner open PR; adopted with exit 0. |
| `wrong-head-refused.json` | Readback PR has a different head; existing adoption policy refuses, no D1, exit 1. |
| `policy-refusal.json` | Actual `write_pr_open_refusal_record`, same-user disposable directory, malformed-title reason; nullable identity schema preserved. Function invocation exits 0 after writing the audit, not a successful `hq pr open`. |
| `adopt-recorded.json` | Actual `pr_adopt.main` / `adopt`, existing recovery fixture with fake GitHub/Git reads and real HMAC attestation serialization, plus actual `capture_pr_open` writing a separately migrated disposable SQLite ledger. Only the external commit-existence read is faked. Full command stdout is retained. |
| `completion-recorded.json` | Existing migrated disposable SQLite `BuildCompletionCaptureTests` fixture invokes actual `capture_pr_open` and then actual `build_completion_capture.main(pr-open)`. Full persisted row is the receipt that `adopt` returns; CLI emits only `pr_number`. The full `hq pr adopt` recovery flow is covered separately by its existing tests, not claimed as the entrypoint of this capture. |
| `disposition-*.json` | Actual `pr_disposition.main --pr 42 --repo org/agent-os --json` and disposition logic; fake GitHub/gate/Git observations at existing test seams. Parked, unparked, already-parked, unrelated-failure unchanged and unreadable-gate warning scenarios. Audit sink is absent in this disposable invocation. |
| `drift-{ok,warn,stale}.json` | Actual `analyze_pr_drift` invoked by the shell; real `json.dumps(indent=2)` serialization, with commit/deleted-line/conflict observations (0/0/0), (10/500/0), (25/2000/30); 3 changed files, PR 2, main base. Thresholds are the existing defaults. Existing shell suite exercises fake GitHub/Git integration. |
| `backfill-unresolved.json`, `backfill-resolved-dry-run.json` | Actual embedded backfill producer reads the missing-URL D1 capture with a disposable repo registration and fake GitHub CLI list response. Unresolved evidence names the producer/field; dry-run resolution retains progress text before the final JSON tally and does not update the sidecar. |
| `backfill-empty.json` | Actual embedded `hq-pr-backfill-pr-urls` Python producer against an empty disposable D1 directory, dry-run; no GitHub invocation. Final JSON tally only because no progress lines are needed. |

The completion row uses fixed input PR 4377, `interactive.codex.4377`, ticket
`interactive-4377`, branch `capture-branch`, class `codex`, fixed open time above,
and the checkout's real HEAD. Existing test auth/commit-lookup seams use fake
GitHub responses; the database migration, completion write/read and JSON
serialization are real. No ledger schema/semantics change is made by PRM-05.
Postgres-parameterized adoption tests retain their disposable-DSN opt-in.

Normalization replaces only the disposable capture root with `<capture-root>`,
real commit identity with `<head-sha>`, and generated completion id with
`<completion-id>`. Fixed input timestamps/identifiers are left intact. Drift's
fixed 40-character Git observations are input identifiers, not output redaction.
No status, key, nullability, count or stderr line is removed. Failed local
capture and acceptance intentionally have identical D1 records.

## Exact recapture commands

From the repository root, with the provisioned guard (never production DSNs):

```bash
test -n "$NETGUARD_ROOT" && test -d "$NETGUARD_ROOT/bin" && test -d "$NETGUARD_ROOT/site"
PRM05_RECAPTURE=1 AGENT_OS_SESSION_LEDGER_VDB=false NETGUARD_LOG=/tmp/prm05-recapture-netguard.log \
  PATH="$NETGUARD_ROOT/bin:$PATH" PYTHONPATH="$NETGUARD_ROOT/site" \
  python3 - <<'PY'
import subprocess
files = [
    'modules/worker-pool/lib/python/cwp_dispatch/test/test_pr_open_required_identity.py',
    'modules/worker-pool/lib/python/cwp_dispatch/test/test_build_completion_capture.py',
    'modules/worker-pool/lib/python/cwp_dispatch/test/test_pr_adopt.py',
    'modules/worker-pool/test/test_pr_disposition.py',
]
raise SystemExit(subprocess.run(['pytest', *files, '-q', '-k', 'capture_parity'], timeout=180).returncode)
PY
```

Unset `PRM05_RECAPTURE` and run the same command to compare instead of replacing
examples. Only the parity tests write examples, and only with that explicit
variable. Ordinary tests and consumer readers never rewrite them. Consumer
mutations are labelled negative in the tests; the missing-URL and refusal files
are real unavailable/refused outputs, not malformed mutations. A legacy
missing-`dryRun` compatibility mutation is labelled as legacy support, not a
current producer capture.

## Exact emitting source blobs

These Git blob revisions pin the producer and capture-harness bytes on top of
the base revision above. Recapture refreshes this table with `git hash-object`
for each listed path after an intentional source change.

| Repo-relative source | Git blob revision |
|---|---|
| `modules/worker-pool/lib/hq-pr-open.sh` | `a4e80915abd347d135ae378d03d21eef5abbadfe` |
| `modules/worker-pool/lib/hq-pr-open-adoption.sh` | `176e44e6463410b4c3af54aad2d02c11e3d6e42e` |
| `modules/worker-pool/lib/hq-pr-drift.sh` | `9ca8294dd86bae2a19ac7edb0835ed98684aee8c` |
| `modules/worker-pool/lib/hq-pr-backfill-pr-urls.sh` | `06aefe82e863b19c430045e7c821a2cecfd13656` |
| `modules/worker-pool/lib/python/cwp_dispatch/publication_receipts.py` | `e2bc89d2615c298fd60eb3bc8b1cd134d987e2be` |
| `modules/worker-pool/lib/python/cwp_dispatch/pr_drift.py` | `b3ef6c86c4d4968d7c0513a501f4a7e09648a1b0` |
| `modules/worker-pool/lib/python/cwp_dispatch/pr_adopt.py` | `12d71f3d7d0f939ee5d2c93c0f1ff1b33e29b564` |
| `modules/worker-pool/lib/python/cwp_dispatch/pr_disposition.py` | `331d159ebea5f79f7d482f36d9f334d3c23c6f1b` |
| `modules/worker-pool/lib/python/cwp_dispatch/pr_open_finality.py` | `b7b33b14f638a978fcac6b5bc3e1fde35bcb1a4e` |
| `modules/worker-pool/lib/python/cwp_dispatch/build_completion_capture.py` | `5327c654dd471821278f9b57e7ba92045fcd6a3d` |
| `modules/github-adapter/src/agent_os_github_adapter/envelope.py` | `d3a9e815476c5b36683f7c1915763f166e87c736` |
| `modules/github-adapter/src/agent_os_github_adapter/transport.py` | `1ab11a44874b712159c3668d31233718cc12f513` |
| `modules/github-adapter/src/agent_os_github_adapter/cli.py` | `6c097cb5e5d3856ad43a23ce0539f03ea6644146` |
| `modules/worker-pool/lib/python/cwp_dispatch/test/test_pr_open_required_identity.py` | `54e7b57a0244e1d121e84e6cdfa6a9e1d944448c` |
| `modules/worker-pool/lib/python/cwp_dispatch/test/test_pr_adopt.py` | `143a2dcc3baac827c529aae68d797924886e176c` |
| `modules/worker-pool/lib/python/cwp_dispatch/test/test_build_completion_capture.py` | `f700b6ae4f266fcf1087be71d07ee3b552908afe` |
| `modules/worker-pool/test/test_pr_disposition.py` | `71601e9c375384501636f7383dedcee7c5959eb4` |

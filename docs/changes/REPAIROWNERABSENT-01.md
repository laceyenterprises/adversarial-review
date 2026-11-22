# REPAIROWNERABSENT-01

## Summary

Legacy CWP conflict reservations use a repository-authorized exact-key read
to prove absence after grace. A second positive observation escalates through
`repair-absent-unfenced`. Read failures retain custody and surface the overdue
operator action. Review admission still requires publication or retirement.

## Interface changes

`retire-legacy-repair.mjs --ledger-absence` consumes the committed canonical
owner-family fence when the original conflict worker evidence is unavailable.
It retains the existing custody checks, receipt and cooldown history.
Rescue can read the operator hold from repair facts.

Deploy the Agent OS companion, including its dispatch-read endpoint,
ledger fence support and worker-pool fence CLI, before using `--ledger-absence`
or accepting repository-scoped absence. There is no runtime enable switch.
An explicit selector refusal or unproven absence scope permits one legacy
key-only read to preserve positive ownership during deployment; fallback
absence never counts. Transport failures retain custody without a key-only fallback.
The companion supplies the repository-only CWP absence proof, `observe_unlocked_key`
and `_evidence` support for `canonical-cwp-ledger-absence`. The latter checks
PR-wide HQ ownership and native conflict submission custody without the
original worker ID or boot trace offset. [Agent OS PR #11416](https://github.com/laceyenterprises/agent-os/pull/11416)

The watcher trusts that producer grant for the native submission-lock check;
it does not validate a separate lock attestation. The retirement reader also
checks PR-wide HQ custody locally for `--ledger-absence`, under the native key
lock, before rebuilding producer evidence. Local watcher absence-gate errors
log their class, code and message at the persisted thirty-second cadence.
The exclusive closer scan remains: shared flock still blocks writers, and an
unlocked scan loses serialization with closer submissions.

Closer record writers retry nonblocking lock acquisition after 10 ms and 25 ms
to accommodate a brief watcher scan. A persistent holder still refuses the write
with `EBUSY`.

## Post-merge activities

Confirm Agent OS #11416's endpoint, fence schema and CLI are installed before
operator ledger-absence retirement. Observe natural positive ownership during
rollout and canonical repository absence after producer deployment; source tests
do not establish the deployed producer's lock behavior.

## Verification

Synthetic cases cover grace, repeated absence, transport faults, retirement
receipts, competing ownership and watcher admission after retirement.
`python3 -B test/fixtures/legacy-repair-fence-reader.py` passed, including
ledger-absence selector validation, key-lock contention and propagation of
producer custody refusals. The dispatch-read client tests passed with the
repo-only grant and exact-selector fixtures.

Final Comment-only remediation: 106 repair/retirement tests, 47 dispatch-read
tests, 197 watcher claim-loop cases, all 14 Python reader fixtures, lint (zero errors), contract typecheck,
the 101-entry data-model catalog validator and the byte-equivalence demo passed.

Hammer's canonical changed-file validation passed across 43 Node test files
with one skip. The pre-receipt intent fixture verifies that a brief lock
collision allows the record write to proceed and that a persistent holder
prevents the mutation.

Final fix-all verification retains the five existing review dispositions:
positive-only legacy fallback during producer rollout; explicit producer
responsibility for the native lock check; independent local PR-wide HQ custody
validation; cadence-bounded absence-gate diagnostics; and bounded closer-writer
contention retries. Additional offline cases cover success on the final retry
with exactly 10 ms and 25 ms backoff, and immediate refusal without mutation
or retry for a permanent lock error.
`npm test -- ama-pre-receipt-intent.test.mjs inplacerepair-01.test.mjs
retire-legacy-repair.test.mjs dispatch-read-client.test.mjs` passed all 351
cases. The 14 Python reader cases, lint (zero errors), contract typecheck,
offline byte-equivalence demo and 102-entry catalog validator also passed.
`npm test -- watcher-claim-loop.test.mjs` passed all 197 cases within a
300-second bound. An initial combined run exceeded a 180-second local bound;
both separate runs passed without assertion failures.

The preceding head's Node 22 CI run reached the 900-second suite deadline
with 54 files still queued and no failed test assertions in its log; Node 26
passed. Full-suite validation remains in PR-head CI. No CI workflow, runner
count or deadline is changed by this remediation.

The final Gemini Comment-only findings were checked against reviewed head
`1dccc579c4527d7af8c4be1d639273580789923e`. Missing or malformed retirement
evidence already short-circuits at `evidence?.repo !== repo`; new CLI cases
verify the proof-mismatch refusal and byte-identical ledger for legacy,
native-CWP and ledger-absence retirement. No retirement validator change
was needed.

Dispatch failures now expose a redacted `selectorRefused: true` signal for
HTTP 400/403 or explicit selector/scope refusal codes. Only that signal or
an unproven absence scope permits the positive-only legacy fallback.
Timeouts, connection faults, server failures and unclassified failures keep
custody without spending a second selector's timeout budget. The existing
client retry remains inside the original lookup deadline.
All 159 focused repair, retirement and dispatch-read cases passed, including
actual SDK-boundary refusal/fallback and transport-failure call counts.
Lint passed with zero errors (147 existing warnings), contract typecheck,
the offline byte-equivalence demo and the 102-entry catalog validator passed.
The watcher claim-loop suite passed all 197 cases within a 300-second bound.

## Rescue CI performance integration

The final head had two hosted Node22 deadline failures with no assertion failure, most recently223files still queued, while Node26 passed. Rescue integrates only the disposable watcher diagnostic-flush fixture and its two watcher test call sites from the already measured LAC2182 repair at52609bf751801ef2f14208e837486a96253537c5. It preserves actual production atomic writes/flushes, all test case identities, the900second deadline and the eight-worker plan. The source repair was measured on Node22 at37.825–43.805s before and25.750–25.807s after for the same329cases. This integration does not import the pending ARPUBLICREADY production changes. Current-head focused and full hosted acceptance remain separate.

The remaining 13 MLR lines are explicitly owned by [LAC-2321](https://linear.app/laceyenterprises/issue/LAC-2321). Retry shims remain because current regression coverage still exercises their behavior. No safety deletion or budget adjustment is claimed.

Root integration measurement on Node26.10.0: watcher-poll-memory preserved its one aggregate test and every internal pass/allocation probe, completing in34656ms before and23724ms after the fixture repair. This is focused evidence, not proof that the full900s budget will pass. The original Node22 measurements above remain the cross-version evidence; current hosted Node22 must pass on the changed head.

The integrated watcher claim-loop suite passed all 197 cases in 319.6 seconds
on the loaded rescue host. Agent OS companion #11416 is verified present in
the deployed checkout; retirement acceptance still requires canonical receipt
and reservation readback on each original PR.

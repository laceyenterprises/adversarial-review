# LVR-02 validation

SPEC: `live-reality-verification@e95523f55f5a`.

The worker-pool required-outcome contract and companion App Contract forwarding
change are merged. This change uses those existing mechanisms. Hammer and closer
launches require a terminal audit; both remediator transports require a push.
Failure audits carry the launch identity and fixed reason codes. Incident markers
affect scheduling within the existing review priorities and merge reservations.

All validation used the provisioned netguard PATH and PYTHONPATH. The final runs
use an absolute scratch log path so local Git fixtures can change directories.
The repository runner supplies disposable HOME/HQ state, offline GitHub transport
and its existing 900-second command deadline. No live dispatch, merge, token mint,
provider request or page is part of these tests.

The final affected-file command is:

```bash
node test/run-tests.mjs \
  test/lvr-no-op-outcomes.test.mjs \
  test/ama-hammer-outcome-truth.test.mjs \
  test/ama-closer-dispatch-priority.test.mjs \
  test/ama-hammer-retry-cap.test.mjs \
  test/ama-merge-lease.test.mjs \
  test/follow-up-remediation.test.mjs \
  test/watcher-reviewer-pool.test.mjs \
  test/watcher-claim-loop.test.mjs \
  test/adapters/subject-github-pr.test.mjs \
  test/hammer-token.test.mjs \
  test/follow-up-merge-agent.test.mjs \
  test/ama-merge-lease-cli.test.mjs \
  test/hammer-attestation-retry.test.mjs \
  test/hammertrim-contract.test.mjs \
  test/activation-check.test.mjs \
  test/ama-hammer-merge-protocol-prompt.test.mjs \
  test/hammer-base-head.test.mjs \
  test/watcher-daemon-clean-merge.test.mjs \
  test/ama-audit.test.mjs \
  test/ama-merge-lease-revalidation.test.mjs \
  test/smv.test.mjs
```

It covers refresh failure before GitHub, missing PR state, pre-call refusal,
redaction, launch-bound normal and early audits, preserved shell errexit,
producer-reported and inferred `no_work_done`, both retry-refund policies,
dispatch arguments, review ordering, lease FIFO and daemon reservations.
The command completed in 671.8 seconds: **1,816 passed, zero failed, one skipped,
zero cancelled** (1,817 tests total), within the runner's 900-second bound.

After rebasing onto the recorded-fixture release and installing its vendored SDK
0.4.0 offline, this additional command passed **86 tests** with no failures, skips
or cancellations (120-second bound):

```bash
node test/run-tests.mjs \
  test/recorded-producer-consumers.test.mjs \
  test/producer-contract-readers.test.mjs \
  test/app-sdk-consumption.test.mjs
```

Lint reports zero errors and 146 existing warnings. Contract typechecking and
the research-finding byte-equivalence walkthrough pass. These commands each had
a 120-second bound:

```bash
npm run lint
npm run typecheck:contracts
bash demo/research-finding-walkthrough.sh
```

The companion ShellCheck gate was run against rendered verify, publish and merge
procedures. It reports the same three SC2034 warnings on this head and unmodified
main: `HAM_PUBLISHED_AUDIT_HEAD`, `HAM_LEASE_PROBE_TRANSIENT` and
`HAM_REBASED_ONTO_BASE_SHA`. No new ShellCheck finding is claimed resolved by
this change.

An earlier full `npm test` attempt reported 14,546 passes, three failures and ten
skips. Two prompt expectations were subsequently fixed and pass in the scoped
procedure/prompt run. The other failure was the unchanged build-cancellation
test; no full-suite green is claimed. Intermediate resume runs exposed stale
installed SDK bytes, the relative netguard log error, and an insufficient
180-second bound for existing rate-limit retry tests. The final command above
uses the corrected dependency, absolute log and repository deadline.

After normal deployment, the existing `lvr-02-review-required-outcome` assertion
must pass once. Exit 75 remains pending until deployment. The companion endpoint
must forward `required_outcome` before the review-service SDK consumer deploys.
The operator-authorized action deferral leaves official-record-bump execution
with the companion change. No worker restart, configuration flip or live
activation is claimed.

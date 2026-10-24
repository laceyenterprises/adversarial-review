# LVR-10 recorded consumer validation

SPEC: `live-reality-verification@e95523f55f5a`.
The dependency is merged producer revision
`1c60bb0f82e2924f5df7c11003a3d523917f3cc8`. The unchanged SDK 0.4.0 release
hash matches the artifact committed at that revision. Capture revisions and
versions remain those stamped by the producer, independently of the release.

Only synthetic public recordings were extracted. Tests use disposable roots,
fake refresh output, injected ledger snapshots and registry files. No live
token mint, provider call, database, dispatch, publication or page is exercised.
The existing repository runner also isolates HOME/HQ state and supplies fake
GitHub transport. All test commands used the provisioned netguard PATH,
PYTHONPATH and scratch NETGUARD_LOG; their machine-specific locations are omitted
from this public record. No native host-sandbox qualification is claimed.

Before extraction, the new consumer suite failed on absent recordings with
producer-named `contract unrecorded` diagnostics. After extraction, the initial
three-file run passed 183 tests. The final focused run of those same three files
passed **188 tests**, with zero failures, skips or cancellations, in 45.5 seconds
(120-second bound), including refresh and corrupt-byte regressions. The
complete affected consumer run reported **478 passes, seven baseline failures,
zero skips/cancellations**, in 31.4 seconds (180-second subprocess bound):

```bash
node test/run-tests.mjs \
  test/recorded-producer-consumers.test.mjs \
  test/hammer-token.test.mjs \
  test/producer-contract-readers.test.mjs \
  test/app-sdk-consumption.test.mjs \
  test/agent-runtime-local.test.mjs \
  test/session-ledger-read-adapter.test.mjs \
  test/launch-request-status.test.mjs \
  test/hq-dispatch-status-json.test.mjs \
  test/codex-account-routing.test.mjs \
  test/codex-worker-account-routing.test.mjs
```

All seven failures are in unchanged `test/agent-runtime-local.test.mjs` and
report a HOME/local-OAuth-owner startup mismatch. The same seven tests fail on
an unmodified archive of consumer main `b57511b8`, with its original SDK 0.3.0
installed from the historical tarball (24 passes, seven failures; 120-second
bound). No production source was changed to accommodate baseline failures.

After rebasing onto consumer main `0334c8f9`, the same ten-file command
completed in 30.5 seconds under its 180-second bound: **489 passes, the same
seven runtime baseline failures, zero skips/cancellations**. All recorded
consumer, mutation, provenance and refresh tests passed. Lint, contract
typecheck, byte-equivalence demo, changed-test ESLint and refresh-script Ruff
checks passed again on that rebase. The README conflict retained both the
new controller census documentation and this ticket's SDK 0.4.0 reference.

The required full `npm test` was attempted once with a 900-second subprocess
bound. It timed out without a suite summary and had reported failures in
unchanged runtime/remediation suites and a build-cancellation test. No full-suite
green is claimed, and no unrelated test or production behavior was changed to
address those results. The seven scoped runtime failures above were separately
reproduced on main with the original dependency.

The new regressions cover each consumer against the unmodified recording and
a deliberate mutation. Mutations fail with producer name and capture contract
version without payloads in the error/cause. The release, installed snapshot,
fixture bytes, content hashes and npm lockfile integrity are verified offline.
Refresh runs are deterministic, retain historical manifest entries and released
provenance, and reject a corrupt recording before changing consumer files.
The historical refresher also preserves the new SDK recording metadata.

Other validation (120-second bounds each):

- `npm run lint`: zero errors; 146 existing warnings.
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed byte equivalence.
- ESLint over the four changed/new JavaScript test/helper files: passed.
- Ruff check/format over both refresh scripts: passed.
- `git diff --check`: passed.

Fleet recordings anonymize account-map keys; router holds are the expected
outcome, not proof of positive admission. Worker-class show is explicitly
projected into the registry mirror because this service does not consume show
stdout. The launch row exercises the snapshot seam and status/ownership policy,
not live SQL transport. Existing positive admission and compatibility fixtures
remain in their owning suites. No other LVR ticket's scope is implemented.

Activation remains the existing `lvr-10-consumer-fixture-pinned` presence
assertion. It is pending (exit 75) until the recorded token file reaches the
deployed submodule. This worker performs no deployment, restart or config flip.

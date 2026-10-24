# Weekly quota evidence validation

The public producer export was read at agent-os revision
`28ddd444217d56966b3099dd8418162ea77438dc`; the consumer base was
`7ab2d0244f74440a46b6244dd7d8ea414c5db612`. The export SHA-256 is recorded
with the projected reserve-floor examples. No source, private fixture directory,
live quota input, database or credentials were copied into these fixtures.

Both routers use the pinned SDK's normalizer through an explicit weekly-only
policy. For current floors, a measured five-hour fallback stays held when the
weekly reading is missing, null, stale or invalid. Legacy floors lacking the
reason key keep their previous fallback. Provider readiness, broker servability,
account ordering, measured-zero exhaustion and personal Claude reserve holds
remain independent. See the [truth table](../producer-contract-readers.md#weekly-evidence-and-admission-policy).

The shared Codex/Claude helpers and inline watcher quota scenario use unmodified
`repaired-disabled` floors from the public export. Those floors retain independent
weekly measurements for all four accounts. Stale/unknown inline routing cases
mutate only the relevant exported weekly object. The remaining status/confidence
fixtures explicitly test legacy compatibility. A sibling search covered every
`weeklyMeasurement`, `measurement`, reserve-floor helper and account-router test.

Tests use the provisioned netguard binary shims and Python socket guard, a
scratch `NETGUARD_LOG`, disposable state and fake external boundaries. Each
command has a subprocess timeout. No live dispatch, provider, broker or GitHub
transport is exercised. The Node repository runner also isolates home/state roots
and injects fake GitHub transport. No native host-sandbox claim is made.

The complete affected consumer run passed **1,317 tests**, with no failures,
skips or cancellations (600-second bound):

```bash
node test/run-tests.mjs \
  test/afh-reviewer-fallback.test.mjs \
  test/ama-closer-dispatch-priority.test.mjs \
  test/ama-closer-transient-classification.test.mjs \
  test/ama-harness-fallback.test.mjs \
  test/ccx-04-corporate-fallback.test.mjs \
  test/claude-account-routing.test.mjs \
  test/codex-account-routing.test.mjs \
  test/codex-worker-account-routing.test.mjs \
  test/identity-token-snapshot.test.mjs \
  test/load-aware-call-timeouts.test.mjs \
  test/producer-contract-readers.test.mjs \
  test/quota-pause-suspension.test.mjs \
  test/reserve-floor-measurement.test.mjs \
  test/review-queue-depth-failover.test.mjs \
  test/review-worker-class-fallback.test.mjs \
  test/reviewer-burst-lease.test.mjs \
  test/reviewer-spawn-settle-quota.test.mjs \
  test/unregistered-repo.test.mjs \
  test/watcher-claim-loop.test.mjs \
  test/watcher-fast-merge.test.mjs \
  test/watcher-reviewer-quota.test.mjs \
  test/weekly-evidence-policy.test.mjs \
  test/worker-token-pool.test.mjs
```

The 93 new consumer tests cover every provider/account, weekly measured/null/
missing, null/present reason, stale/disabled/short-only/expired/unavailable
captures, malformed objects/status/percentages, zero, legacy fallback, stale
account probes and mutation isolation. The producer/SDK companion adds an
88-input Node/Python matrix that retains source and original reason.

The complete Node SDK suite passed **233 tests** (180-second bound):

```bash
node --test platform/app-sdk/node/test/*.test.js
```

The scoped producer/SDK run completed with **297 passes and five baseline
failures** (300-second bound):

```bash
python3 -m pytest -q \
  tests/test_producer_contracts.py \
  modules/worker-pool/lib/python/tests/test_quota_reserve_weekly.py \
  platform/app-sdk/python/tests/test_producer_readers.py \
  platform/app-sdk/python/tests/test_producer_contract_export.py \
  platform/app-sdk/python/tests/test_refresh_producer_contracts.py
```

All five failing assertions reproduce when loaded from exact `origin/main`
source: producer baseline equality; explicit schema declarations for the already
exported publication `accountProvenance`; each SDK snapshot's equality with the
fresh export; and the reader test's fresh-export equality. Neither producer
serialization nor the immutable SDK artifact/snapshots are changed here.
Weekly producer serialization and the new cross-language matrix passed.

An earlier broader Python attempt also exercised unrelated HTTP transport and
wheel tests: netguard refused their loopback connections, and the local wheel
builder failed. No successful Python wheel installation or HTTP integration is
claimed. Backend readers are unchanged; producer captures used disposable SQLite,
and Postgres was not exercised. No service activation was performed.

`npm run lint`, ESLint over every changed JavaScript file,
`npm run typecheck:contracts`, `bash demo/research-finding-walkthrough.sh`,
Ruff check/format on the changed Python test, and both repositories'
`git diff --check` passed.

The earlier `npm test` attempt reached its 960-second outer bound before
completing and reported auth, archive/rebuild and local-runtime failures.
That attempt did not establish a baseline or prove those failures unrelated;
no full-suite green or waiver of the CI gate is claimed. The 23 affected files
above completed green. The final 93-case policy file was rerun after making
its missing-floor case structurally absent and passed again.

## Review remediation verification

After rebasing onto freshly fetched trunk, the eight targeted files below
passed **312 tests**, with no failures, skips or cancellations (120-second
bound). The worker contract prohibits a full local suite; PR-head CI retains
that gate.

```bash
node test/run-tests.mjs \
  codex-per-worker-auth.test.mjs \
  codex-account-routing.test.mjs \
  codex-worker-account-routing.test.mjs \
  claude-account-routing.test.mjs \
  producer-contract-readers.test.mjs \
  reserve-floor-measurement.test.mjs \
  weekly-evidence-policy.test.mjs \
  refresh-reserve-floors.test.mjs
```

The auth file passes all 16 cases and imports only the auth materializer, not
the quota fixture helper; its import graph does not reach that helper. The
refresh regression runs the real Python script against a disposable producer
Git repository and verifies that root-level `reserve-floors.json` survives
byte-for-byte while deleted artifacts inside managed subdirectories disappear.
Its revision and full-export hash remain embedded in its own artifact; it is
maintained by `refresh-reserve-floors.mjs`, separately from `provenance.json`.

The installed pinned SDK evidence reader returns `source` alongside
`measurement` and `diagnostics`; the weekly wrapper forwards it. The policy
matrix now asserts that projection, including `source: null` when filtering
removes all evidence. Both routers retain the established
`reserveFloorWeeklyMeasurement` name and the same weekly-only policy. Refresh
tests verify lowercase output for lowercase, uppercase and mixed-case SHAs.

`npm run lint` (zero errors), `npm run typecheck:contracts`, the offline
research-finding demo and `git diff --check` also passed. No persistent model,
lifecycle transition, smoke promise or deployment step changes in this round.

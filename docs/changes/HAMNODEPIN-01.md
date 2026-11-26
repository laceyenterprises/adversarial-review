# HAMNODEPIN-01 — Use the target's Node runtime for hammer validation

The close controller's validator verifies the target checkout's Node
declaration. It exports the matching interpreter in `HAM_NODE_BIN` and puts
a private scratch directory with a `node` symlink first on PATH, including
commands invoked by the CI mirror. Review-service helpers retain the
interpreter used to build their native dependencies. Manifest pins take
precedence over numeric `.nvmrc` and `engines.node`. An unsupported `.nvmrc`
falls through to `engines.node`. Strict names are the case-normalized CFG `github.org` owner paired with
`agent-os` and `adversarial-review`. Missing, unusable or malformed strict pins
stop with counted `node-pin-undeclared`. Unrelated repositories keep the service
runtime when a declaration or installed match is unavailable, logging fallback
faults. Controller invocations require `HAM_REPO` owner/name. Standalone non-canonical
pytest skips Node resolution. A strict pin without an installed match defers as
UNKNOWN for a clean exact committed canonical head with declared required CI,
retaining inconclusive evidence and requiring controller drain before reuse.
Other strict runtime gaps retain retryable `node-pin-unavailable`.
Well-formed manifests with a non-exact or absent version fall through to the
remaining declarations before applying that missing-pin policy.

Operators may pre-install a bumped runtime to run local validation; qualifying
UNKNOWN handoffs instead use the required exact-head CI contexts. The runbook describes both
paths. Dedicated validator exits 80/81 preserve pin-stop classification without
a writable receipt; the controller normalizes the close status to 78. Node-pin terminal audit failures now
propagate their status as `procedure-step-failed` and release the lease.
PATH-setup diagnostic-write failures preserve the infrastructure exit and receipt.
The pnpm fixture uses the existing npm stub without a redundant Node override.

The validator checks `HAM_NODE_BIN`, its own interpreter and `AGENT_OS_NODE_BIN`.
This bounds version probes independently of PATH length and avoids a second
runtime resolver. Operators can expose an installed runtime through
`AGENT_OS_NODE_BIN`. A battery exit of 80 or 81 returns ordinary failure status
1 and retains the raw exit in its check evidence.

HAMNODEPIN-01 is a Node-specific case of MLR-06 requirement R-58 (S-58),
which distinguishes infrastructure failures
from findings. The v2 validator needs to honor the target's declaration,
classify a missing runtime as retryable, and preserve exact-head authority.
The manifest and missing-runtime fixtures in
`test/hammer-node-pin.test.mjs` cover that case. The direct `semver` dependency
is intentional for exact manifest versions and Node engine ranges. Its version
and integrity are pinned in the lockfile.

The synthetic fixtures cover the mirror, missing and mismatched
versions, and compatibility with both Node versions in the repository's CI
matrix. Runtime probes use load-aware deadlines. The exact-head GitHub checks
and local failure rules still govern merge eligibility.

## Interface changes

`validationNodeEnvironment` receives the validation scratch path so it can
expose only the selected Node binary on PATH. Node-pin failures now use validator
exit 80 (unavailable) or 81 (undeclared); the controller preserves close exit 78.

## Verification

`node --test test/hammer-node-pin.test.mjs`: passed. The focused
`hamcontrollerscript-01` refusal test passed. ESLint, shell syntax,
JSON parsing and `git diff --check` passed.

Final comment-only remediation adds regression coverage for non-exact manifest
fallback, audit exits 21/70, and simultaneous PATH-setup/phase-write failure.
`node test/run-tests.mjs test/hammer-node-pin.test.mjs` passed (8 tests);
the pnpm fixture passed (25 tests), and the focused controller refusal/audit
tests passed (2 tests). `npm run lint` passed with zero errors,
`npm run typecheck:contracts`, the offline demo, shell syntax, declaration JSON
parsing and `git diff --check` passed. Full-suite validation remains with PR CI.

The final fix-all round covers clean exact-head runtime-gap UNKNOWN handoff,
controller drain and evidence reuse, configured owner/name matching, unrelated
runtime fallback, and receipt-independent exit classification. Targeted runtime
and UNKNOWN suites passed (30 tests), followed by the final affected cases
(15 tests plus the standalone pytest/controller-identity case). Controller
refusal and audit cases passed (2 tests). Lint had zero errors; contract types,
offline demo, shellcheck, catalog validation, shell syntax and diff checks passed.
Data-model changes use the owning catalog fragment; main regenerates the aggregate.

The Node 22 CI repair gives the legacy canonical fixtures an explicit
synthetic GitHub organization and allows the config schema startup diagnostic
in CLI usage assertions. The fixtures still check that the legacy command
never runs and that invalid paths create no validation receipts.

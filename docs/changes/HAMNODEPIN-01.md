# HAMNODEPIN-01 — Use the target's Node runtime for hammer validation

The close controller's validator verifies the target checkout's Node
declaration. It exports the matching interpreter in `HAM_NODE_BIN` and puts
a private scratch directory with a `node` symlink first on PATH, including
commands invoked by the CI mirror. Review-service helpers retain the
interpreter used to build their native dependencies. Manifest pins take
precedence over numeric `.nvmrc` and `engines.node`. An unsupported `.nvmrc`
falls through to `engines.node`. Missing or unusable pins in `agent-os` and
`adversarial-review` stop with counted `node-pin-undeclared`; malformed JSON
declarations also use that counted outcome. Unrelated
repositories without a usable pin keep the service runtime. A declared pin
without an installed match stops with retryable `node-pin-unavailable`.
Well-formed manifests with a non-exact or absent version fall through to the
remaining declarations before applying that missing-pin policy.

Operators must pre-install a bumped `agent-os` manifest runtime on the validation
host before closure and expose it through the existing runtime candidates; the
deployed resolver may still return the older deployed runtime. The closure
runbook documents this prerequisite. Node-pin terminal audit failures now
propagate their status as `procedure-step-failed` and release the lease.
PATH-setup diagnostic-write failures preserve the infrastructure exit and receipt.
The pnpm fixture uses the existing npm stub without a redundant Node override.

The synthetic fixtures cover the mirror, missing and mismatched
versions, and compatibility with both Node versions in the repository's CI
matrix. Runtime probes use load-aware deadlines. The exact-head GitHub checks
and local failure rules still govern merge eligibility.

## Interface changes

`validationNodeEnvironment` receives the validation scratch path so it can
expose only the selected Node binary on PATH.

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

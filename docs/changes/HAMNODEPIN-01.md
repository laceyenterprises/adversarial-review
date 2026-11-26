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

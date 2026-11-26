# HAMNODEPIN-01 — Use the target's Node runtime for hammer validation

The close controller's validator verifies the target checkout's Node
declaration. It exports the matching interpreter in `HAM_NODE_BIN` and puts
its directory first on PATH for the local validation battery, including
commands invoked by the CI mirror. Review-service helpers retain the
interpreter used to build their native dependencies. Manifest pins take
precedence over `.nvmrc` and `engines.node`. Missing or unusable pins for Node
projects stop with the infrastructure reason `node-pin-unavailable`.

The synthetic fixtures cover the mirror, missing and mismatched
versions, and compatibility with both Node versions in the repository's CI
matrix. The exact-head GitHub checks and local failure rules still govern
merge eligibility.

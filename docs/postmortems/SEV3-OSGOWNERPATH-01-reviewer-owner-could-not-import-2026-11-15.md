# SEV3 — Reviewer proposal owner could not import its module

- Ticket: OSGOWNERPATH-01
- Incident evidence timestamp: 2026-11-15, approximately 06:00 UTC
- Scope: optional reviewer-arm proposals; ordinary reviews remained available

## Impact and evidence

The commissioned shadow trial produced no proposals. The supplied incident
probe counted 1,204 reviewer-arm reason lines, all `error-owner-unavailable`.
An exact reproduction of the daemon's interpreter invocation, environment and
working directory exited 1 with a module-not-found signature for
`cwp_dispatch`. The supplied process-environment and service-definition checks
found no interpreter override or Python module path. These are incident
observations supplied with the ticket, not fresh live probes by this change.

The shadow route retained the ordinary reviewer. This incident did not change
review verdicts, finding remediation, claim ownership or merge authority.

## Cause

The Node bridge launched a bare Python module from the review checkout, assuming
that interpreter selection also made Agent OS source packages importable.
It discarded stderr and collapsed process failure, deadline expiration and
JSON decoding failures into one reason. That hid the permanent import failure
behind a generic fallback. Existing routing tests injected the owner and
therefore did not exercise the process boundary.

A second fault would remain after fixing the import: measured owner imports
alone took 0.78–0.92 seconds under host load of approximately 52–75. Interpreter
startup, configuration and a ledger connection with a one-second connect timeout
could exceed the old 1.5-second deadline.

## Correction and budget

`src/agent-os-python.mjs` shares an explicit launch resolver. Deployment selection
reuses `AGENT_OS_DEPLOY_CHECKOUT` / `roots.deploy`, as used by
`src/dag-autowalk-on-merge.mjs`. Explicit source-package paths follow the working
HQ Python launcher pattern and the local explicit-path invocation pattern in
`src/argus-dependency-evidence.mjs`. The package roots include dispatch, config/core,
session ledger, dispatch core and top-level platform packages. Ambient
`PYTHONPATH` is replaced. The deployment also becomes the child's working directory.

Interpreter precedence is `HQ_PYTHON3`, `AGENT_OS_PY`, deployment-owned
`runtime/python/bin/python3` when present, then `python3`. Missing deployment
configuration fails open with a spawn reason rather than guessing a host path.

The owner uses a five-second nominal timeout, scaled by the existing
`adversarial.reviewer.load_aware.enabled` and `max_multiplier` configuration,
with an absolute 30-second ceiling. This provides startup/connection headroom
without restructuring the Python owner or adding shared schema keys.
An explicitly supplied transport timeout is bounded to 1–30,000 milliseconds;
non-finite overrides use the ceiling.

Spawn, module import, timeout, other exit and invalid JSON have distinct stable
tokens. A bounded private stderr tail is used only to classify module-not-found
signatures; it is never logged or returned. Every failure preserves the default
route. Output remains bounded.

## Sibling audit

| Caller | Evidence | Disposition |
| --- | --- | --- |
| `controller-process-census.mjs` | Absolute `controller_process_census.py` script path with `-I -B`; imports only `ctypes`, `errno`, `json`, `os`, `sys`, `time`. | No module-path dependency. |
| `codex-per-worker-auth.mjs` | Invokes resolved `codex-worker-auth-sync` script; that script uses its adjacent `agent_os_config_helper.py` through `runpy.run_path` and calls `ensure_agent_os_config_importable`. | Script owns config/core bootstrap. |
| `ama/ci-cost.mjs` | Absolute `scripts/ci-cost-guard.py` path; JSON-input engine uses standard-library imports. | No module-path dependency. |
| `pipeline-health-github.mjs` | Absolute `adapters/health/github-read.py` path; inserts the resolved adapter executable's sibling `src` into `sys.path`. | Script owns adapter bootstrap. |

Only the reviewer bridge needs the new shared resolver; there are no copied
module-path resolvers or companion repository changes. Merge order: this PR only.

## Verification and limits

`test/osg-reviewer-arm.test.mjs` passes 13 tests, including real subprocesses
against disposable synthetic packages. Coverage includes resolved interpreter
precedence, explicit package roots, ignored ambient paths, missing-module,
timeout, exit, spawn and invalid-JSON reasons, private diagnostics, default-route
preservation in apply/shadow, and a successful owner slower than 1.5 seconds.
Existing arm-selection and routing cases in that file remain green.

Tests run individually through the bounded worker-validation runner with a
600-second deadline and netguard. No live owner, ledger, review database,
daemon or service definition was exercised or changed. Live trial recovery
is not claimed by these offline fixtures.

Changed-source ESLint autofix passed without rewrites. Repository lint passed
with zero errors and 149 warnings outside the changed sources; contract
typechecking passed. The full test suite and walkthrough demo were omitted
under the ticket's scoped-test restriction.

The hardening memory search was available and returned no matching records.
The supplied failure-mode history reinforces testing the actual process
boundary and naming an unreadable mechanism. No merge-closure or shared-schema
contract changes, new checks, gates or labels are introduced.

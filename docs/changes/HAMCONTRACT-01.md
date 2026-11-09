# HAMCONTRACT-01

## Summary

Add an offline conformance test that extracts the hammer prompt's fenced Bash
commands, inline invocations and literal JSON examples, renders synthetic
coordinates, and executes each distinct documented call against the deployed
helper implementation. Repeated identical examples share an execution.
All four edit plans run through the real CLI, including its review and policy
reads. The claim example reaches the real claim binder and AMA predicate.

The test rejects usage errors, missing commands, shape refusals and shell
functions in argv-exec wrapper command positions. Unsupported command forms,
new helpers and unbound examples require explicit fixture coverage. It uses
disposable Git history and stores, PATH fakes, existing dispatch transport
fixtures, injected clocks and denied network access. No known-defect skip is
needed for the valid examples on this base.

## Interface changes

None. The existing test runner discovers `test/hammer-prompt-contract.test.mjs`.
No production helper, prompt policy, CI workflow, gate or label changes.
The operator-only post-merge receipt is declared in
`modules/worker-pool/post-merge-actions/hamcontract-01-conformance-receipt.yaml`.

## Verification

Run the individual test through the existing sandbox runner:

```bash
node test/run-tests.mjs test/hammer-prompt-contract.test.mjs
```

Worker validation uses `NETGUARD_LOG`, the netguard PATH and
`cwp_dispatch.worker_validation --timeout-seconds 600`. The test covers 37
documented command occurrences and six JSON examples. The PR retains a
deliberately invalid edit-plan `--help` invocation followed by its removal as
a red-then-green commit pair; it does not publish a broken final prompt.

Observed: three tests passed in 14.4 seconds, including 31 distinct command
forms and all four real-CLI edit plans. Changed-file ESLint, contract
typechecking and the byte-equivalence demo passed. Repository lint passed
with zero errors and existing unrelated warnings. The post-merge plan schema
accepted one operator step and zero automated actions.

The full host suite is intentionally not run under this ticket's scoped-test
constraint. Post-merge SRE must retain the normal main-suite result and the
red/green commit evidence before declaring verification complete.

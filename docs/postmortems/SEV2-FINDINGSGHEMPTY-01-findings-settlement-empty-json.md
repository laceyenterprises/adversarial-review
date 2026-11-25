# SEV2 — Empty or truncated JSON stranded findings during settlement

Ticket `FINDINGSGHEMPTY-01`, incident date 2026-11-25.

## Impact

During a period of high host load, multiple findings batches recorded
`Unexpected end of JSON input` and appeared to need operator intervention.
Some already had open fix PRs from successful workers. The collector left
their findings unresolved even though the work had been published. GitHub
server failures appeared near the batch errors. The available observations
do not establish why any particular read returned incomplete data.

## Cause and reproduction

The earlier `FINDINGSPUBSETTLE-01` repair handled transient command failures
and retried incomplete outcomes files locally. The numbered PR and branch
readers still parsed a successful command's stdout directly. An empty or
truncated response therefore raised a syntax error, which bypassed the
transient handler. An outcomes file that stayed incomplete after local
rereads also entered the terminal error path.

Before the fix, the synthetic numbered-PR regression returned `''` and
`'{"state":'` from the GitHub command stub. Both inputs produced
`Unexpected end of JSON input` in the batch row instead of leaving the
batch pending without an error. An overdue synthetic outcomes file also
recorded `batch-outcome-invalid-json` and released the batch.

## Repair and recovery

The collector classifies malformed external JSON as a transient publication
read failure and logs the operation and byte count. It keeps the original
batch and its findings together for the next normal tick. Previously errored
launched batches verify terminal preparation and resume settlement from their
retained outcomes. Settlement still requires the batch marker and a merged
PR or an open PR attached to review at its current head. Branch recovery
reuses the marked PR if its number was never written to the artifact.

Synthetic coverage exercises the next-tick retry, open PR recovery without
relaunch, and the existing handling of permanent GitHub failures. Deployment
and recovery of production batches remain unverified. After normal deployment,
the runtime owner can observe ordinary settlement and verify that eligible
legacy batches resolve to their existing PRs while fresh parse errors stay
out of the batch error summary.

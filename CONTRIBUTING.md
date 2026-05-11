# Contributing

Thanks for helping make adversarial review easier to fork, inspect, and extend. The safest contribution shape is to add domains through adapters, prompts, config, and fixtures while leaving `src/kernel/` stable.

## Architecture Contract

The review loop is split into a kernel and three adapter axes.

The kernel lives in `src/kernel/`:

- `src/kernel/verdict.mjs` parses and normalizes reviewer verdicts.
- `src/kernel/remediation-reply.mjs` validates remediation worker replies.
- `src/kernel/prompt-stage.mjs` selects `first`, `middle`, or `last` prompts from the round budget.
- `src/kernel/contracts.d.ts` names the adapter interfaces.

The adapter axes are:

- Subject channel: discovers and mutates the reviewed thing. Example: `src/adapters/subject/markdown-file/index.mjs`.
- Comms channel: publishes reviewer verdicts, remediation replies, and operator notices. Example: `src/adapters/comms/slack-thread/index.mjs`.
- Operator surface: syncs maintainer-facing triage state or override events. Example: `src/adapters/operator/linear-triage/index.mjs`.

`domains/<id>.json` is the wiring layer. It picks the subject channel, comms channel, operator surface, prompt set, reviewer routing, and risk-class round budgets.

## Worked Example: Add Your Domain

The reference domain is `research-finding`. It reviews a single markdown research finding, writes transcript deliveries to local JSONL files, and stubs Linear triage when no Linear credentials are present.

Start with `domains/research-finding.json`:

```json
{
  "id": "research-finding",
  "subjectChannel": "markdown-file",
  "commsChannel": "slack-thread",
  "operatorSurface": {
    "triageSync": "linear"
  },
  "promptSet": "research-finding"
}
```

To add your domain:

1. Copy that shape to `domains/your-domain.json`.
2. Set `id` to your domain id.
3. Point `subjectChannel` at the adapter that knows how to read and mutate your subject.
4. Point `commsChannel` at the delivery adapter you want to use.
5. Point `promptSet` at a folder under `prompts/`.
6. Keep risk classes explicit so the round budget is visible to readers.

For a markdown-document domain, you can start with `src/adapters/subject/markdown-file/index.mjs`. It implements the subject-channel methods by:

- Reading `subject.md`.
- Deriving a `sha256:<digest>` revision ref from file contents.
- Returning a subject ref with `domainId`, `subjectExternalId`, and `revisionRef`.
- Creating remediation workspaces under `workspaces/<jobId>/`.
- Recording remediation commits in `.markdown-file-state/<subject>/state.json`.
- Finalizing terminal state after convergence.

For your own subject, add a sibling adapter such as `src/adapters/subject/your-subject/index.mjs`. Keep the same contract names from `src/kernel/contracts.d.ts`: `discoverSubjects`, `fetchState`, `fetchContent`, `prepareRemediationWorkspace`, `recordRemediationCommit`, and `finalizeSubject`.

For local transcript delivery, start with `src/adapters/comms/slack-thread/index.mjs`. It is intentionally fixture-friendly:

- It writes `.slack-thread-transcripts/<subject>/slack-thread.jsonl`.
- It uses a stable delivery key with `domainId`, `subjectExternalId`, `revisionRef`, `round`, and `kind`.
- It computes `deliveryExternalId` from stable JSON so retries are idempotent.
- It stores reviewer verdicts and remediation replies as byte-stable JSONL records.

For your own comms surface, add a sibling adapter such as `src/adapters/comms/your-comms/index.mjs`. Implement `postReview`, `postRemediationReply`, `postOperatorNotice`, and `lookupExistingDeliveries`.

Then create all six staged prompt files. For `research-finding`, they are:

- `prompts/research-finding/reviewer.first.md`
- `prompts/research-finding/reviewer.middle.md`
- `prompts/research-finding/reviewer.last.md`
- `prompts/research-finding/remediator.first.md`
- `prompts/research-finding/remediator.middle.md`
- `prompts/research-finding/remediator.last.md`

For your domain, create the same names under `prompts/your-domain/`. The reviewer prompts must require the same verdict headings the kernel parser expects:

- `## Summary`
- `## Blocking issues`
- `## Non-blocking issues`
- `## Suggested fixes`
- `## Verdict`

The remediator prompts must ask for a remediation reply JSON object with `addressed[]`, `pushback[]`, `blockers[]`, and `reReview`.

Finally, add an end-to-end fixture test. `test/research-finding-end-to-end.test.mjs` is the regression-net worked example, and `demo/research-finding-walkthrough.mjs` mirrors the same byte-stable transcript contract as a smoke walkthrough. The end-to-end test:

- Builds a temporary fixture root.
- Copies `domains/research-finding.json`.
- Copies all six `prompts/research-finding/*.md` files.
- Writes `subject.md`.
- Runs a reviewer stub through `extractReviewVerdict`, `normalizeReviewVerdict`, and `sanitizeCodexReviewPayload`.
- Posts the verdict through `createSlackThreadCommsAdapter`.
- Validates a remediation reply through `validateRemediationReply`.
- Records a markdown-file remediation commit.
- Runs re-review and finalizes the subject.
- Asserts the `.slack-thread-transcripts/subject.md/slack-thread.jsonl` contents exactly.

That last byte-equivalence assertion is important. It catches accidental delivery-key changes, timestamp drift, unordered JSON, and transcript shape changes.

## Fixture Pattern

Fixtures live under `test/fixtures/` when they are shared snapshots, or in a temporary directory created by the test when they are domain-specific scratch data. Prefer temporary fixture roots for domain walkthroughs because they prove a fresh clone can run without hidden local state.

Naming conventions:

- End-to-end domain tests: `test/<domain>-end-to-end.test.mjs`
- Adapter tests: `test/adapters/<adapter-name>.test.mjs`
- Shared kernel snapshots: `test/fixtures/kernel/<name>.json`
- Shared adapter snapshots: `test/fixtures/adapters/<name>.json`

For byte equivalence, build expected records with the same stable serializer the adapter uses, then compare full lines with `assert.deepEqual`. The research-finding test uses `stableStringify` from `src/adapters/comms/slack-thread/index.mjs` and compares the entire JSONL transcript.

## Run Tests

```bash
npm test
```

If your change touches TypeScript contract declarations, also run:

```bash
npm run typecheck:contracts
```

## Pull Requests

Worker-generated PRs use title prefixes that identify the worker class, such as:

```text
[codex] add markdown policy finding domain
```

If you are contributing as a human from an existing clone, omit the worker prefix and use a normal descriptive title instead. Maintainers can route review and automation from the worker prefixes without asking outside contributors to participate in the private worker-class contract. Keep PRs small enough that one domain, adapter, or kernel behavior change can be reviewed independently.

For licensing, this project defaults to Apache-2.0 because it is permissive and includes an explicit patent grant. If maintainers decide MIT is a better fit later, that can be changed with project-level approval.

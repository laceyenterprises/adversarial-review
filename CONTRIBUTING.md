# Contributing

Thanks for opening this — we are happy to take outside contributions and
we've worked to make the shape of a "good first PR" obvious. This guide
covers:

- the architecture you're contributing into (and why it's shaped that way),
- a worked example of adding a new domain,
- the test discipline we expect,
- what we ask of pull request titles, descriptions, and review etiquette.

If anything below is unclear, the right move is to
[open an issue](https://github.com/laceyenterprises/adversarial-review/issues/new)
before writing code. We'd rather spend ten minutes aligning on intent
than send you on a rewrite.

---

## The shape of a good contribution

Most useful changes will land in one of four places:

1. **New adapter, new prompt set, new domain config.** This is the
   safest and highest-leverage shape. The kernel stays untouched; you
   add an adapter under `src/adapters/{subject,comms,operator,reviewer-runtime}/<name>/`,
   a `domains/<id>.json` wiring file, and a `prompts/<id>/` directory.
   The worked example below walks you through it file by file.
2. **A fix or extension to an existing adapter.** Add or update tests
   in `test/adapters/<adapter-name>.test.mjs`, and run the byte-
   equivalence assertions to confirm the durable delivery contract
   didn't shift.
3. **A kernel change.** This is the load-bearing one. Open an issue
   first; the kernel is small on purpose, and we'd like to understand
   the case before touching it.
4. **A doc, runbook, or test improvement.** Always welcome. See
   [`KNOWN-SHARP-EDGES.md`](KNOWN-SHARP-EDGES.md) for the punch list of
   honest rough edges.

If you're contributing as a human from an existing clone, you do **not**
need to use the internal worker-class title prefixes (`[codex]`,
`[claude-code]`, `[clio-agent]`) — those are maintainer-side
automation. Just give your PR a normal descriptive title. The CI
workflow that enforces the prefix checks GitHub's `author_association`
field and explicitly skips outside contributors. See the
[`AUTHOR_TAGGING.md`](AUTHOR_TAGGING.md) for the maintainer-side
context.

---

## Architecture contract

The review loop is split into a **kernel** and four **adapter axes**.
This split is the contract that makes contributions safe.

### The kernel

The kernel is intentionally small. It contains only behavior that is
shared across every domain — anything that varies by domain (subject
type, comms surface, operator triage, reviewer runtime) lives in an
adapter.

```
src/kernel/
├── verdict.mjs             ← parse and normalize reviewer verdicts
├── remediation-reply.mjs   ← validate remediation worker replies
├── prompt-stage.mjs        ← pick first/middle/last from the round budget
└── contracts.d.ts          ← typed adapter interfaces
```

The kernel does **not** import from `src/adapters/`. It does not know
the names "GitHub PR," "Slack thread," "Linear issue," or "markdown
file." If you find yourself reaching for one of those concepts from
inside the kernel, pause — the right answer is almost always an
adapter, or a new kernel-level concept that's intentionally name-free.

### The adapter axes

```
src/adapters/
├── subject/             ← what is being reviewed?
├── comms/               ← where do verdicts and replies get posted?
├── operator/            ← how is maintainer-facing state synced?
└── reviewer-runtime/    ← how is the reviewer process invoked?
```

Each axis is independent. A new domain can mix and match: GitHub-PR
subject + GitHub-PR comms + Linear operator surface (the production
pipeline), or markdown-file subject + JSONL Slack-thread comms + stubbed
Linear operator surface (the reference demo), or any combination you
need.

### The wiring layer

`domains/<id>.json` is the wiring file. It picks the four adapters, the
prompt set, the reviewer runtime, and the per-risk-class round budgets.
The full seam diagram lives in
[`docs/ARCH-adversarial-review-adapter-architecture.md`](docs/ARCH-adversarial-review-adapter-architecture.md).

---

## Worked example: add your own domain

The reference domain is `research-finding`. It reviews a single markdown
research finding, writes transcript deliveries to local JSONL files, and
stubs Linear triage when no Linear credentials are present. The whole
thing runs offline, which makes it a useful chassis to copy from.

### 1. The domain config

Start with `domains/research-finding.json`:

```json
{
  "id": "research-finding",
  "subjectChannel": "markdown-file",
  "commsChannel": "slack-thread",
  "operatorSurface": {
    "triageSync": "linear"
  },
  "promptSet": "research-finding",
  "riskClasses": {
    "low":      { "maxRemediationRounds": 1 },
    "medium":   { "maxRemediationRounds": 2 },
    "high":     { "maxRemediationRounds": 3 },
    "critical": { "maxRemediationRounds": 4 }
  }
}
```

To add your own domain:

1. Copy that shape to `domains/your-domain.json`.
2. Set `id` to your domain id (must match the directory under `prompts/`).
3. Point `subjectChannel` at the adapter that knows how to read and
   mutate your subject. Use an existing one (`markdown-file`,
   `github-pr`) if it fits.
4. Point `commsChannel` at the delivery adapter you want
   (`slack-thread` for local JSONL, `github-pr-comments` for live PR
   comments).
5. Point `promptSet` at a folder under `prompts/`.
6. Keep `riskClasses` explicit — even when the values match the
   defaults — so the round budget is visible to anyone reading the
   wiring.

### 2. The subject-channel adapter

For a markdown-document domain, start with
`src/adapters/subject/markdown-file/index.mjs`. It's small and it
implements the full subject-channel contract:

- Reads `subject.md` from a configurable root.
- Derives a `sha256:<digest>` revision ref from the file contents
  (deterministic, so re-runs over the same content collapse to the
  same revision).
- Returns a subject ref with `domainId`, `subjectExternalId`, and
  `revisionRef`.
- Creates remediation workspaces under `workspaces/<jobId>/` so the
  remediation worker has an isolated writable tree.
- Records remediation commits in `.markdown-file-state/<subject>/state.json`
  so the watcher can reconcile multiple rounds.
- Finalizes terminal state after convergence (writes a terminal record
  and clears any intermediate state).

For your own subject, add a sibling adapter such as
`src/adapters/subject/your-subject/index.mjs`. Keep the contract names
exactly as `src/kernel/contracts.d.ts` declares them:

- `discoverSubjects` — return a list of subject refs the watcher should
  iterate.
- `fetchState` — return the durable adversarial-review state for one
  subject ref.
- `fetchContent` — return the current content bytes (or whatever
  artifact the reviewer needs).
- `prepareRemediationWorkspace` — create a fresh writable workspace for
  the remediation worker.
- `recordRemediationCommit` — record a remediation round's mutation as
  a new revision.
- `finalizeSubject` — close out durable state on convergence or budget
  exhaust.

Implementing all six is enough. The kernel does the rest.

### 3. The comms-channel adapter

For local transcript delivery, start with
`src/adapters/comms/slack-thread/index.mjs`. It is intentionally
fixture-friendly:

- It writes `.slack-thread-transcripts/<subject>/slack-thread.jsonl`
  with append-only JSONL records.
- It uses a **stable delivery key** with `domainId`, `subjectExternalId`,
  `revisionRef`, `round`, and `kind` so identical retries collapse to
  the same record.
- It computes `deliveryExternalId` from stable JSON (sorted keys, fixed
  whitespace) so byte-equivalence assertions can compare full lines.
- It stores reviewer verdicts and remediation replies as byte-stable
  records — no embedded timestamps that drift, no unordered object
  keys.

For your own comms surface, add a sibling adapter such as
`src/adapters/comms/your-comms/index.mjs`. Implement:

- `postReview` — deliver a reviewer verdict.
- `postRemediationReply` — deliver a remediation worker's reply.
- `postOperatorNotice` — deliver an out-of-band operator notice (e.g.
  "round budget exceeded; falling back to lenient final round").
- `lookupExistingDeliveries` — return existing delivery records so the
  watcher knows what's already been posted (idempotency on retry).

### 4. The staged prompts

Create all six staged prompt files. For `research-finding`, they are:

```
prompts/research-finding/reviewer.first.md
prompts/research-finding/reviewer.middle.md
prompts/research-finding/reviewer.last.md
prompts/research-finding/remediator.first.md
prompts/research-finding/remediator.middle.md
prompts/research-finding/remediator.last.md
```

The kernel selects which of the three stages to use based on the
current remediation round and the per-risk-class round budget:

- **first** — first round, strict adversarial framing.
- **middle** — interior rounds; same framing, accumulated context.
- **last** — final round under the budget; *lenient* framing that
  escalates only substantive findings as blocking, so the loop
  terminates predictably.

The **reviewer prompts must require the same five verdict headings**
the kernel parser expects:

```
## Summary
## Blocking issues
## Non-blocking issues
## Suggested fixes
## Verdict
```

The kernel reads the line under `## Verdict` as either `Comment only`
(pass) or `Request changes` (fail). Anything else is a parse failure
and surfaces as a hard error.

The **remediator prompts must ask for a remediation reply JSON object**
with `addressed[]`, `pushback[]`, `blockers[]`, and `reReview`. See
`src/kernel/remediation-reply.mjs` for the full validator.

### 5. The end-to-end fixture test

Finally, add an end-to-end fixture test. `test/research-finding-end-to-end.test.mjs`
is the regression-net worked example, and `demo/research-finding-walkthrough.mjs`
mirrors the same byte-stable transcript contract as a smoke walkthrough.
The end-to-end test:

- Builds a temporary fixture root (so the test is hermetic).
- Copies `domains/research-finding.json` into the fixture root.
- Copies all six `prompts/research-finding/*.md` files.
- Writes a `subject.md`.
- Runs a reviewer stub through `extractReviewVerdict`,
  `normalizeReviewVerdict`, and `sanitizeCodexReviewPayload`.
- Posts the verdict through `createSlackThreadCommsAdapter`.
- Validates a remediation reply through `validateRemediationReply`.
- Records a markdown-file remediation commit.
- Runs re-review and finalizes the subject.
- Asserts the `.slack-thread-transcripts/subject.md/slack-thread.jsonl`
  contents are byte-for-byte equivalent to the expected transcript.

That last byte-equivalence assertion is load-bearing. It catches
accidental delivery-key changes, timestamp drift, unordered JSON, and
transcript shape changes — the four classes of regression that silently
break durable delivery if you don't pin them.

---

## Testing discipline

### Running the suite

```bash
npm test
```

This runs `node --test test/*.test.mjs test/adapters/*.test.mjs`. It is
hermetic — no network, no external services — and runs in CI on every
PR against Node 20 and Node 22.

If your change touches the TypeScript contract declarations in
`src/kernel/contracts.d.ts`, also run:

```bash
npm run typecheck:contracts
```

CI runs this as a separate step, so contract drift fails the build even
when the runtime `.mjs` modules still parse.

### The fixture pattern

Fixtures live under `test/fixtures/` when they're shared snapshots, or
in a temporary directory created by the test when they're domain-
specific scratch data. **Prefer temporary fixture roots** for domain
walkthroughs because they prove a fresh clone can run without hidden
local state.

Naming conventions:

| Kind | Location |
|---|---|
| End-to-end domain tests | `test/<domain>-end-to-end.test.mjs` |
| Adapter tests | `test/adapters/<adapter-name>.test.mjs` |
| Shared kernel snapshots | `test/fixtures/kernel/<name>.json` |
| Shared adapter snapshots | `test/fixtures/adapters/<name>.json` |

### Byte-equivalence assertions

For durable-delivery surfaces, build expected records with the **same
stable serializer the adapter uses**, then compare full lines with
`assert.deepEqual` (or `assert.strictEqual` on the joined transcript).
The research-finding test uses `stableStringify` from
`src/adapters/comms/slack-thread/index.mjs` and compares the entire
JSONL transcript — that's the pattern to mirror.

The reason byte-equivalence beats structural equivalence: a delivery
key whose serialized form drifts between code paths will break
idempotent retry, and structural assertions will pass right through it.

---

## Pull request etiquette

### Title

If you are contributing as a human from an existing clone, **omit the
worker prefix** (`[codex]`, `[claude-code]`, `[clio-agent]`) and use a
normal descriptive title:

```text
add markdown-policy-finding subject adapter
fix off-by-one in middle-round prompt selection
docs: expand kernel contract section
```

If you happen to be one of the maintainer's worker classes, use the
appropriate tag — the watcher routes off it:

```text
[codex] add markdown policy finding domain
[claude-code] tighten verdict parser for blank Summary
```

The repository CI workflow at
`.github/workflows/pr-title-prefix-validation.yml` explicitly skips
outside-contributor PRs (those with `author_association` below
`COLLABORATOR`), so the prefix is not a barrier to entry.

### Scope

Keep PRs small enough that one domain, adapter, or kernel behavior
change can be reviewed independently. If you're adding a domain end-to-
end (adapter + prompts + config + fixture test), the four together are
a coherent unit; splitting them is more friction than it's worth.

### Description

A useful PR description usually has three parts:

1. **What changed.** A short summary, no marketing.
2. **Why it changed.** The user-visible problem or contract gap. If
   you're adding a new domain, this is where you explain what the
   subject is and why same-model self-review is insufficient for it.
3. **How it was verified.** The test files you ran, any byte-
   equivalence assertions you added, and (if relevant) the demo
   walkthrough output.

### Adversarial review of human PRs

Outside-contributor PRs are not automatically routed to the cross-model
reviewer pipeline (because they don't carry the worker-class tag). A
maintainer will review your PR by hand. If you'd like a model review
*in addition*, mention it in the PR description and a maintainer can
manually retrigger the reviewer.

---

## License

This project is Apache-2.0. The explicit patent grant matters for work
in this space: there will be patents on "automated cross-model code
review" before long, and a permissive-but-grant-bearing license is the
cleanest answer for everyone downstream.

By submitting a contribution, you affirm that you have the right to
submit the code under Apache-2.0. We don't require a CLA.

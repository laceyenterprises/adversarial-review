# Adversarial Review Adapter Architecture

Adversarial Review separates the convergence loop from the systems that host reviewed artifacts. New domains plug in through adapters, prompts, and `domains/<id>.json`; they should not require changes under `src/kernel/`.

```text
                         domains/<id>.json
             wiring: subject + comms + operator + prompts
                                  |
                                  v
+-------------------+     +---------------------+     +-------------------+
| Subject Channel   |     |        Kernel       |     | Comms Channel     |
|                   |     |                     |     |                   |
| discover subject  +---->+ prompt-stage select +---->+ post verdict      |
| fetch content     |     | verdict parser      |     | post reply        |
| prep workspace    |     | remediation parser  |     | post notice       |
| record commit     |     | round-budget loop   |     | dedupe delivery   |
| finalize subject  |     |                     |     |                   |
+-------------------+     +----------+----------+     +-------------------+
                                      |
                                      v
                            +-------------------+
                            | Operator Surface  |
                            |                   |
                            | triage sync       |
                            | reviewer events   |
                            | override events   |
                            +-------------------+
```

## Kernel

The kernel owns behavior that should be shared across every domain:

- `src/kernel/verdict.mjs` parses the reviewer markdown and normalizes `Request changes` or `Comment only`.
- `src/kernel/remediation-reply.mjs` validates the remediation worker JSON reply.
- `src/kernel/prompt-stage.mjs` selects `first`, `middle`, or `last` prompts from review attempt, remediation round, and max budget.
- `src/kernel/contracts.d.ts` defines the subject-channel, comms-channel, operator-surface, verdict, delivery, and remediation-reply contracts.

The kernel should not import domain-specific adapters or name concrete systems like markdown files, Slack transcripts, GitHub PR comments, or Linear issues.

## Adapter Axes

The subject-channel adapter is responsible for the reviewed artifact. `src/adapters/subject/markdown-file/index.mjs` is the small reference implementation: it reads `subject.md`, hashes the markdown into a revision ref, prepares a local remediation workspace, records the changed revision, and marks the subject terminal after convergence.

The comms-channel adapter is responsible for delivery. `src/adapters/comms/slack-thread/index.mjs` is a JSONL fixture implementation: it writes review and remediation deliveries to `.slack-thread-transcripts/<subject>/slack-thread.jsonl` with stable delivery keys and idempotent external ids.

The operator surface is responsible for maintainer-facing status. `src/adapters/operator/linear-triage/index.mjs` maps lifecycle states onto Linear issue states when a subject ref includes a Linear ticket id, and otherwise becomes a no-op fixture surface.

## Domain Config

`domains/research-finding.json` shows the wiring layer:

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
    "low": { "maxRemediationRounds": 1 },
    "medium": { "maxRemediationRounds": 2 },
    "high": { "maxRemediationRounds": 3 },
    "critical": { "maxRemediationRounds": 4 }
  }
}
```

To add a domain, create:

- `domains/<id>.json`
- `prompts/<id>/reviewer.first.md`
- `prompts/<id>/reviewer.middle.md`
- `prompts/<id>/reviewer.last.md`
- `prompts/<id>/remediator.first.md`
- `prompts/<id>/remediator.middle.md`
- `prompts/<id>/remediator.last.md`
- Subject, comms, or operator adapters only when existing adapters do not fit.
- A fixture test that proves review, remediation, re-review, and convergence without external network calls.

The extension point is the adapter/config/prompt boundary. If adding a domain requires changing verdict parsing, remediation-reply validation, or round-budget selection, pause and decide whether the domain is exposing a true shared kernel need or leaking adapter behavior into the kernel.

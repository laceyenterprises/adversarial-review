# AGENTS.md — Builder Primer

This repo is the Agent OS **gate-keeper**: cross-model adversarial PR review
plus the MSM merge authority that decides when agent-built PRs land. It is
deliberately an **independent failure domain** — its own repository (vendored
into agent-os as the `tools/adversarial-review` submodule), its own CI, and a
test suite that runs fully offline with no GitHub token, network, or Agent OS
host. A bug here can wave bad code into every downstream repo, so hold every
change to maximum rigor and keep the offline test property intact.

## Where code belongs

| Path | What lives there |
|---|---|
| `src/kernel/` | Stable review-loop contracts: verdict parsing, remediation-reply validation, prompt-stage selection. Small and typed — extend deliberately, don't fork. |
| `src/ama/` | Merge authority (MSM): eligibility predicates, daemon inline merge, hammer dispatch, leases, audits. |
| `src/adapters/` | Pluggable seams: `subject/`, `comms/`, `operator/`, `reviewer-runtime/`. New domains add adapters here, never kernel edits. |
| `src/` (root) | The GitHub-PR production daemons (`watcher.mjs`, `follow-up-*.mjs`) and supporting modules. |
| `domains/`, `prompts/` | Domain wiring configs and staged reviewer/remediator prompt sets. |
| `test/` | `node:test` suites; fixture-driven, offline. Behavior changes need a matching test. |

## Validation gate — every change, no exceptions

All four run offline; a change that breaks the offline property is wrong:

```bash
npm run lint                 # ESLint over src/ and bin/ (0 errors required)
npm test                     # full kernel + adapter + daemon suite
npm run typecheck:contracts  # tsc over the kernel contract types
bash demo/research-finding-walkthrough.sh   # end-to-end byte-equivalence demo
```

Anything touching the watcher claim/dispatch path must keep
`test/watcher-claim-loop.test.mjs` green — that suite pins the pollOnce
claim-loop hot path (the single-claim CAS is the duplicate-review guarantee).

## PR titles

Internal worker-class PRs MUST carry the creation-time title prefix
(`[codex]`, `[claude-code]`, `[clio-agent]`) — see `AUTHOR_TAGGING.md`. The
watcher routes the cross-model reviewer off that prefix once, at creation; a
missing/unknown prefix is a fail-loud **terminal `malformed` row** (no
reviewer is spawned, and retitling does not retrigger). Use
`npm run pr:create:tagged` rather than remembering the tag by hand.

## Merge authority (MSM) — read before touching closure code

The two-path merge model (hammer = common path with findings/CI repair;
daemon inline merge = rare zero-finding path; kill switch
`autonomous_merge_execution_enabled`) is documented in
`docs/RUNBOOK-ama-closure.md` — that runbook plus `docs/STATE-MACHINE.md`
("MSM two-path merge authority") are the in-repo source of truth. Both paths
share `src/ama/merge-eligibility.mjs`; its fail-closed empty-rollup behavior
and the fail-open `summarizeChecksConclusion` classifier are intentionally
different — do not unify them.

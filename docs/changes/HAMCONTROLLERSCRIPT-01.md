# HAMCONTROLLERSCRIPT-01: the closer's close controller is shipped code

## Summary

The hammer and merge-agent closer prompts no longer ask the model to transcribe
a long rebase/validation/merge shell script into the run directory. That
transcription could fail before any closure work ran. The model could rewrite
the stdin and terminal plumbing, source inputs out of order, or name a shell
function as a command. Each such slip ended the run in controller setup.

The controllers are now versioned scripts in `bin/`. The model writes only data
and runs one command:

- **Hammer:** `/bin/bash <root>/bin/hammer-close.sh <run-dir>/close-plan.json`.
  The launcher sources the run's `inputs.sh` itself, resolves the launch
  environment, then runs `bin/hammer-close-controller.sh` under
  `hammer-controller.mjs run`. The controller performs every closing step in
  order: it publishes a local commit the PR lacks, then runs verify-head with
  bounded outside-lease revalidation. It then publishes the audit, waits for
  exact-head CI, refreshes the predicate inputs and builds the claim. Finally it
  runs the predicate and the in-lease merge. Every stop writes
  `<run-dir>/close-result.json` (`status`, `outcome`, `stage`) and keeps the
  phase's own exit code.
- **Merge-agent final pass:** `node <root>/bin/hammer-controller.mjs run
  <root>/bin/merge-agent-close-controller.sh --repo R --base B --pr N --commands
  "$HAM_RUN_DIR/close-commands.json"`. The script is the former prompt body: it
  takes the lease for its own shell pid, and its EXIT trap releases the lease.
  It runs the GENCONFLICT rebase and the revalidation, checks protective
  predecessors and CI cost, and merges with `--match-head-commit`, never with
  `--admin`. Validation commands are JSON data run as direct children of the
  controller shell.

All shipped scripts begin with `exec 0</dev/null` and never read `/dev/tty` or
`/dev/stdin`, so they behave the same in a non-tty exec sandbox.

`ham_gh`, `ham_git` and `ham_pr` are shell functions. A bounded helper step
that names one of them as its command used to spawn it and fail with
`ENOENT`. `bin/hammer-helper-step.mjs` now resolves these names to the
deployed executables by absolute path (`src/ama/hammer-shell-helper-command.mjs`).
The inputs file's `ham_step` now executes the helper with `$HAM_NODE_BIN`
instead of relying on the helper's `#!/usr/bin/env node` shebang, so a minimal
`PATH` still works. The shipped controller calls its bounded reads the same
way.

A setup stop (exit 125, or a helper timeout 142/143) is retried by rerunning
the same close command in the same workspace within the run. The prompt's G2
rule now says so explicitly.

## Interface changes

- New: `bin/hammer-close.sh`, `bin/hammer-close-controller.sh`,
  `bin/hammer-close-plan.mjs`, `bin/merge-agent-close-controller.sh`,
  `bin/close-commands.mjs`, `src/ama/hammer-shell-helper-command.mjs`.
- New closer data files: `<run-dir>/close-plan.json` (`auditDetailsFile`,
  `remediated.{total,blocking,nonBlocking}`, `failingTestsFixed`,
  `docCurrency.{status,reason}`, optional `validationFiles`) and the
  merge-agent's `close-commands.json` (`validations[].{pytest,args}`).
  Invalid data exits 65 (`close-plan-invalid` / `close-commands-invalid`)
  before any environment read, controller or lease.
- New closer-origin stop reasons: `close-plan-invalid`,
  `predicate-build-failed`.
- `templates/hammer-prompt.md`: one close command replaces the transcribed
  controller and the phase wrapper. The exit-code table is keyed by the close
  result `stage`. Appendix E1's identity repair runs after the close command
  releases its lease, then reruns the close command once. That is the same
  outside-lease push rule conflict repair already follows.
- `src/merge-agent-prompt.mjs`: the final-pass controller body is replaced by
  the shipped script invocation.
- `hammer-controller.mjs run`, the lease, strict mode, review verdict semantics
  and every merge predicate are unchanged.

## Not in this change

Reusing a provisioned workspace across a *new* closer dispatch, after a run
has already ended on a setup fault, needs the agent-os provisioning seam to
adopt a terminal, clean, same-head workspace. The current dispatch policy is
to never reuse a predecessor's retained directory. This change removes the
dominant cause of those re-dispatches and keeps the retry inside the run. The
cross-dispatch reuse is a follow-up.

## Verification

Each command ran under the netguard environment, bounded to 600 s:

- `node --test test/hamcontrollerscript-01.test.mjs`: 10/10 pass. The hammer
  close runs detached (no controlling tty) with fd 0 closed. The lease is
  acquired, held through merge and released on every path, and the merge runs
  on the exact head. Refusal paths are covered: conflict exit 21, predicate not
  eligible, failed validation, missing inputs and invalid plan. The merge-agent
  controller is covered for a successful `--match-head-commit` merge and for
  every refusal: an open protective predecessor, CI cost, validation, a parked
  lease and invalid commands. `ham_gh` resolves with `PATH=/nonexistent`.
  Neither prompt carries a controller shell body.
- These files also pass: `ama-hammer-merge-protocol-prompt` (45),
  `hammer-prompt-contract` (6), `hammertrim-contract` (53),
  `hammer-controller` (112), `hammer-helper-step`, `hammer-scratch` (80),
  `follow-up-merge-agent`, `lvr-no-op-outcomes` (20), `run-bounded` (16),
  `hamselferrors-01`, `inconclusiveretry-01b` (14),
  `hammer-procedure-generation` (11), `ama-closer-lease-finalization`,
  `ama-hammer-retry-cap` and `hammer-token`.
- `npx eslint` on the changed sources: 0 errors. `npm run typecheck:contracts`
  passes. `shellcheck -S warning` passes on the three shipped scripts.
- The rendered hammer prompt is 59,021 bytes, under the 60 KiB budget.

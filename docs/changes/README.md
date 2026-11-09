# Repository change notes

Write repository-level notes in `docs/changes/<TICKET-ID>.md` (for example,
`docs/changes/LAC-2161.md`). Use the PR's ticket, not a closer's HAM ticket;
remediation updates that ticket's file. If a change has no ticket, use
`PR-<number>.md` once the PR number is known. Existing module-local fragments
remain valid for their module; do not duplicate the same note here.

The repository-level notes in `changes/*.md` and `src/changes/*.md` are historical.
Preserve them in place. Write new repository-level notes only in `docs/changes/`.
Both historical directories sit at repository scope, separate from module-local fragments.

Include Summary, Interface changes (or none), and Verification with commands
and observed results. Link a longer report when useful. Browse this directory
or search filenames for the ticket; no hand-maintained ticket index or generated
rollup is required. Independent tickets write independent paths.

The root README's `## Change notes` section is historical. Preserve its entries;
do not append or prepend new ticket notes there. Correct canonical README,
walkthrough, data-model and state/smoke documentation in place when the actual
contract changes. A fragment satisfies note currency, not stale contract text.
This convention adds no CI check, merge gate, waiver or runtime policy.

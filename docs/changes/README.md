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

[Historical root README notes](ARCHIVE-readme-change-notes.md) are preserved in
an archive. Correct the owning topic page, walkthrough, data-model doc or
declared state/smoke page when its contract changes. Use the root README as
the repository front page.

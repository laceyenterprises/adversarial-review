# SEV3 — Root README notes conflicted independent PRs

- Date: 2026-11-07
- Ticket: LAC-2161 / ARROOTNOTES-01
- Scope: repository documentation contribution policy

## Impact and evidence

Five independent PRs ([#1720](https://github.com/laceyenterprises/adversarial-review/pull/1720),
[#1722](https://github.com/laceyenterprises/adversarial-review/pull/1722),
[#1725](https://github.com/laceyenterprises/adversarial-review/pull/1725),
[#1726](https://github.com/laceyenterprises/adversarial-review/pull/1726),
[#1727](https://github.com/laceyenterprises/adversarial-review/pull/1727))
were reported conflicting at the root Change notes insertion after reviewed
work landed. Resolving a documentation-only collision moves the head and can
require another review, extending closure work without changing the feature.
Read-only inspection during this RCA found #1720 merged, #1722/#1726/#1727
conflicting, and #1725 mergeable; these are snapshots, not a claim that all five
remain conflicted. Read-only PR diff inspection confirms all five insert directly
under `## Change notes` (four at old line 4559, #1725 at 4561); #1725 also
corrects canonical README sections, which remain required. No active rescue
branch or live pipeline state was changed.

## Source cause

Root `AGENTS.md` required new notes under the root README's `## Change notes`,
newest first, and explicitly excluded that log from the module fragment rule.
Every contributor therefore inserted at the same line. The README history also
contained the older CONFLICTHOTSPOT-01 exception. Those historical entries are
retained as history, with the active convention linked above them.

[#1686](https://github.com/laceyenterprises/adversarial-review/pull/1686) allowed
module fragments in staged reviewer/remediator and closer prompts, but did not
remove the repository exception. No executable root-note validator was found
in source or tests. The enforcing readers were contributor instructions and
model prompts; runtime merge eligibility was not the source of the collision.

## Reproduction and correction

`test/root-change-notes.test.mjs` initializes disposable Git repositories with
the real root README, then makes five independent branches with disjoint
implementation files. Old-style insertions conflict only in README.md, in both
integration orders. The same five branches using separate per-ticket paths all
merge in both orders, preserving every note, implementation file and README
byte. This isolates the source mechanism; it does not replay historical PR heads.

New repository notes use `docs/changes/<TICKET-ID>.md`, discovered through the
root README and AGENTS.md. There is no shared ticket index to update. Remediation
updates the original ticket record. Existing history stays in place. Affected
reviewer, remediator and closer readers accept the repository convention while
retaining canonical contract-currency obligations. No CI check or merge gate is
added, and existing review, required checks, claim CAS, terminal-state handling
and configuration loaders remain unchanged.

## Overlap and limits

[#1727](https://github.com/laceyenterprises/adversarial-review/pull/1727) is an
open clarification of hammer responsibility for omitted **module** fragments
and the original PR ticket identity. This change keeps that responsibility and
does not duplicate its implementation. Both touch the documentation-currency
paragraphs, so normal integration may need textual reconciliation.

Agent OS [#10248 / MERGEHOTSPOT-01](https://github.com/laceyenterprises/agent-os/pull/10248)
addresses superproject fingerprints, catalogs and module README append hotspots.
This is the remaining adversarial-review root exception; no companion repository
edit, generated catalog change, review carry-forward waiver or merge-policy
change belongs here. Existing in-flight branches may still carry old-style
notes and need normal conflict reconciliation; this convention prevents new
independent tickets from creating that shared hunk. Ordinary offline repository
gates and existing prompt protocol tests remain the validation path. Full-suite limitations, if any, are
reported with the PR's acceptance evidence.

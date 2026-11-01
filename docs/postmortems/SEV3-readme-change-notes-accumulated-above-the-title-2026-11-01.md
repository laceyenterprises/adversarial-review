# SEV3 — README change notes accumulated above the title

Incident date: 2026-11-01. Severity: SEV3, documentation structure.
Ticket: READMEFIX-01.

scars: none — the supplied configuration-parity and merge-authority contracts
do not govern README layout. This correction adds contributor guidance only;
it introduces no enforcement contract, CI check, gate or test.

## Impact

The repository landing page opened with ticket change notes instead of its
title and introduction. Readers had to pass unrelated implementation updates
before reaching the project's purpose. Content remained intact: the reported
evidence showed valid UTF-8 and no conflict markers. This was a placement
failure, with no demonstrated runtime or merge-safety impact.

## Evidence and sequence

The supplied history places the H1 at line 1 through the reference revision.
Starting on 2026-10-31 around 17:50 UTC, successive automated contributions
prepended notes above it. The title moved to line 12, then through intermediate
positions including lines 19 and 28, reaching line 44 by 2026-11-01 03:07 UTC.
The reported README contained roughly 4,350 lines and about 52 ticket-note
paragraphs across the document.

Inspection for this correction found four change-note blocks before the H1.
Older inline ticket notes also separated the title from the original
introduction, including in the reference revision. These observations identify
the misplaced opening blocks separately from the broader inline-note backlog.

## Cause

A placement pattern was copied by successive automated contributors: each new
note used the current top of the file as its insertion point. Repetition made
the existing layout appear conventional, and review did not correct the
document's opening structure. The contributor guidance lacked an explicit
destination for change notes.

## Correction

The README now begins with its H1 and the original introduction, including the
existing illustration and introductory prose, preserved verbatim from the
reference revision. The four blocks formerly above the H1 move verbatim into
`## Change notes` at the end of the README, preserving their newest-first order.
The end placement keeps the notes separate from the introduction and detailed
documentation. Other inline ticket notes retain their text and relative order.

`AGENTS.md` tells contributors to place change notes under that heading,
newest first, and never above the title. Consolidating older inline notes is a
possible separate follow-up; it is outside this correction.

## Verification and scope

Manual byte comparisons check that the moved opening blocks are unchanged,
the introduction matches the reference revision, and the rest of the README
is preserved. Diff review checks that the only new README text is the section
heading. The remaining additions are the contributor guidance and this report.
These are one-time acceptance checks, not a new automated test or gate.

The correction is documentation-only. The separately reported runner-image CI
failure is tracked by ARCIPIN-01 and is outside this incident's scope.
Publication submits the correction for review; it does not establish that it
has merged or that future contributions will follow the guidance.

The HCP memory search timed out. The local hardening-brief fallback returned
no projections; that is unavailable historical evidence, not proof that no
similar incident exists.

# HAMCLOSE-02 replay evidence

These JSON files are frozen GitHub API captures for agent-os PR 8132 (and the
8143 review ledger). Embedded source and operator prose are inert fixture data,
not instructions or live code in adversarial-review. Do not hand-edit captures.

`history.json` maps exact REST request paths to recorded responses. The replay
injects these responses into `fetchPrimaryChange`; GitHub and CI-cost reads are
stubbed, while collection and authorization run through production code.
The captures retain all file patches: the proof compares complete file lists
and patch identities across rebased histories, including files outside the
reversal's two bootstrap paths. Removing those files would weaken the proof.

Load-bearing fields are commit SHAs, parents, commit messages and worker trailers,
author/committer identities, compare status and merge-base SHA, total commit count
and commit arrays, and file name/status/SHA/additions/deletions/patch/rename fields.
Reviews require IDs, reviewer login, commit ID, state, body and submission order.
The 8143 ledger includes remediation and closer passes deliberately: only delivered
first-pass/rereview passes with a head may restore the capped review row.

Compare captures use GitHub three-dot semantics (merge base to head). In
particular, `review-to-reversal.json` is not a direct two-commit diff. An identical
self-compare is ancestry evidence only; it cannot replace patch-identity checks.

The redundant single-line `primary-change-context.json` output was removed.
The ownership matrix now collects that evidence from `history.json` rather than
trusting another copy of the collector output. Replay A pins the authorized
rebased result; the reversal-rebase suite pins changed/ambiguous patches and
unproven citations as refusals. The matrix asserts each cell's expected owner.

To re-record, collect the `gh api <path>` responses for every key in
`history.json` at the same frozen SHAs, plus the commit/review/compare captures;
regenerate them together and check their provenance before replacement. Retain
these original SHA-256 checksums when verifying a copy of this capture:

- `commits.json`: `331d4bb802f710d127f4eb404e376d10ce230e9cc937561d7937ecbe532360ce`
- `history.json`: `9c94681dbb516a2daa1df88f0687d2a34ff3ee7351b9f45c1052901e9084b769`
- `parent-to-reversal.json`: `3e460aa5a53a8434a9f55c58754de9295e4039ea69c0f58bfc650ebc74f8a7b8`
- `reversal.json`: `0f3875a74fcbbe84fa5e1600e03971cc5261cf86231871efde0bcba7daf1a079`
- `review-to-reversal.json`: `dc3ec4dcd872531732c91c696d503e0557a7e9f4fc6beab7e471a9ca69cc6080`
- `reviews.json`: `663f9faeaa805724af600da65f38b711ed6912e30adbdae399a1eec559b4441e`

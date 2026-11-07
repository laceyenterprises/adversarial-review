# Large review diffs

REVIEWLARGE-01 addresses the oversized-review failure described by the
MERGEHOTSPOT-01 SEV report in agent-os.

Before prompt sizing, reviewers replace declared generated files and verified
pure moves with a manifest containing paths, added/removed line counts and
SHA-256 content hashes. Moves also name their source. The posted review carries
the manifest, so readers can see which content was summarised. Original diffs
remain available to head grounding, scope classification and delivery binding.

A host repository can declare exact generated paths in
`.github/review-generated-paths.json`:

```json
{
  "generatedPaths": [
    "fixtures/generated/sample.json",
    "docs/generated/catalog.json"
  ]
}
```

The declaration is read at the immutable PR base SHA, never at the PR head.
Wildcards and relative traversal are unsupported. An unavailable, malformed or
unpinned declaration exempts nothing. Files whose content cannot be read retain
their inline diff. Changing the declaration in a PR takes effect for subsequent
PRs once that declaration is part of their base.

Git `-M100% -C100% --find-copies-harder` detection identifies exact renames and
copies when the pinned objects are available locally. Source and destination
blob hashes must agree. Whole-file additions and deletions can also prove
one-to-many splits: the added files must cover the deleted file exactly, with
no gaps, overlaps or changed bytes. Partial matches, executable-mode changes,
unparseable patches and ambiguous splits retain ordinary inline review.

Prompts that remain oversized use the existing deterministic file-group chunk
planner, including its head-line provenance and split-hunk context. Every
chunk must complete and validate before aggregation. Any blocking finding
blocks the combined verdict; file and line fields remain intact. The posted
summary discloses chunking. A typed prompt-size failure is retried inside the
review attempt with summarisation and then bounded chunking; quoted model text
does not trigger recovery. Only exhausted recovery reaches the existing
operator path, with the chunking or budget refusal reason preserved.

No size recovery changes merge eligibility or authorises merging without a
settled review of the current head.

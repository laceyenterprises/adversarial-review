# SEV2 — Reviewer narration caused completed chunks to be discarded

## Impact

Eight rejections across two days cited text before the first required heading.
One large change incurred four rejections and went 3.7 hours without a posted
verdict. Each failure could discard roughly 30 minutes of reviewer work and
consume another high-effort pass on the same changes.

## Cause

The harness validated every chunk's raw reply before merging. A progress
sentence such as “I checked the fixture and wrote up the findings.” could
precede a complete `## Summary` through `## Verdict` reply. The reply
validator rejected the prefix, and the chunk loop exited before it could use
any earlier findings. A subsequent whole-review attempt could hit the same
pattern.

## Correction and verification

The harness removes a preamble of at most three non-empty lines and 400
characters when the five required sections follow and the body passes reply
validation. Headings, fences, placeholders and verdict terms disqualify the
preamble. The log records the removed byte count. The existing validator still
checks the reply and the actual posting body.

The harness retries a rejected chunk once under the existing timeout plan. It
keeps earlier chunks, records each rejection separately, and fails through the
existing path if the retry also rejects.

The read-only probe found that all eight suffixes passed the unchanged
validator. Seven prefixes met the new rule. The remaining prefix contained a
verdict word and still rejects. Synthetic tests cover those boundaries,
template echoes, retained findings, two rejection records and deadline expiry.
The change note records offline verification. [REVIEWPREAMBLE-01](../changes/REVIEWPREAMBLE-01.md)

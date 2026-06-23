## Summary
One addressable blocking finding remains in the classifier.

## Blocking issues
- **Preserve multi-line finding fields**
  - **Category:** correctness
  - **File:** `src/merge-agent-rescue-classifier.mjs`
  - **Lines:** `60-68`
  - **Problem:** The first sentence is on the label line.
    The second sentence is wrapped onto the next indented line.

    The third sentence starts a new paragraph.
  - **Recommended fix:** Accumulate indented continuation lines until the next nested field.

## Non-blocking issues
- None.

## Suggested fixes
- Preserve the classifier contract asserted by this fixture.

## Verdict
Request changes

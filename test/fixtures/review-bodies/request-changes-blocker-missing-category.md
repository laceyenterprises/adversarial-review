## Summary
This fixture omits a blocking category on purpose.

## Blocking issues
- **Blocking finding missing category**
  - **File:** `src/merge-agent-rescue-classifier.mjs`
  - **Lines:** `44-72`
  - **Problem:** A blocking finding without a nested `**Category:**` bullet must still match the live reviewer contract.
  - **Recommended fix:** Keep missing-category blockers in the remediation path unless another un-addressable signal is present.

## Non-blocking issues
- None.

## Suggested fixes
- Preserve the classifier contract asserted by this fixture.

## Verdict
Request changes

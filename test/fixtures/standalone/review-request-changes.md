## Summary
The change trims the name before greeting but does not guard against a missing name.

## Blocking issues
- **Unguarded trim on undefined**
  - **File:** `lib/greeting.js`
  - **Lines:** `2-3`
  - **Problem:** `const label = name.trim();` throws a TypeError when `greet()` is called without an argument; no guard on the preceding line checks the type.
  - **Why it matters:** A caller that previously received `Hello, undefined` now crashes.
  - **Recommended fix:** Coerce with `String(name ?? '').trim()` or validate the argument.

## Non-blocking issues
- None.

## Suggested fixes
Guard the argument and add a test for the missing-name case.

## Verdict
Request changes

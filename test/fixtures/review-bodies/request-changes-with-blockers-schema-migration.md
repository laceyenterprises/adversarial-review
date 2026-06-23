## Summary
The remediation path still requires a schema migration.

## Blocking issues
- **Schema migration required for remediation ledger**
  - **Category:** schema-migration
  - **File:** `platform/session-ledger/src/session_ledger/schema.py`
  - **Lines:** `12-44`
  - **Problem:** The new remediation ownership record depends on a table shape that is not present in production.
  - **Recommended fix:** Ship and apply the required schema migration before enabling this route.

## Non-blocking issues
- None.

## Suggested fixes
- Preserve the classifier contract asserted by this fixture.

## Verdict
Request changes

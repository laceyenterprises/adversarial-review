# FINDINGSBATCHADOPT-01 — Recover findings-batch dispatch receipts by key

If dispatch fails or times out, the collector reads the scoped launch ledger.
It adopts a matching preparation launch and resumes normal collection. A
matching publication launch fences another publication. A readable empty
probe preserves the existing error behavior, and an unreadable probe leaves
custody unresolved for a later pass.

Preparation and publication use distinct idempotency keys because they carry
different prompts and completion shapes. Collection and release still recognize
legacy publishers and respect existing publication intents and retry budgets.

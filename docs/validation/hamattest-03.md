# HAMATTEST-03: terminal hammer review handoff

SEV2, report SEVDOCS-155. A feature PR remained open after its hammer published
a closer-trailer head and its launch succeeded without merging. Ordinary refresh
was suppressed, hammer wake chose exact-head review, and closure kept refusing
the stale review until an operator requested re-review.

Operator direction: "make sure none of the PRs get orphaned ... diagnose, open SEVs and dispatch RCA fixes"
(to the SRE session).

The supplied incident logs establish the suppression, refusal and successful
manual review recovery. They do not include the publication comments or the
resolved provenance proof, so they cannot establish whether that particular
hammer recorded an edge or precisely why its carry-forward failed. No live host
state was accessed to fill that evidence gap.

The offline fixture records an authenticated, unvalidated pushed edge from an
intermediate head to the new head. That edge exists, but the chain cannot reach
the older reviewed head. The shared proof correctly returns
`hammer-app-attestation-missing` and `rereview-exact-head`; a closer trailer alone
cannot authorize carry-forward. A complete authenticated bridge still carries
the clean verdict and leaves exact-head checks mandatory.

The execution defect is in coexistence: closure can attach a bounded wait to a
refusal, including a consumed background `not-eligible` result. Coexistence then
returns before the orphan watchdog, so the computed review decision has no
actor. The old tests called recovery directly or supplied a result without the
bounded wait, missing this production return path.

A second fixture records the complete reviewed-to-published bridge, then returns
no authoritative live review body. Carry-forward rejects it with
`verdict-not-settled-success` and `blocking-findings-unknown`. The review owner is
selected, but the wrapper replaces it with wait, and the watchdog recognizes
only the missing-provenance form of the decision. This reproduces the reported
reason tuple even with publication provenance present.
At the final-round ceiling, the legacy owner can additionally become page even
though the shared wake decision is exact-head review. Closure now carries that
same immutable, subject/head-bound review decision to the watchdog, preserving
the original carry-forward refusal and every merge predicate.

The fix sends the head-bound review decision through the existing watchdog
before that return. The watchdog proves absence of live/uncertain ownership and
reserves one durable request per head. Successful queueing names review as the
next owner while retaining the previous wait reason. Safety holds and head
identity checks remain in force. Pending CI already has the terminal audit
reason `required-checks-pending` and head-bound resume receipt; the patch does
not treat that reason, a successful launch or pushed provenance as merge proof.

Before source changes, the three new regression tests failed on the original
code: posted instead of pending; zero requests after a running launch became
terminal; zero requests across repeated terminal observations. Their live-phase
assertions passed: no early review was requested. After the fix those same tests
pass. Additional fixtures cover background consumption, uncertain ownership,
operator holds, foreign-head decisions, a carried clean verdict and a complete
authenticated bridge whose unsettled review requires an exact-head review.
All fixture identities are synthetic and external effects are injected.

SRE owns post-deployment verification: the next hammer that publishes and stops
without merging must be followed within one poll by merge or an exact-head
review, without manual rescue. No configuration change or new CI gate is needed.

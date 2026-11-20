# LAC-2231 — Worker completion reopened final review

On November 20, the witness for Agent OS #11153 reported that Gemini's
22:29:53 UTC final review was Comment only, with zero blockers and five
advisories. Four remained actionable. A source worker published CI-only commit
`9f1ec9b7f3b4952e2254bc114708a889880570ec` and requested re-review. Completion
reported round 6 of 2, with an operator charge. The watcher consumed request
`remediation:laceyenterprises__agent-os-pr-11153-2026-11-19T23-04-49-874Z:2`
and admitted attempt 7 of 3 as FINAL/lenient. The witness verified watcher Node
PID 91243 and a live Claude child. Root prepared the four findings fixes at
`adae8952` on `codex/rescue-11153-prefix-20261120` and left the reviewer running.
[Agent OS #11153](https://github.com/laceyenterprises/agent-os/pull/11153)

## Source failure

Completion created a durable exact-head receipt with actor `remediation-watch`.
Watcher intake used receipt presence to skip closure routing and waive
reviewed-head deduplication. A reply flag and an `already-pending` acknowledgement
could therefore take the priority path that an authenticated operator request
uses. The ordinary final fix-all work order also explicitly required another
full review of its publication, despite having a bounded closer validation path.

The offline reproduction starts with a delivered Comment-only verdict and
exhausted delivered-review budget. It runs closeout without claiming publication
proof, records the completion request against the moved head, then evaluates
watcher admission. Both a newly pending row and an already-pending row restore
the delivered source review for closure and settle the completion receipt. The
fixture also runs below the delivered ceiling, with an absent or failed first
review, with unreadable or blocking verdicts, and with concurrent human requests
or a live reviewing claim.

## Repair and acceptance

Worker receipts follow ordinary review admission. An authenticated operator
request can take priority for the same head, keeping the original waiting
threshold. The final fix-all path uses the existing closer handoff when
publication proof matches the candidate and the work order binds the known
Comment-only source review. The closer receives the original findings and
must validate dispositions, source preservation and required CI on the live
head before eligible merge. A successful CI patch supplies no finding
disposition. LAC-2230 separately owns launch-head completion evidence.

The closure runbook and custody/data-model contracts describe the source
behavior. After ordinary source merge and deployment, retain the loaded
revision, a natural capped completion or final fix-all receipt, the closer's
exact-head validation and required CI, and authoritative PR terminal state.
Confirm that no duplicate full review or concurrent writer was admitted.
Source validation, source merge, deployment and natural behavioral acceptance
are separate gates.

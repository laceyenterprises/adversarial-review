# ZEROOUTPUTCLOSER-01

A zero-output ticket refusal transfers closer custody to operator-escalated
instead of entering generic prelaunch slow retry. The same-head record retains
one successful escalation marker, clears the retry clock and suppresses dispatch
and merge-agent fallback. Historical slow-retry refusals are adopted immediately;
a new head keeps its own eligibility. Existing closer budgets are unchanged.

The companion agent-os PR makes the guard shape-aware and scopes strikes to the
PR head. After normal deployment and watcher restart, SRE observes 24 hours:
changed heads and terminal-audit attempts have no false zero-output refusal;
genuine refusals retain named operator custody and one escalation per head.
No live change is performed by this worker.

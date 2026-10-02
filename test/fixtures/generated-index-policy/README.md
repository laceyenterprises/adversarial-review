# PMSC-14 policy and incident evidence

`check-generated-index-pr-diff.py.txt` is inert, byte-preserved policy data from
Agent OS, not executable test code. Its Git blob is
`462196ad56aa0506c671411b41746d24fe765815`. The Git fixture installs those bytes
at the authoritative policy path. Formatting this snapshot would change the
policy version and invalidate the test; do not rewrite it as maintained Python.

`pr7544-replay-evidence.json` preserves the four JSON records from the operator's
`evidence/tick1039-replay-proof.stdout`. It records two mixed commits separated
by a documentation-only commit, the omitted INDEX-only reset, patch IDs and
final-head/trunk identities. Tests rebuild that shape with small offline Git
files; they do not claim to contain production source bytes or execute live
PR7544 code. Production recovery remains gated on the reviewed deployed fix and
fresh native proof over the real immutable objects.

# ARCH-03: Architecture reviewer rubric

ARR-only diffs under `docs/architecture/reviews/ARR-*.md` and `.json` select an architecture rubric at reviewer prompt assembly. Empty, mixed and unreadable diffs use the code rubric; both rename paths must qualify. Sidecar-only updates qualify. All stages and reviewer runtimes share the selection, including retries and chunk budget calculations; chunks inherit the whole-PR selection.

The rubric checks scar coverage, built-but-dark designs, cutover continuity, evidenced invariants, and cost/deletion evidence. Review findings remain recommendations to the architect; only an operator can decide, apply a freeze, or authorize a pack. Model routing, HCP attestation, verdict parsing, remediation and merge authority retain their existing contracts.

Post-merge: normal deployment of the reviewer checkout is required. Any privileged restart belongs to the operator/SRE. Read-only activation evidence is an ARR-only review showing the architecture rubric and a mixed PR showing the code rubric, with the ordinary structured verdict and attestation. This worker performs no live activation.

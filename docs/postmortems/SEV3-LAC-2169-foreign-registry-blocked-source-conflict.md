# SEV3 recurrence in handwritten conflict repair

On 2026-11-19, the adversarial-review closer stopped repairing PR #1934 at
`566398e815ce93ebe50edfbbf5936c0a748b05e9`. Its only conflict was the handwritten
`docs/STATE-MACHINE.md`. The closer staged a resolution preserving both independent
additions, then the mandatory generated-conflict resolver refused the
`laceyenterprises/agent-os` registry for `laceyenterprises/adversarial-review`.
The repository fence served its purpose. The closer lacked a continuation for
staged source work when that fence excluded the installed registry.
[Incident PR](https://github.com/laceyenterprises/adversarial-review/pull/1934)

The first LAC-2169 incident involved an identical relative path across
repositories. Agent OS #10375 bound its installed registry to the declared
repository and classified foreign overlaps as source conflicts. The recurrence
occurred in adversarial-review's Appendix D caller, which sent every stopped
rebase through the generated-conflict entry point. The caller now uses the same
ownership classifier to select the installed resolver for its own repository
and the shared marker-checked Git continuation for explicitly staged foreign
source conflicts. Missing, unreadable, or unclassifiable policy refuses
continuation. The reviewed-head preservation proof still runs before
publication. [Original repair](https://github.com/laceyenterprises/agent-os/pull/10375)

The root rescue published `07c085595bf77575f9450dce3e060f27c53f2833` on #1934.
GitHub shows both CI jobs passed and the PR merged at
`c547d0eaf8327ce0b814da1085a5956a8a6bfcbb` on 2026-11-19 at 21:25 UTC.
That establishes recovery of the individual PR. Runtime activation of this
recurrence repair still requires separate evidence.
[Rescue CI](https://github.com/laceyenterprises/adversarial-review/actions/runs/44615781210)

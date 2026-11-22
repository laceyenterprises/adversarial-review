# HAMLATEAUDIT-01 final rescue review

The legacy lane now reports `legacy-writer-timeout` when a successful review-proof read consumes the command budget. It preserves named proof refusals and never starts transport with an exhausted budget. A controlled monotonic-clock test fails before this fix and passes after it. The reviewer comparison also guards an absent prior review defensively; the public proof wrapper already refuses malformed review evidence. Neither change adds a persistent record or lifecycle value.

The configured operator path remains the canonical loader: `getMergeAuthorityConfig` projects `roles.adversarial.operator_logins` into `operatorLogins`; `loadEffectiveMergeAuthorityConfig` passes that domain-resolved projection to all three callers. Looking for raw nested config again at those consumers would duplicate its owner.

The transient merge retry helper is private, and its sole production caller supplies the fresh review-proof callback. A success-returning default would permit unverified transport and is deliberately rejected.

Hammer CI-wait-only mode returns before the merge phase. Actual hammer merge transport requires its validated review audit; a missing audit must continue to refuse, including a malformed timestamp. Clean inline daemon merges have their own proof path. Do not omit the proof argument to make an unvalidated hammer merge proceed.

The unrelated Node22 suite deadline and local fixture latency incident remains LAC-2182; source remediation does not authorize an unchanged rerun or a timeout waiver.

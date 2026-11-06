# REMLANEACCOUNT-01 — account-bound remediation lane handed to HQ dispatch in native mode

- `src/remediation-worker-class-fallback.mjs`: `remediationLaneModeRefusal` refuses the
  account-bound lane in native mode only when HQ dispatch is unreachable;
  `remediationLaneRuntimeMode` / `applyHqDispatchHandoffEnv` hand a runnable account-bound lane
  to HQ dispatch.
- `src/follow-up-remediation.mjs`: the consume path launches that lane through the existing
  `hq dispatch` path; the spawned worker records `hqDispatchHandoff`.
- `src/remediation-hold-cause.mjs`, `src/ama-closure-orchestration.mjs`: the
  `remediation-job-missing` blocker line names the hold (lane, reason).
- Tests: `test/remlaneaccount-01-native-account-bound-handoff.test.mjs`; the REMEDIATORLANE-01
  refusal tests now run with an unreachable HQ root.

# Operational wait inventory — LOADAR-01

The table records operational timeout consumers in the changed `src/` files.
Values are nominal bases; configuration and environment values replace those
bases before scaling. Each listed wait uses `src/load-aware-timeout.mjs`.
`loadAwareTimeoutSeconds` consumers use seconds; all other values are milliseconds.
Named functions identify the operation being awaited. Existing already-scaled
sibling calls are included for review. Derived caller deadlines are consumed
without another multiplier. Slack lock acquisition fixes its deadline before
retrying, so falling load cannot shorten an already-granted window. First-pass
CI orphan configuration retains nominal deadline and worker-status budgets;
scans and worker probes scale them when invoked. Long budgets explicitly lift
the default one-hour cap.

| File:line | Nominal value | Waits on |
| --- | --- | --- |
| `src/adapters/agent-runtime/canary.mjs:102` | `DEFAULT_CANARY_TIMEOUT_MS = 300000 ms` | buildCanaryRequest |
| `src/adapters/agent-runtime/failover-drill.mjs:97` | `600000 ms` | reviewerRequest |
| `src/adapters/agent-runtime/os-dispatch/index.mjs:619` | `DEFAULT_APP_CONTRACT_REQUEST_TIMEOUT_MS = 75000 ms` | withDefaultConnectOptions |
| `src/adapters/agent-runtime/router/probe.mjs:34` | `config.healthzTimeoutMs` | probeOnce |
| `src/adapters/agent-runtime/router/probe.mjs:93` | `config.sseLivenessTimeoutMs` | createSseLivenessTracker |
| `src/adapters/comms/github-pr-comments/index.mjs:346` | `30000 ms` | createGitHubPRCommentsAdapter |
| `src/adapters/comms/github-pr-comments/index.mjs:462` | `COMMENT_DELIVERY_CLAIM_WAIT_MS = 35000 ms` | postWithDedupe |
| `src/adapters/comms/github-pr-comments/pr-comments.mjs:1025` | `GH_LOOKUP_TIMEOUT_MS = 15000 ms` | findExistingRemediationComment |
| `src/adapters/comms/github-pr-comments/pr-comments.mjs:1084` | `GH_COMMENT_TIMEOUT_MS = 30000 ms` | postRemediationOutcomeComment |
| `src/adapters/comms/slack-thread/index.mjs:128` | `LOCK_TIMEOUT_MS = 5000 ms` | acquireLock |
| `src/adapters/comms/slack-thread/index.mjs:275` | `Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SLACK_POST_TIMEOUT_MS` | normalizeSlackPostTimeoutMs |
| `src/adapters/reviewer-runtime/acpx/index.mjs:154` | `DEFAULT_DISCOVERY_TIMEOUT_MS = 5000 ms` | resolveAcpxCliPath |
| `src/adapters/reviewer-runtime/acpx/index.mjs:242` | `DEFAULT_OAUTH_PROBE_TIMEOUT_MS = 20000 ms` | assertCodexOAuthLayers |
| `src/adapters/reviewer-runtime/agent-runtime/index.mjs:46` | `Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_APP_CONTRACT_REQUEST_TIMEOUT_MS` | resolveRequestTimeoutMs |
| `src/adapters/reviewer-runtime/agent-runtime/index.mjs:71` | `DEFAULT_APP_CONTRACT_REQUEST_TIMEOUT_MS = 75000 ms` | createAppContractHealthzCheck |
| `src/adapters/reviewer-runtime/agent-runtime/index.mjs:395` | `DEFAULT_REVIEW_BUDGET.maxWallMs` | toAgentRequest |
| `src/adapters/reviewer-runtime/cli-direct/discovery.mjs:129` | `30000 ms` | runProbe |
| `src/adapters/reviewer-runtime/cli-direct/discovery.mjs:158` | `30000 ms` | probeClaudeCli |
| `src/adapters/reviewer-runtime/cli-direct/discovery.mjs:191` | `30000 ms` | probeCodexCli |
| `src/adapters/reviewer-runtime/cli-direct/discovery.mjs:243` | `30000 ms` | probeGeminiCli |
| `src/adapters/reviewer-runtime/cli-direct/discovery.mjs:263` | `30000 ms` | probeReviewerCliOAuth |
| `src/adapters/reviewer-runtime/cli-direct/index.mjs:445` | `30000 ms` | spawnReviewer |
| `src/adapters/reviewer-runtime/federation-execution/index.mjs:63` | `5000 ms` | createFederationExecutionAdapter |
| `src/afh-reviewer-fallback.mjs:175` | `CLAUDE_REVIEWER_RUNTIME_PROBE_TIMEOUT_MS = 2000 ms` | probeClaudeReviewerRuntime |
| `src/afh-reviewer-fallback.mjs:409` | `FLEET_QUOTA_STATUS_TIMEOUT_MS = 45000 ms` | readFleetQuotaStatusStdoutWithRetry |
| `src/afh-reviewer-fallback.mjs:449` | `FLEET_QUOTA_STATUS_TIMEOUT_MS = 45000 ms` | readAfhReviewerGrounding |
| `src/afh-reviewer-fallback.mjs:456` | `CLAUDE_REVIEWER_RUNTIME_PROBE_TIMEOUT_MS = 2000 ms` | readAfhReviewerGrounding |
| `src/agy-reviewer-auth.mjs:179` | `Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AGY_AUTH_PROBE_TIMEOUT_MS` | resolveAgyAuthProbeTimeoutMs |
| `src/agy-reviewer-identities.mjs:277` | `HELPER_TIMEOUT_MS = 30000 ms` | runBoundedProcess |
| `src/agy-reviewer-identities.mjs:345` | `HELPER_TIMEOUT_MS = 30000 ms` | runPinnedCommand |
| `src/agy-reviewer-identities.mjs:365` | `HELPER_TIMEOUT_MS = 30000 ms` | listUserProcesses |
| `src/agy-reviewer-identities.mjs:453` | `EXTRACT_TIMEOUT_MS = 300000 ms` | extractAgyReviewWorkspace |
| `src/agy-reviewer-identities.mjs:653` | `LEASE_WAIT_MS = 300000 ms` | createAgyReviewerIdentityPool |
| `src/agy-reviewer-identities.mjs:821` | `PROBE_TIMEOUT_MS = 90000 ms` | startProbe |
| `src/alert-delivery.mjs:538` | `HTTP_TIMEOUT_MS = Number(` | httpRequestText |
| `src/alert-delivery.mjs:800` | `DEFAULT_STALE_INFLIGHT_AGE_MS = 120000 ms` | recoverStaleInflightAlerts |
| `src/alert-delivery.mjs:982` | `CANONICAL_ALERT_SCRIPT_TIMEOUT_MS = 35000 ms` | spawnCanonicalAlertScript |
| `src/ama-closure-orchestration.mjs:220` | `30000 ms` | fetchProtectivePredecessorStateForPr |
| `src/ama-closure-orchestration.mjs:260` | `30000 ms` | fetchCurrentPrStateForBackgroundDispatch |
| `src/ama-closure-orchestration.mjs:309` | `30000 ms` | fetchMergedProtectiveDependentsForPr |
| `src/ama-closure-orchestration.mjs:504` | `180000 ms` | createAmaProofCache |
| `src/ama-closure-orchestration.mjs:1240` | `cfg.dispatchTimeoutMs` | dispatchAmaClosureFor |
| `src/ama-closure-orchestration.mjs:1792` | `5000 ms` | dispatchAmaClosureFor |
| `src/ama-closure-orchestration.mjs:2477` | `FINAL_ROUND_CI_WAIT_DEADLINE_MS = 7200000 ms` | dispatchAmaClosureFor |
| `src/ama-closure-orchestration.mjs:2650` | `cfg.dispatchTimeoutMs` | dispatchAmaClosureFor |
| `src/ama-closure-orchestration.mjs:2914` | `DEFAULT_AMA_CLOSURE_OPERATION_TIMEOUT_MS = 5000 ms` | resolveMergeAgentCoexistenceWithinEvaluation |
| `src/ama-hammer-background-dispatch.mjs:285` | `DEFAULT_AMA_HAMMER_BACKGROUND_BOUND_MS = 900000 ms` | createAmaHammerBackgroundQueue |
| `src/ama/audit.mjs:143` | `AUDIT_LOCK_STALE_MS = 30000 ms` | acquireAuditLock |
| `src/ama/audit.mjs:147` | `AUDIT_LOCK_TIMEOUT_MS = 5000 ms` | acquireAuditLock |
| `src/ama/ci-cost.mjs:13` | `15000 ms` | evaluateCiCost |
| `src/ama/clobber-guard.mjs:116` | `CLOBBER_GUARD_GH_TIMEOUT_MS = 15000 ms` | ghJson |
| `src/ama/clobber-guard.mjs:143` | `CLOBBER_GUARD_GH_TIMEOUT_MS = 15000 ms` | fetchCommitDiff |
| `src/ama/closer-lease.mjs:116` | `AMA_CLOSER_PENDING_LEASE_RECLAIM_AGE_MS = 600_000 * AMA_CLOSER_LAUNCH_ATTEMPTS + AMA_CLOSER_LAUNCH_OVERHEAD_MS` | isReclaimablePendingAmaCloserLease |
| `src/ama/closer-lease.mjs:144` | `reclaimAgeMs` | isReclaimableDispatchedAmaCloserLease |
| `src/ama/closer-lease.mjs:178` | `AMA_CLOSER_PENDING_LEASE_RECLAIM_AGE_MS = 600_000 * AMA_CLOSER_LAUNCH_ATTEMPTS + AMA_CLOSER_LAUNCH_OVERHEAD_MS` | amaCloserPendingLeaseExpiryMs |
| `src/ama/closer-lease.mjs:298` | `AMA_CLOSER_PENDING_LEASE_RECLAIM_AGE_MS = 600_000 * AMA_CLOSER_LAUNCH_ATTEMPTS + AMA_CLOSER_LAUNCH_OVERHEAD_MS` | isHeldAmaCloserLease |
| `src/ama/closer-worktree-reaper.mjs:350` | `30000 ms` | execGit |
| `src/ama/closer-worktree-reaper.mjs:359` | `10000 ms` | remoteRepoForPath |
| `src/ama/closer-worktree-reaper.mjs:379` | `30000 ms` | registeredWorktreesByPath |
| `src/ama/closer-worktree-reaper.mjs:394` | `10000 ms` | registeredWorktreesByPath |
| `src/ama/closer-worktree-reaper.mjs:433` | `20000 ms` | fetchPrState |
| `src/ama/closer-worktree-reaper.mjs:648` | `5000 ms` | probeHammerWorkerActivity |
| `src/ama/closer-worktree-reaper.mjs:699` | `normalizePositiveInteger( env.AMA_CLOSER_WORKTREE_PROCESS_PROBE_TIMEOUT_MS, DEFAULT_PROCESS_PROBE_TIMEOUT_MS, )` | probeWorkerDirectoryUse |
| `src/ama/closer-worktree-reaper.mjs:789` | `normalizePositiveInteger( process.env.AMA_CLOSER_WORKTREE_PROCESS_PROBE_TIMEOUT_MS, DEFAULT_PROCESS_PROBE_TIMEOUT_MS, )` | reapCloserHammerWorktrees |
| `src/ama/closure-lag.mjs:22` | `LOCK_WAIT_MS = Number.isFinite(configuredLockWaitMs) && configuredLockWaitMs > 0` | locked |
| `src/ama/closure-wait.mjs:24` | `baseMs` | observeClosureWait |
| `src/ama/dispatch-closer.mjs:704` | `AMA_LIVE_PR_PROBE_TIMEOUT_MS = 30000 ms` | defaultAmaLivePrProbe |
| `src/ama/dispatch-closer.mjs:734` | `AMA_LIVE_PR_PROBE_TIMEOUT_MS = 30000 ms` | defaultAmaLivePrProbe |
| `src/ama/dispatch-closer.mjs:1127` | `60000 ms` | cleanupHammerCloserWorker |
| `src/ama/dispatch-closer.mjs:1268` | `DAEMON_MERGE_SUBPROCESS_TIMEOUT_MS = 30000 ms` | runGhPrMergeWithTransientRetry |
| `src/ama/dispatch-closer.mjs:1315` | `15000 ms` | fetchMergeCommitShaBestEffort |
| `src/ama/dispatch-closer.mjs:1408` | `15000 ms` | emitWorkerGitMergeSignalBestEffort |
| `src/ama/dispatch-closer.mjs:1578` | `AMA_CLOSER_DISPATCHED_LEASE_RECLAIM_AGE_MS = 1800000 ms` | isAmaCloserAutoMergeHoldActive |
| `src/ama/dispatch-closer.mjs:1586` | `AMA_LIVE_PR_PROBE_TIMEOUT_MS = 30000 ms` | readAmaCloserPullRequestStateAsync |
| `src/ama/dispatch-closer.mjs:1595` | `AMA_LIVE_PR_PROBE_TIMEOUT_MS = 30000 ms` | readAmaCloserPullRequestState |
| `src/ama/dispatch-closer.mjs:2079` | `AMA_CLOSER_LEASELESS_LAUNCH_GRACE_MS = 30000 ms` | isAmaCloserLaunchInProgress |
| `src/ama/dispatch-closer.mjs:2122` | `AMA_CLOSER_PENDING_LEASE_RECLAIM_AGE_MS = 600_000 * AMA_CLOSER_LAUNCH_ATTEMPTS + AMA_CLOSER_LAUNCH_OVERHEAD_MS` | isActiveAmaCloserDispatchRecord |
| `src/ama/dispatch-closer.mjs:2745` | `Number.isFinite(configured) && configured > 0 ? configured : 600_000` | resolveAmaDispatchTimeoutMs |
| `src/ama/dispatch-closer.mjs:2867` | `10000 ms` | readDispatchDrainStatus |
| `src/ama/dispatch-closer.mjs:3066` | `15000 ms` | inspectHolderForTakeover |
| `src/ama/dispatch-closer.mjs:3072` | `15000 ms` | inspectHolderForTakeover |
| `src/ama/dispatch-closer.mjs:3081` | `15000 ms` | inspectHolderForTakeover |
| `src/ama/dispatch-closer.mjs:3113` | `60000 ms` | salvageHolder |
| `src/ama/dispatch-closer.mjs:3281` | `60000 ms` | reclaimSelfOwnedHammerCloserWorktreeBeforeProvision |
| `src/ama/dispatch-closer.mjs:3407` | `60000 ms` | teardownSamePrHammerHolder |
| `src/ama/dispatch-closer.mjs:3460` | `60000 ms` | teardownSamePrHammerHolder |
| `src/ama/dispatch-closer.mjs:3498` | `60000 ms` | teardownSamePrHammerHolder |
| `src/ama/dispatch-closer.mjs:3776` | `5000 ms` | probeAmaCloserDispatchStatus |
| `src/ama/dispatch-closer.mjs:4500` | `15000 ms` | resolveHamTerminalRemediationEvidence |
| `src/ama/hammer-scratch-sweep.mjs:223` | `10000 ms` | ledgerReadArgs |
| `src/ama/hammer-scratch-sweep.mjs:229` | `10000 ms` | ledgerReadArgs |
| `src/ama/hammer-scratch-sweep.mjs:235` | `LEDGER_READ_TIMEOUT_MS = 10000 ms` | readScratchLedger |
| `src/ama/hammer-scratch-sweep.mjs:290` | `5000 ms` | isTerminalOwner |
| `src/ama/hammer-scratch-sweep.mjs:312` | `10000 ms` | sweepHammerScratchDirs |
| `src/ama/hammer-scratch-sweep.mjs:335` | `PROCESS_CENSUS_TIMEOUT_MS = 15000 ms` | refreshCensus |
| `src/ama/history-reader.mjs:21` | `HISTORY_CONTEXT_TIMEOUT_MS = 90000 ms` | createHistoryReader |
| `src/ama/history-reader.mjs:41` | `15000 ms` | createHistoryReader |
| `src/ama/history-reader.mjs:122` | `15000 ms` | createHistoryReader |
| `src/ama/merge-lease.mjs:158` | `DEFAULT_GIT_TIMEOUT_MS = 30000 ms` | git |
| `src/ama/merge-lease.mjs:240` | `MUTATION_LOCK_STALE_MS = 5000 ms` | mutationLockIsStale |
| `src/ama/merge-lease.mjs:460` | `DEFAULT_GIT_TIMEOUT_MS = 30000 ms` | assessMergeLeaseNeedsRevalidation |
| `src/ama/merge-lease.mjs:767` | `parseDeadlineSeconds(deadlineSeconds ?? process.env.AMG_LEASE_DEADLINE_SECONDS)` | upsertMergeLeaseWaiter |
| `src/ama/merge-lease.mjs:921` | `parseDeadlineSeconds(deadlineSeconds ?? process.env.AMG_LEASE_DEADLINE_SECONDS)` | acquireMergeLease |
| `src/ama/merge-lease.mjs:1158` | `DEFAULT_GH_TIMEOUT_MS = DEFAULT_GIT_TIMEOUT_MS` | ghPrState |
| `src/ama/operator-label-gates.mjs:116` | `JOB_READ_BUDGET_MS = 5000 ms` | resolveOperatorLabelGateFailures |
| `src/ama/operator-label-gates.mjs:132` | `JOB_READ_TIMEOUT_MS = 3000 ms` | resolveOperatorLabelGateFailures |
| `src/ama/operator-label-gates.mjs:221` | `PAGE_LOCK_STALE_MS = Math.max(1_000, Number(process.env.OPERATOR_LABEL_PAGE_LOCK_STALE_MS) \|\| 60_000)` | holdForOperatorLabels |
| `src/ama/operator-notice-route.mjs:63` | `1000 ms` | operatorNoticeInFlight |
| `src/ama/orphan-watchdog.mjs:24` | `Number.isFinite(value) && value > 0 ? value * 60 * 1000 : OWNERLESS_BOUND_MS` | ownerlessBoundMs |
| `src/ama/orphan-watchdog.mjs:30` | `5000 ms` | probeOrphanOwnership |
| `src/ama/orphan-watchdog.mjs:59` | `5000 ms` | probeOrphanOwnership |
| `src/ama/orphan-watchdog.mjs:208` | `5000 ms` | recoverOrphanWithStore |
| `src/argus-backlog-retirement.mjs:86` | `120000 ms` | createGhOpenPullHeadsLister |
| `src/argus-backlog-retirement.mjs:141` | `ARGUS_CLAIM_LEASE_MS = 3600000 ms` | retireArgusBacklog |
| `src/argus-dependency-evidence.mjs:524` | `120000 ms` | createDefaultArgusEvidenceIo |
| `src/argus-dependency-evidence.mjs:537` | `60000 ms` | createDefaultArgusEvidenceIo |
| `src/argus-dependency-evidence.mjs:557` | `180000 ms` | createDefaultArgusEvidenceIo |
| `src/argus-dependency-evidence.mjs:566` | `60000 ms` | createDefaultArgusEvidenceIo |
| `src/argus-dependency-evidence.mjs:578` | `60000 ms` | createDefaultArgusEvidenceIo |
| `src/argus-dependency-evidence.mjs:585` | `60000 ms` | createDefaultArgusEvidenceIo |
| `src/argus-security-drain.mjs:71` | `resolveReviewerCeilingConfig(env).max * 1000` | resolveArgusReviewChildTimeoutMs |
| `src/argus-security-drain.mjs:72` | `ARGUS_REVIEW_CHILD_TIMEOUT_MS = 2700000 ms` | resolveArgusReviewChildTimeoutMs |
| `src/argus-security-review-child.mjs:50` | `30000 ms` | main |
| `src/argus-security-review-deps.mjs:80` | `60000 ms` | createDefaultArgusReviewDeps |
| `src/argus-security-review-deps.mjs:167` | `60000 ms` | createDefaultArgusReviewDeps |
| `src/argus-security-verdict.mjs:265` | `ARGUS_REVIEW_STALL_DEADLINE_MS = 21600000 ms` | resolveArgusSecurityVerdict |
| `src/backfill-review-bodies.mjs:91` | `GH_LOOKUP_TIMEOUT_MS = 30000 ms` | fetchPullReviews |
| `src/c5-tel11-activation.mjs:347` | `30000 ms` | commandTel11Detector |
| `src/ci-recovery.mjs:176` | `30000 ms` | recoverCancelledChecks |
| `src/claude-launchctl-uid.mjs:62` | `DEFAULT_UID_LOOKUP_TIMEOUT_MS = 2000 ms` | resolveClaudeLaunchctlUidFromConfig |
| `src/claude-reviewer-token-proxy.mjs:248` | `DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS = 600000 ms` | startClaudeReviewerTokenProxy |
| `src/closeout-scraper.mjs:184` | `15000 ms` | fetchPullRequestCreatedAt |
| `src/closeout-scraper.mjs:239` | `15000 ms` | scraperFetchIssueComments |
| `src/closeout-scraper.mjs:534` | `GH_LOOKUP_TIMEOUT_MS = 30000 ms` | fetchIssueComments |
| `src/codex-oauth-responses.mjs:108` | `DEFAULT_DIRECT_IDLE_TIMEOUT_MS = 180000 ms` | consumeCodexOAuthSse |
| `src/codex-oauth-responses.mjs:172` | `DEFAULT_DIRECT_TIMEOUT_MS = 1200000 ms` | reviewWithCodexOAuthResponses |
| `src/codex-oauth-responses.mjs:173` | `DEFAULT_DIRECT_IDLE_TIMEOUT_MS = 180000 ms` | reviewWithCodexOAuthResponses |
| `src/codex-per-worker-auth.mjs:198` | `15000 ms` | materializePerWorkerCodexAuth |
| `src/comment-only-final-round-recovery.mjs:26` | `15000 ms` | recoverTerminalCommentOnlyRound |
| `src/comment-only-final-round-recovery.mjs:26` | `15000 ms` | recoverTerminalCommentOnlyRound |
| `src/comment-only-final-round-recovery.mjs:77` | `15000 ms` | recoverTerminalCommentOnlyRound |
| `src/comment-only-final-round.mjs:104` | `60000 ms` | proveFinalRoundWorkerPush |
| `src/daemon-worker-identity.mjs:361` | `30000 ms` | readHeadAttestationChainForPr |
| `src/dag-autowalk-health.mjs:71` | `3000 ms` | collectDagAutowalkHealth |
| `src/dag-autowalk-on-merge.mjs:100` | `Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAG_AUTOWALK_ON_MERGE_TIMEOUT_MS` | resolveDagAutowalkOnMergeTimeoutMs |
| `src/dependency-bot-autoadjudication.mjs:400` | `30000 ms` | fetchDependencyMergeRecoveryEvidence |
| `src/duplicate-family-packet.mjs:109` | `30000 ms` | git |
| `src/duplicate-family-state.mjs:947` | `1500 ms` | primeSignal |
| `src/duplicate-family-workflow-cli.mjs:46` | `30000 ms` | ghJson |
| `src/duplicate-family-workflow-cli.mjs:94` | `30000 ms` | postSelectionComment |
| `src/empty-pr-close.mjs:17` | `Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : EMPTY_PR_CLOSE_TIMEOUT_MS` | closeEmptyPullRequest |
| `src/fast-merge-github-io.mjs:158` | `FAST_MERGE_GH_TIMEOUT_MS = 30000 ms` | fetchFastMergeHamCommit |
| `src/fast-merge-github-io.mjs:172` | `FAST_MERGE_GH_TIMEOUT_MS = 30000 ms` | fetchFastMergeTimeline |
| `src/fast-merge-processing.mjs:562` | `FAST_MERGE_GH_TIMEOUT_MS = 30000 ms` | fetchFastMergePrView |
| `src/fast-merge-processing.mjs:579` | `FAST_MERGE_GH_TIMEOUT_MS = 30000 ms` | fetchFastMergeMergeCommit |
| `src/fast-merge-processing.mjs:599` | `FAST_MERGE_GH_TIMEOUT_MS = 30000 ms` | fetchFastMergePrState |
| `src/fast-merge-processing.mjs:671` | `FAST_MERGE_GH_TIMEOUT_MS = 30000 ms` | fetchFastMergeChecks |
| `src/fast-merge-processing.mjs:745` | `FAST_MERGE_GH_TIMEOUT_MS = 30000 ms` | mergeFastMergePr |
| `src/fast-merge-processing.mjs:1397` | `FAST_MERGE_GH_TIMEOUT_MS = 30000 ms` | processFastMergePR |
| `src/finalization/executor-lease-store.mjs:47` | `DEFAULT_BUSY_TIMEOUT_MS = 5000 ms` | openDb |
| `src/finalization/executor.mjs:95` | `DEFAULT_LEASE_TTL_MS = 300000 ms` | createFinalizationExecutor |
| `src/finalization/ledger-store.mjs:56` | `DEFAULT_BUSY_TIMEOUT_MS = 5000 ms` | openDb |
| `src/finalization/shadow-store.mjs:51` | `DEFAULT_BUSY_TIMEOUT_MS = 5000 ms` | openDb |
| `src/finalization/shadow-store.mjs:74` | `DEFAULT_BUSY_TIMEOUT_MS = 5000 ms` | openReadOnlyDb |
| `src/fleet-self-repair-rereview.mjs:128` | `LOCAL_GIT_TIMEOUT_MS = 5000 ms` | runWithTransientGitRetry |
| `src/follow-up-branch.mjs:16` | `8000 ms` | readFollowUpPRHead |
| `src/follow-up-merge-agent.mjs:208` | `Number.isInteger(parsed) && parsed > 0 ? parsed : HQ_DISPATCH_TIMEOUT_MS` | resolveHqDispatchTimeoutMs |
| `src/follow-up-merge-agent.mjs:814` | `5000 ms` | _probeDispatchStatusViaHq |
| `src/follow-up-merge-agent.mjs:867` | `5000 ms` | probeDispatchStatusViaHq |
| `src/follow-up-remediation.mjs:283` | `DEFAULT_REMEDIATION_CI_SETTLE_TIMEOUT_MS = 1800000 ms` | resolveRemediationCiSettleTimeoutMs |
| `src/follow-up-remediation.mjs:286` | `Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REMEDIATION_CI_SETTLE_TIMEOUT_MS` | resolveRemediationCiSettleTimeoutMs |
| `src/follow-up-retrigger-label.mjs:229` | `ACK_COMMENT_LOOKUP_TIMEOUT_MS = 15000 ms` | findExistingAckComment |
| `src/follow-up-retrigger-label.mjs:333` | `ACK_COMMENT_TIMEOUT_MS = 10000 ms` | deliverRetriggerOperatorNotice |
| `src/follow-up-retrigger-label.mjs:636` | `Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RETRIGGER_OUTCOME_TIMEOUT_MS` | resolveRetriggerOutcomeTimeoutMs |
| `src/follow-up-retrigger-review-label.mjs:175` | `ACK_COMMENT_LOOKUP_TIMEOUT_MS = 15000 ms` | findExistingAckComment |
| `src/follow-up-retrigger-review-label.mjs:265` | `ACK_COMMENT_TIMEOUT_MS = 10000 ms` | postRetriggerReviewAckComment |
| `src/follow-up-review-claim.mjs:115` | `REVIEW_CLAIM_STALE_MS = 120000 ms` | abandonedReason |
| `src/follow-up-review-claim.mjs:169` | `REVIEW_CLAIM_MAX_WAIT_MS = 2 * REVIEW_CLAIM_STALE_MS` | claimFollowUpForReview |
| `src/follow-up-worker-progress.mjs:82` | `2000 ms` | readWorkerCpuPercent |
| `src/follow-up-workspace-reaper.mjs:198` | `2000 ms` | reapFollowUpWorkspaces |
| `src/github-adapter-client.mjs:497` | `ADAPTER_TIMEOUT_MS = 30000 ms` | runGitHubAdapter |
| `src/github-adapter-client.mjs:580` | `ADAPTER_TIMEOUT_MS = 30000 ms` | writeGitHubAdapter |
| `src/github-adapter-client.mjs:809` | `15000 ms` | writeAdapterPullRequestMerge |
| `src/github-api.mjs:789` | `GH_EXEC_TIMEOUT_MS = (() => {` | execGhJson |
| `src/github-api.mjs:2110` | `GH_EXEC_TIMEOUT_MS = (() => {` | fetchPullRequestMergeability |
| `src/github-auth-recovery.mjs:23` | `15000 ms` | localGitOptions |
| `src/github-auth-recovery.mjs:203` | `60000 ms` | preserveUnpushedCommit |
| `src/github-auth-recovery.mjs:292` | `15000 ms` | readRecoveryPrHead |
| `src/github-auth-recovery.mjs:363` | `15000 ms` | retryGithubAuthPushOnce |
| `src/github-auth-recovery.mjs:519` | `600000 ms` | retryGithubAuthPushOnce |
| `src/guard-forbidden-paths.mjs:24` | `15000 ms` | resolveGuardBaseRef |
| `src/hammer-pr-read.mjs:13` | `30000 ms` | fetchHammerPr |
| `src/hcp-health.mjs:15` | `DEFAULT_HCP_HEALTHZ_TIMEOUT_MS = 8000 ms` | checkHcpHealthz |
| `src/head-closer-commit-suppression.mjs:163` | `LOCAL_GIT_TIMEOUT_MS = 5000 ms` | fetchVerifiedCommitFromLocalGit |
| `src/live-pack-merge-check.mjs:16` | `15000 ms` | checkLivePackMerge |
| `src/merge-agent-phantom-handoff-comment.mjs:87` | `PHANTOM_HANDOFF_COMMENT_TIMEOUT_MS = 10000 ms` | postPhantomHandoffEscalationComment |
| `src/pipeline-health-github.mjs:25` | `20000 ms` | readPipelineGithub |
| `src/pollonce-phases.mjs:857` | `15000 ms` | processReviewSubject |
| `src/process-group-identity.mjs:40` | `5000 ms` | currentProcessGroupId |
| `src/process-group-identity.mjs:67` | `5000 ms` | verifyPgidIdentity |
| `src/process-group-identity.mjs:106` | `5000 ms` | verifyPgidIdentitySync |
| `src/recovery-reaper.mjs:117` | `resolvePositiveMs( env.ADVERSARIAL_STALE_RUNNING_REVIEWER_PASS_MS, DEFAULT_STALE_RUNNING_REVIEWER_PASS_MS, )` | resolveStaleRunningReviewerPassMs |
| `src/recovery-reaper.mjs:129` | `resolvePositiveMs( env.ADVERSARIAL_STALE_CLOSER_LEASE_MS, DEFAULT_STALE_CLOSER_LEASE_MS, )` | resolveStaleCloserLeaseMs |
| `src/recovery-reaper.mjs:142` | `resolvePositiveMs( env.ADVERSARIAL_DEAD_HOLDER_CLOSER_LEASE_MS, DEFAULT_DEAD_HOLDER_CLOSER_LEASE_MS, )` | resolveDeadHolderCloserLeaseMs |
| `src/recovery-reaper.mjs:362` | `DEFAULT_STALE_RUNNING_REVIEWER_PASS_MS = 6 * HOUR_MS` | reapStaleRunningReviewerPasses |
| `src/recovery-reaper.mjs:740` | `DEFAULT_STALE_CLOSER_LEASE_MS = 6 * HOUR_MS` | reapStaleCloserLeases |
| `src/recovery-reaper.mjs:741` | `DEFAULT_DEAD_HOLDER_CLOSER_LEASE_MS = 1800000 ms` | reapStaleCloserLeases |
| `src/recovery-reaper.mjs:778` | `AMA_CLOSER_DISPATCHED_LEASE_RECLAIM_AGE_MS = 1800000 ms` | reapStaleCloserLeases |
| `src/remediation-conflicted-base.mjs:67` | `PR_READ_TIMEOUT_MS = 15000 ms` | readLivePrMergeability |
| `src/remediation-conflicted-base.mjs:84` | `HELP_PROBE_TIMEOUT_MS = 10000 ms` | hqDispatchSupportsConflictedBase |
| `src/remediation-git-pr-io.mjs:250` | `8000 ms` | fetchPRBranchMetadata |
| `src/remediation-oauth-preflight.mjs:249` | `BROKER_READYZ_TIMEOUT_MS = 2500 ms` | probeBrokerReadyzForClaudeCode |
| `src/remediation-oauth-preflight.mjs:286` | `BROKER_READYZ_TIMEOUT_MS = 2500 ms` | assertClaudeCodeBrokerOAuth |
| `src/remediation-oauth-preflight.mjs:483` | `BROKER_TOKEN_TIMEOUT_MS = 8000 ms` | mintClaudeCodeRemediationBrokerToken |
| `src/remediation-oauth-preflight.mjs:622` | `15000 ms` | assertClaudeCodeOAuth |
| `src/remediation-oss-readiness.mjs:207` | `OSS_READINESS_SCRIPT_TIMEOUT_MS = 60000 ms` | runOssReadinessAuditGate |
| `src/remediation-oss-readiness.mjs:248` | `OSS_READINESS_SCRIPT_TIMEOUT_MS = 60000 ms` | applyOssReadinessRemediation |
| `src/remediation-publication.mjs:37` | `30000 ms` | publishRemediation |
| `src/remediation-publication.mjs:44` | `30000 ms` | publishRemediation |
| `src/remediation-publication.mjs:70` | `120000 ms` | publishRemediation |
| `src/remediation-published-head.mjs:52` | `5000 ms` | findWorkerPublishedHead |
| `src/remediation-unpublished.mjs:14` | `5000 ms` | findCommittedUnpublishedWork |
| `src/remediation-workflow-push-capability.mjs:403` | `WORKFLOW_PUSH_ESCALATION_TIMEOUT_MS = 5000 ms` | mintMergeAgentWorkflowPushToken |
| `src/retrigger-review.mjs:228` | `CURRENT_HEAD_LOOKUP_TIMEOUT_MS = 30000 ms` | fetchCurrentPrHeadSha |
| `src/review-body-capture.mjs:186` | `REVIEW_LOOKUP_TIMEOUT_MS = 8000 ms` | lookupRecentReviewArtifact |
| `src/review-pipeline-health.mjs:2714` | `config.firstPassCiOrphanDeadlineMs` (nominal default 120000 ms) | summarizeFirstPassCiOrphans |
| `src/review-pipeline-health.mjs:2642` | `workerStatusTimeoutMs` (nominal default 30000 ms) | liveWorkerForBranch |
| `src/review-pipeline-health.mjs:1161` | `parsePositiveInteger( overrides.launchdTimeoutMs ?? env.ADVERSARIAL_REVIEW_PIPELINE_HEALTH_LAUNCHD_TIMEOUT_MS, DEFAULT_LAUNCHD_TIMEOUT_MS )` | resolveReviewPipelineHealthConfig |
| `src/review-pipeline-health.mjs:1435` | `10000 ms` | fetchPRTerminalStateSync |
| `src/review-pipeline-health.mjs:2676` | `20000 ms` | execGhWithTransientRetry |
| `src/review-pipeline-health.mjs:3588` | `20000 ms` | mergeTreeConflictPaths |
| `src/review-pipeline-health.mjs:3712` | `20000 ms` | summarizeConflictingOpenPrs |
| `src/review-state.mjs:942` | `DEFAULT_LIVE_PR_LOOKUP_TIMEOUT_MS = 15000 ms` | fetchLivePRLifecycle |
| `src/review-state.mjs:1059` | `DEFAULT_LIVE_PR_LOOKUP_TIMEOUT_MS = 15000 ms` | resolvePRLifecycle |
| `src/reviewed-attestation.mjs:165` | `REVIEWED_ATTESTATION_SIGN_TIMEOUT_MS = 15000 ms` | signReviewedAttestation |
| `src/reviewed-attestation.mjs:241` | `REVIEWED_ATTESTATION_SIGN_TIMEOUT_MS = 15000 ms` | recordSignedReviewedAttestation |
| `src/reviewed-attestation.mjs:331` | `REVIEWED_ATTESTATION_QUEUE_LOCK_WAIT_MS = 65000 ms` | acquireReviewedAttestationQueueLock |
| `src/reviewer-broker-refresh.mjs:344` | `REVIEWER_TOKEN_FETCH_TIMEOUT_MS = 5000 ms` | resolveReviewerAppToken |
| `src/reviewer-broker-refresh.mjs:394` | `resolvePositiveMsEnv(env.REVIEWER_TOKEN_FETCH_TIMEOUT_MS, REVIEWER_TOKEN_FETCH_TIMEOUT_MS)` | refreshReviewerBrokerTokens |
| `src/reviewer-broker-refresh.mjs:599` | `resolvePositiveMsEnv(env.REVIEWER_TOKEN_FETCH_TIMEOUT_MS, REVIEWER_TOKEN_FETCH_TIMEOUT_MS)` | refreshFollowUpGithubToken |
| `src/reviewer-broker-refresh.mjs:675` | `resolvePositiveMsEnv(env.REVIEWER_TOKEN_FETCH_TIMEOUT_MS, REVIEWER_TOKEN_FETCH_TIMEOUT_MS)` | refreshWatcherGithubToken |
| `src/reviewer-diff-fetch.mjs:207` | `Math.max(GH_LOOKUP_TIMEOUT_MS, 60_000)` | fetchRawAddedFileForDiff |
| `src/reviewer-diff-fetch.mjs:257` | `Math.max(GH_LOOKUP_TIMEOUT_MS, 60_000)` | fetchPRDiffFromFilesApi |
| `src/reviewer-diff-fetch.mjs:349` | `Math.max(GH_LOOKUP_TIMEOUT_MS, 60_000)` | fetchPRDiff |
| `src/reviewer-harness.mjs:218` | `Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000` | resolveClaudeAuthProbeTimeoutMs |
| `src/reviewer-harness.mjs:1790` | `GEMINI_CQP_CHECKOUT_TIMEOUT_MS = 5000 ms` | checkoutGeminiCredentialFromBrokerOnce |
| `src/reviewer-harness.mjs:1946` | `GEMINI_CQP_CHECKOUT_TIMEOUT_MS = 5000 ms` | releaseGeminiCredentialCheckout |
| `src/reviewer-harness.mjs:2031` | `GEMINI_CQP_CHECKOUT_TIMEOUT_MS = 5000 ms` | reportGeminiCredentialSpend |
| `src/reviewer-harness.mjs:2269` | `GEMINI_CQP_FALLBACK_LOCK_WAIT_MS = 1800000 ms` | acquireGeminiFallbackLock |
| `src/reviewer-orphan-reconcile.mjs:244` | `2000 ms` | probeReviewerProcessSession |
| `src/reviewer-pass-reaper.mjs:221` | `DEFAULT_RUNNING_PASS_TIMEOUT_SECONDS = 3600 seconds` | resolveRunningPassTimeoutSeconds |
| `src/reviewer-pass-reaper.mjs:223` | `parsed` | resolveRunningPassTimeoutSeconds |
| `src/reviewer-reattach.mjs:207` | `2000 ms` | probeReviewerSession |
| `src/reviewer-reattach.mjs:236` | `2000 ms` | findReviewerProcessBySessionUuid |
| `src/reviewer-timeout-model.mjs:20` | `configSeconds('reviewer.idle_timeout_seconds', DEFAULT_IDLE_TIMEOUT_SECONDS, env, options)` | resolveReviewerIdleTimeoutSeconds |
| `src/reviewer-timeout-model.mjs:35` | `calculateReviewerCeilingSeconds({ changedLines, effort, ...resolveReviewerCeilingConfig(env, options) })` | resolveReviewerCeilingSeconds |
| `src/reviewer-timeout.mjs:28` | `_resolvePositiveInt(env.ADVERSARIAL_REVIEW_AGY_CHUNK_TIMEOUT_CAP_MS, AGY_CHUNK_TIMEOUT_CAP_MS)` | resolveAgyChunkTimeoutCapMs |
| `src/reviewer-timeout.mjs:64` | `_resolvePositiveInt(cfgValue, DEFAULT_REVIEWER_TIMEOUT_MS)` | resolveReviewerTimeoutMs |
| `src/reviewer-timeout.mjs:75` | `_resolvePositiveInt(cfgValue, DEFAULT_PROGRESS_TIMEOUT_MS)` | resolveProgressTimeoutMs |
| `src/reviewer-timeout.mjs:91` | `baseMs` | resolveFirstOutputTimeoutMs |
| `src/reviewer-timeout.mjs:102` | `_resolvePositiveInt(cfgValue, DEFAULT_AGY_PRINT_TIMEOUT_MS)` | resolveAgyPrintTimeoutMs |
| `src/reviewer-token-ledger-lookup.mjs:27` | `180000 ms` | readReviewerEvidenceInWorker |
| `src/reviewer-token-pool.mjs:49` | `15000 ms` | reviewerPoolOwner |
| `src/reviewer-workspace.mjs:583` | `GIT_AUDIT_TIMEOUT_MS = 15000 ms` | explainedCheckoutPaths |
| `src/reviewer.mjs:407` | `Number.isFinite(parsed) && parsed > 0 ? parsed : LOCAL_REVIEW_SHADOW_DEFAULT_TIMEOUT_MS` | resolveLocalReviewShadowTimeoutMs |
| `src/routing-tier-readiness.mjs:36` | `Number.isFinite(v) && v > 0 ? v : DEFAULT_ROUTING_TIER_READINESS_TIMEOUT_MS` | resolveRoutingTierReadinessTimeoutMs |
| `src/runtime-readyz.mjs:105` | `5000 ms` | endpointSignal |
| `src/runtime-settle-smoke-cli.mjs:62` | `DEFAULT_TIMEOUT_MS = 300000 ms` | buildSettleSmokeRequest |
| `src/session-ledger-read-adapter.mjs:709` | `PSQL_TIMEOUT_MS = 30000 ms` | queryPostgresRowsSteps |
| `src/session-ledger-read-adapter.mjs:719` | `PSQL_TIMEOUT_MS = 30000 ms` | queryPostgresRowsSteps |
| `src/watcher-memory-pressure.mjs:191` | `5000 ms` | readMemoryPressureSample |
| `src/watcher-memory-pressure.mjs:192` | `5000 ms` | readMemoryPressureSample |
| `src/watcher-poll-guard.mjs:110` | `resolveDeadlineMs(deadlineMs, source)` | safePollOnce |
| `src/watcher-reviewer-pool.mjs:762` | `4000 ms` | fetchGeminiCredentialConcurrency |

The Python GitHub reader (`src/adapters/health/github-read.py:57, 68, 153, 190`)
receives its nominal five-second per-attempt budget from
`readPipelineGithub` via `--attempt-timeout-seconds`. Its parent sizes the
20-second outer bound once and supplies one quarter of that value per attempt;
three attempts plus the existing retry cadence fit inside that same snapshot.

The agent-runtime adapter's `DEFAULT_REVIEW_BUDGET.maxWallMs` is 1,800,000 ms.
The closure row's `baseMs` is 1,800,000 ms or the positive
`AMA_CLOSURE_WAIT_BOUND_MS` override. Reviewer config-derived bases remain
20 minutes wall time, 15 minutes progress, 19 minutes Gemini print time,
six hours chunk cap, 600 seconds streamed idle, and the existing 1,800–10,800
second diff/effort ceiling. The configured streamed ceiling is computed before
load scaling. A disabled first-output timer remains zero. Closer dispatch uses
600,000 ms or its existing configured base. The unknown closer lease age uses
the 86,400-second worker schema ceiling plus the 1,800,000 ms margin. Persisted
merge leases and waiters store a scaled 900-second base at acquisition; reading
those deadlines does not scale them again.

Deliberately fixed bounds and non-wait time policies:

| File:line | Value | What it waits on / why fixed |
| --- | --- | --- |
| `src/process-group-spawn.mjs:8,140,155` | 5,000 ms kill grace; existing settle grace | TERM/KILL child cleanup. |
| `src/reviewer-process-deadline.mjs:21,25` | 30,000 ms | Child exit after its execution deadline. |
| `src/adapters/reviewer-runtime/cli-direct/index.mjs:51,52,294` | 10,000 ms grace; 250 ms polling | Cancelled child cleanup. |
| `src/reviewer-harness.mjs:2110,2672` | 1,000 ms signal release; 1 ms identity settle | Child cleanup and release. |
| `src/reviewer-pass-reaper.mjs:33,583` | 300 seconds | Completed review settlement grace. |
| `src/follow-up-merge-agent.mjs:141,196` | 60,000 ms or existing override | Original worker teardown. |
| `src/merge-agent-original-worker-teardown.mjs:43,111` | 60,000 ms or existing override | Original worker teardown. |
| `src/ama/closer-terminal-cancel.mjs:16,195` | 10,000 ms | Cancel terminal closer. |
| `src/ama/closer-worktree-reaper.mjs:495,539,553` | 60,000 ms | Remove/prune completed child worktrees. Status/ownership probes in this file scale. |
| `src/follow-up-workspace-trash.mjs:36` | 5,000 ms | Cleanup process identity probe. |
| `src/adversarial-hard-shutdown.mjs:12,80` | 5,000 ms | Hard-shutdown child exit grace. |
| `src/follow-up-stop.mjs:10,127` | 5,000 ms | Stopped worker exit grace. |
| `src/retrigger-review.mjs:38,402` | 5,000 ms | Cancel prior review before retrigger. |
| `src/adapters/health/github-read.py:48` | 2 seconds | Reap interrupted meter/gh child before KILL. |
| `src/review-state.mjs:100,163,1106` | 100 ms | Short SQLite busy/poll bound. |
| `src/sqlite-busy-retry.mjs:55,73` | requested delay + 1,000 ms | Implements the synchronous retry sleep itself, rather than an operational child budget. |
| `src/load-aware-timeout.mjs:40,63` | 1,000 ms | Helper's CPU-sampler bootstrap cap; calling the helper here would recurse. |
| `src/ama/primary-change.mjs:1315,1322` | 15,000 ms | Operator-only reverted-region diagnostic, outside merge/review service dispatch; explicitly excluded from edits by this ticket. |
| `src/ama/closure-wait.mjs:8` | 30,000 ms | Retry cadence; unchanged ownership and scheduling. |
| `src/ama/closure-owner.mjs:8` | 30,000 ms | Ownership retry cadence. |
| `src/ama/dispatch-dir-names.mjs:14` | 2,000 ms | Temporary-record settling filter, not an execution deadline. |
| `src/ama/dispatch-closer.mjs:1561,2842` | 60,000 ms; 300,000 ms | Terminal receipt cleanup grace; drain-hint freshness. |
| `src/reviewer-burst-lease.mjs:88,92,646` | 30 minutes default; four hours maximum | Operator-authorized capacity grant duration, not patience for an operation. Load must not extend this authorization. |
| `src/recovery-reaper.mjs:94` | seven days | Terminal record retention/pruning, not a live-operation deadline. |
| `src/worker-execution-limits.mjs:2` | 86,400 seconds | Schema ceiling, not a nominal operation wait. |

Polling intervals, retry/backoff cadence, cache freshness, record retention,
metric/SLO thresholds, and settlement/cleanup ages remain fixed. In particular,
sub-second polling bounds remain fixed throughout `src/`; only their enclosing
operational deadlines scale. No CI check, guard, ratchet, label or config key is
added. `src/ama/primary-change.mjs` is unchanged.

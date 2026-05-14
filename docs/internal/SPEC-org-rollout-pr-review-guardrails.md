# SPEC — Org Rollout for PR Review Trigger Guardrails

_Status: Draft v0.1_
_Date: 2026-04-19_
_Owner: Clio / Paul_
_Related: `SPEC-pr-review-trigger-guardrails.md`, LAC-180, LAC-181, LAC-182_

## 1. Purpose

Operationalize the new adversarial-review PR trigger guardrails across the Agent OS repo fleet and agent workflow stack.

The guardrails are now implemented in principle:
- canonical tagged PR creation helper
- watcher fail-loud behavior for malformed titles
- repo-side PR title validation

This rollout spec defines how to make those capabilities real defaults across repos, coding agents, and build workflows.

## 2. Core Thesis

The new PR trigger guardrails are not just repo-local automation. They are part of the **agent implementation contract**.

That contract should be reflected in three places:
1. **repo plane** — participating repos visibly enforce correct PR title prefixes
2. **agent/tooling plane** — coding agents use the canonical tagged PR helper by default
3. **build/process plane** — build playbooks and implementation runbooks treat malformed PRs as process-invalid and describe the recovery path clearly

If any one of these planes is skipped, the system will drift.

## 3. Rollout Goals

1. Deploy repo-visible PR title validation to the active repo set
2. Update coding-agent behavior so helper usage is the default path in watched repos
3. Update build/runbook docs so humans and agents follow the same workflow contract
4. Create a path for new repos to inherit these guardrails by default

## 4. Scope

### In scope
- packaging repo-side PR title validation for reuse across repos
- installing validation on the first wave of active repos
- updating the coding-agent skill with hard requirements for watched repos
- updating the build playbook / implementation workflow guidance
- documenting recovery behavior for malformed PRs

### Out of scope
- redesigning the adversarial-review watcher architecture
- replacing GitHub PR workflows wholesale
- retrofitting every inactive/archive repo immediately

## 5. Repo Plane

### 5.1 Desired end state
Each participating repo should have:
- a repo-visible validation check for adversarial-review PR title prefixes
- allowed prefixes derived from a canonical source of truth where practical
- protected branches configured to require the validation check before merge

### 5.2 Distribution model
Preferred implementation order:
1. package the validation as a reusable workflow or composite action
2. install it in a first wave of active repos
3. later fold it into repo bootstrap/templates for new repos

### 5.3 First-wave repos
Recommended wave 1:
- `laceyenterprises/agent-os`
- `laceyenterprises/adversarial-review`
- `laceyenterprises/clio`
- any other repo where coding agents regularly open PRs today

## 6. Agent / Tooling Plane

### 6.1 Desired end state
Coding agents should treat tagged PR creation as a hard workflow requirement for watched repos.

### 6.2 Required agent behavior
For watched repos:
- use the canonical tagged PR helper
- do not call raw `gh pr create` directly unless explicitly allowed
- creation-time title tag is mandatory
- malformed PRs are process-invalid
- later retitle is not a reliable recovery path

### 6.3 Skill updates
Update the coding-agent skill so these are enforced as hard requirements, not soft reminders.

## 7. Build / Process Plane

### 7.1 Desired end state
Implementation playbooks should reflect the new contract so both humans and agents follow the same process.

### 7.2 Required documentation changes
- describe the tagged PR helper as the normal path
- describe repo-side validation and watcher fail-loud behavior
- document malformed-PR recovery: close/recreate rather than retitle
- make explicit that PR title prefix is an interface requirement, not a naming preference

## 8. Recommended Rollout Sequence

1. package reusable repo validation install path
2. deploy validation to wave-1 repos
3. update coding-agent skill
4. update build playbook / workflow docs
5. configure required status checks on protected branches
6. fold into new-repo bootstrap/template path

## 9. Acceptance Criteria

This rollout is successful when:
- wave-1 repos visibly enforce the PR title validation check
- coding-agent skill instructs agents to use the tagged PR helper by default in watched repos
- build playbook documents the new workflow contract and malformed-PR recovery path
- malformed PRs are treated as process-invalid across both repo and agent workflows
- new high-activity repos have a clear install path for the guardrails

## 10. Recommendation

Treat this as a fleet workflow rollout, not just a single-repo cleanup.

The value of LAC-180 through LAC-182 is only fully realized when:
- repos enforce the contract
- agents know the contract
- build workflows teach the contract
- future repos inherit the contract by default

# SPEC — PR Review Trigger Guardrails

_Status: Draft v0.1_
_Date: 2026-04-19_
_Owner: Clio / Paul_
_Related: Adversarial Code Review system, PR watcher, coding-agent workflow_

## 1. Purpose

Prevent adversarial-review trigger failures caused by malformed PR titles.

This spec exists because the current review pipeline depends on a creation-time PR title prefix (`[codex]`, `[claude-code]`, `[clio-agent]`) to route review correctly, but that requirement is still too soft in practice. Repeated misses show that prompt discipline and skill documentation are not sufficient guardrails.

## 2. Problem Statement

Current failure mode:
1. a coding agent opens a PR without the required title prefix
2. the watcher sees the malformed PR in its initial state
3. retitling later will not retrigger review because malformed titles are recorded as terminal failures
4. the adversarial review loop silently degrades or fails entirely

This is a control failure, not just a UX inconvenience.

## 3. Goal

Move the reviewer-tag requirement out of memory and convention, and into enforced system behavior.

## 4. Required Guardrails

### 4.1 Guardrail A — Canonical PR creation helper
PRs intended for the adversarial review pipeline should be opened through a single helper path rather than raw `gh pr create` calls.

#### Requirements
- helper accepts reviewer/author tag source (`codex`, `claude-code`, `clio-agent`)
- helper prepends the correct title prefix automatically
- helper refuses creation when the tag is missing or invalid
- helper prints or logs the exact final PR title before creation
- helper should be usable by coding agents and humans

#### Rationale
This turns the title-tag rule into code instead of hoping every agent remembers it every time.

### 4.2 Guardrail B — Watcher fail-loud behavior on malformed PRs
The watcher must treat missing/invalid title prefixes as an explicit operational failure state.

#### Requirements
- detect PRs in watched repos missing the required prefix
- do not silently process them as normal
- surface the failure loudly via one or more of:
  - PR comment
  - operator alert
  - structured failure state/log entry
- message should clearly explain that review did not trigger correctly and that creation-time tag is required

#### Rationale
Silent degradation is the worst possible behavior here. The system should fail obviously.

### 4.3 Guardrail C — Repo-side validation check
Repos participating in the adversarial review flow should expose an immediate validation check for title prefix correctness.

#### Requirements
- validate that PR title starts with one of the allowed prefixes
- fail clearly when invalid
- explain allowed prefixes and why later retitling is intentionally blocked

#### Rationale
This provides immediate visibility at the repo surface and prevents accidental merge of malformed PRs.

## 5. Non-Goals

- redesigning the entire adversarial review architecture
- eliminating the watcher’s title-based routing in this slice
- replacing GitHub-native PR workflows wholesale

## 6. Recommended Implementation Order

1. build the PR creation helper
2. make the watcher fail loud on malformed PRs
3. add repo-side PR title validation

This sequence improves prevention first, then detection, then local surface visibility.

## 7. Operational Rule

Until all three guardrails land, treat untagged PRs as process-invalid.
If a watched PR was created without the required prefix and the watcher has already seen it, the safe recovery path is to close/recreate the PR correctly rather than retitle.

## 8. Acceptance Criteria

This work is successful when:
- coding agents have a canonical path that cannot create an untagged adversarial-review PR by accident
- malformed watched PRs produce loud operator-visible failure signals
- participating repos expose an immediate validation failure for malformed PR titles
- the process no longer relies on “remember the prefix” as the primary safeguard

---
delegation: full
confidence: 0.9
last_verified: 2026-05-02
influence_weight: medium
tags: [adversarial-review, macos, tcc, install, runbook, security]
staleness_window: 60d
---
# macOS TCC: handling worker-spawn popups (and the security tradeoff)

When the adversarial-review stack runs on a fresh Mac (or after Homebrew bumps `node` or `claude`, or after fnm reinstalls Codex), macOS will start prompting "X would like to access data from other apps" / "X would like to access files in <user>'s home folder" every time a reviewer or remediation worker spawns. This document explains **what's actually being protected, why blanket Full Disk Access is a security tradeoff, and how to handle it correctly** — including the recommended posture (isolation) and the documented break-glass workaround (FDA), with authoritative path resolution for both.

> **Recommended posture:** run this stack on an isolated worker account or VM, not the operator's primary login. See [Recommended posture: isolation](#recommended-posture-isolation).
>
> **Break-glass workaround on a non-isolated host:** approve a small set of binaries in **System Settings → Privacy & Security → Full Disk Access**. Read [The security tradeoff](#the-security-tradeoff) before doing this. Resolve the exact paths to approve with `node scripts/print-tcc-targets.mjs` — never copy paths from another machine or doc.

---

## The security tradeoff

This is the part to read before granting FDA.

Both production spawn flows exec the AI CLIs with **bypass-style approvals on untrusted PR content**:

- First-pass review (`src/reviewer.mjs:reviewWithClaude`, `src/reviewer.mjs:reviewWithCodex`):
  - claude is invoked with `--permission-mode bypassPermissions`
  - codex is invoked with `--dangerously-bypass-approvals-and-sandbox --ephemeral`
- Remediation worker (`src/follow-up-remediation.mjs:spawnCodexRemediationWorker`, `:spawnClaudeCodeRemediationWorker`):
  - codex with `--dangerously-bypass-approvals-and-sandbox --ephemeral`
  - claude with `--dangerously-skip-permissions --permission-mode acceptEdits`

That means the operator-level guarantees against an AI CLI reading or writing arbitrary files have already been waived **for the duration of every review and every remediation round**. The per-job workspace is the intended sandbox boundary, and the workspace is rooted in the operator's home.

Granting Full Disk Access to `node`, `claude`, and the resolved codex Mach-O turns a popup annoyance into something larger: any prompt-injection bug in PR content, any compromised tool the model is willing to call, or any mistake in workspace boundary enforcement now has the OS's blessing to read or write protected user data well outside the repo (Mail, Messages, Photos, Safari cookies, time-machine backups, etc.). FDA does not just silence prompts — it removes the last enforcement boundary the OS provides for the operator account.

This is acceptable in some configurations (single-operator dev box, isolated worker account) and unacceptable in others (operator's primary daily-driver account on a machine that processes untrusted PR content). The runbook below makes the tradeoff explicit so you can pick deliberately, instead of treating "stop the popups" as a free action.

---

## Recommended posture: isolation

The durable answer is to run the stack on a TCC subject whose privileges already reflect what the bypass-flagged AI CLIs require — i.e., a subject that does NOT also have access to the operator's primary protected data:

- **Dedicated macOS local user account** for the daemon. Bind the LaunchAgent plists to that account (the `.placey.plist` filename suffix already documents per-operator binding — see README "Install LaunchAgents"). FDA on `node` / `claude` / `codex` granted in *that account's* TCC database is scoped to the data that account can already see, not the primary operator's mail / messages / browser state.
- **Disposable VM or container host** for the worker. CI-style ephemeral host with the codex/claude OAuth credentials scoped to that host. Fresh host on each review run is the strongest version; persistent dedicated worker host is the cheaper version.
- **Minimum credentials** in the worker environment. The worker only needs the GitHub bot tokens for the reviewer identity it operates as, the codex/claude OAuth credentials, and read access to the queue/workspace dir — nothing else from the operator's keychain or shell profile.

Once isolation is in place, the FDA approvals (if needed at all on that host's macOS) are scoped to a subject that has nothing else interesting to expose, and the popup-vs-security tradeoff stops being a tradeoff.

This module does not (yet) automate that posture. The current shipped install path puts both the watcher LaunchAgent and the follow-up daemon under whichever operator runs `launchctl bootstrap` against the deployed plist. Until the isolation posture ships, the FDA workaround below is the **documented break-glass**, not the recommended operating mode.

---

## Break-glass workaround: FDA approvals on a non-isolated host

Use this when:

- you understand and accept the security tradeoff above
- you are running on a single-operator dev box, or
- you are running on a dedicated worker account where FDA's blast radius is bounded by the account's existing privileges

Do **not** use this on a primary daily-driver account that handles email, messaging, browsing, or anything else you would not want a prompt-injected model to read.

### What macOS is actually re-prompting on

The shipped LaunchAgent plists (`launchd/ai.laceyenterprises.adversarial-{watcher,follow-up}.placey.plist`) bind the daemon and the watcher to the operator account named in the filename suffix — by default `placey`, with `HOME=/Users/placey` and Codex OAuth credentials at `$HOME/.codex/auth.json`. Both processes run under the operator who runs `launchctl bootstrap gui/$UID …` for the deployed plist; they are not pinned to a fixed user across the codebase.

Every time the daemon spawns a remediation worker (or the watcher spawns the reviewer subprocess), the spawned process:

- reads `$HOME/.codex/auth.json` (or whatever `CODEX_AUTH_PATH` is set to)
- invokes `codex`, a **two-stage launcher**: the user-facing path is a node script that runs `spawn` against the real Mach-O binary inside the platform-specific npm sub-package
- may invoke `claude` (a Mach-O binary at `/opt/homebrew/Caskroom/claude-code/<version>/claude`)

Reads under a user's home directory are exactly the boundary macOS TCC enforces under **Files and Folders** / **App Management** / **Full Disk Access**. The daemon's own long-lived `node` process is approved once and stays approved (that's why the per-tick loop is silent). Each fresh subprocess runs as a new TCC subject, and each unfamiliar binary re-prompts.

### Resolve the exact paths to approve

`scripts/print-tcc-targets.mjs` derives the TCC subjects from the **same code paths the daemon and watcher actually use**, separately for each spawn flow. Do not copy paths from another machine, from a doc, or from the shipped `.placey` example — approving the wrong binary leaves the popup loop in place.

```bash
node scripts/print-tcc-targets.mjs
```

The script prints, per spawn flow:

- **first-pass-review** → uses the hardcoded `CLAUDE_CLI` / `CODEX_CLI` constants in `src/reviewer.mjs`. The watcher LaunchAgent execs the reviewer in *its* launchd env, which is NOT the remediation env contract.
- **remediation-worker** → uses `resolveCodexCliPath()` / `resolveClaudeCodeCliPath()` in `src/follow-up-remediation.mjs`. Resolution order is `$CODEX_CLI_PATH` > `$CODEX_CLI` > `codex` resolved through the worker's inherited PATH (`/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` + the daemon's PATH at boot). NOT the caller's interactive shell PATH.
- **shared** → `/opt/homebrew/bin/node`, used by the watcher, the daemon, and the codex.js script wrapper (via the `#!/usr/bin/env node` shebang — `/opt/homebrew/bin` is first on the worker's PATH).

For each codex entrypoint the script follows the codex.js launcher to the real Mach-O binary inside the platform sub-package. That Mach-O — not the user-facing `codex` symlink — is the actual TCC subject.

> **Run from the same env the daemon will see at spawn time.** If you run from a different shell or a different login session, the `remediation-worker` resolution may pick up YOUR shell's `$CODEX_CLI_PATH` / `$PATH`, which is not the daemon's exec env. To match the daemon, run the helper from the same login session the daemon was launched from, or set `CODEX_CLI_PATH` / `CLAUDE_CODE_CLI_PATH` / `PATH` explicitly to match what the daemon's plist passes through.

The two flows can resolve to the **same** Mach-O on a single-operator host (and frequently do). They can also resolve to different binaries on hosts with multiple Codex installs, multiple node versions managed by `fnm`, or a non-default reviewer setup. The script reports both flows separately so you approve every binary that will actually be exec'd, not a single guess that happens to match one flow.

If you change the operator the daemon runs as, change codex install method, or change the watcher/reviewer host, **re-run the helper** before approving anything.

### How to add them in System Settings

1. Run `node scripts/print-tcc-targets.mjs` and note the "Distinct TCC subjects" list.
2. Open **System Settings → Privacy & Security → Full Disk Access**.
3. Click the **`+`** button. macOS opens a file picker.
4. Press **`⌘⇧G`** (Go to Folder). Without this, you can't navigate into `/opt`, `/Users/<name>/.local`, or any dotfile-prefixed directory because Finder hides them.
5. For each path the helper printed: paste the path's directory, select the binary, click Open.
6. Make sure each row in the Full Disk Access list shows a green toggle.

There is no CLI to do this — Apple gates this UI behind direct user consent on purpose. The first reviewer or remediation worker spawn after the approval is the verification: no popup means the approval landed.

### When to re-approve

Re-prompt triggers, in decreasing likelihood:

- A `codex` package upgrade (`npm i -g @openai/codex` or whatever installer the runtime uses). The platform-sub-package path is keyed on the codex *version*, so any version bump shifts the underlying Mach-O binary path → approval lapses → next worker spawn pops a TCC prompt.
- `fnm` reinstalls or upgrades node (the codex Mach-O lives under the active fnm node-version directory; switching node version moves it).
- `brew upgrade node` → Cellar version path changes → approval for `/opt/homebrew/Cellar/node/<old>/...` is dropped → re-approve `/opt/homebrew/bin/node` after the upgrade.
- `brew upgrade --cask claude-code` → same, for `claude`.
- A fresh macOS install or an account-level reset.
- Fresh Mac.

When popups start firing again, the cause is almost always one of the above. Re-run `node scripts/print-tcc-targets.mjs`, diff against the current FDA list, and re-approve only the one that moved.

### What this workaround does not protect against

This is the part that matters even after FDA is in place:

- A prompt-injection bug in PR content can still cause the reviewer or remediation worker to read protected user data — FDA *grants* that capability, it doesn't restrict it.
- A compromised codex/claude tool extension or model behavior change can still issue arbitrary file ops within the FDA-approved binary's privilege.
- The bypass-style approvals waive in-CLI gating, so the only enforcement boundaries left are (a) what the workspace dir scopes the worker to and (b) what FDA says the binary cannot see — and (b) is exactly what FDA grants away.

If those classes of risk are not acceptable on this host, do not grant FDA. Move to the [recommended posture](#recommended-posture-isolation) instead.

---

## Cross-references

- Daemon architecture and tick semantics: `docs/follow-up-runbook.md` (entry "macOS TCC popups on worker spawn" covers the operator-visible symptom).
- The os-restart script that installs the LaunchAgents at boot also prints a reminder pointing at this doc: `scripts/os-restart.sh` in the parent agent-os repo.
- First-pass review spawn paths and hardcoded CLI constants: `src/reviewer.mjs` (`CLAUDE_CLI`, `CODEX_CLI`, `reviewWithClaude`, `reviewWithCodex`).
- Remediation worker spawn paths and env contract: `src/follow-up-remediation.mjs` (`resolveCodexCliPath`, `resolveClaudeCodeCliPath`, `prepareCodexRemediationStartupEnv`, `prepareClaudeCodeRemediationStartupEnv`, `buildInheritedPath`, `spawnCodexRemediationWorker`, `spawnClaudeCodeRemediationWorker`).
- Authoritative path-emission helper: `scripts/print-tcc-targets.mjs`.

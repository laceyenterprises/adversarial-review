---
delegation: full
confidence: 0.9
last_verified: 2026-05-02
influence_weight: medium
tags: [adversarial-review, macos, tcc, install, runbook]
staleness_window: 60d
---
# macOS TCC: binaries to approve

When the adversarial-review stack runs on a fresh Mac (or after Homebrew bumps `node` or `claude` to a new version, or after fnm reinstalls Codex), macOS will start prompting "X would like to access data from other apps" / "X would like to access files in <user>'s home folder" every time a remediation worker spawns. This document is the canonical list of binaries to approve so those popups go away and stay away.

> **TL;DR:** add `/opt/homebrew/bin/node` and `/opt/homebrew/bin/claude` to **System Settings → Privacy & Security → Full Disk Access**. That's it. Use `⌘⇧G` (Go to Folder) in the file picker to navigate into `/opt`, which Finder hides by default.

## Why this is needed

The follow-up daemon (long-lived) and the watcher (long-lived) both run as the `airlock` user, but the codex CLI's OAuth credentials live under `/Users/placey/.codex/...`. Every time the daemon spawns a remediation worker, it `exec`s a fresh subprocess that:

- reads `/Users/placey/.codex/auth.json` (cross-user filesystem read)
- runs `codex` (whose shebang is `#!/usr/bin/env node` → really `/opt/homebrew/bin/node`)
- may run `claude` (a real Mach-O binary at `/opt/homebrew/Caskroom/claude-code/<version>/claude`)

Cross-user reads under another user's home are exactly the boundary macOS TCC enforces under **Files and Folders** / **App Management** / **Full Disk Access**. The daemon's own long-lived `node` process is approved once (and stays approved — that's why the per-tick loop is silent), but each fresh subprocess runs as a new TCC subject, and each unfamiliar binary re-prompts.

Approving the binaries at the OS layer once removes the prompts permanently — until the binary's hash changes (Homebrew/Caskroom version bump, fnm reinstall), which moves the real Cellar/Caskroom path and resets the approval. When that happens, you re-approve the one that moved.

## What to approve

The minimum set, in order:

1. **`/opt/homebrew/bin/node`** — runs the daemon, runs codex.js (via the `#!/usr/bin/env node` shebang since `PATH` puts `/opt/homebrew/bin` first), runs the watcher's reviewer subprocess.
2. **`/opt/homebrew/bin/claude`** — the Claude Code CLI. Used by the claude-code remediation worker class and by the Claude reviewer path.

Notes:

- These are symlinks. macOS resolves them and tracks the real Cellar/Caskroom paths. You drag the symlink in System Settings; the OS handles the rest.
- The fnm-installed node at `/Users/placey/.local/share/fnm/node-versions/<v>/installation/bin/node` is **not** on the worker's `PATH` (`/opt/homebrew/bin` is prepended), so it doesn't actually get used to run codex.js in this stack. No need to approve it unless you confirm via process inspection that it's the resolver.
- `acpx`'s shebang is `#!/bin/zsh`. The system `/bin/zsh` is FDA-approved by macOS by default — nothing to add.

## How to add them in System Settings

1. Open **System Settings → Privacy & Security → Full Disk Access**.
2. Click the **`+`** button. macOS opens a file picker.
3. Press **`⌘⇧G`** (Go to Folder). Without this, you can't navigate into `/opt` because Finder hides it.
4. Paste **`/opt/homebrew/bin`** and press Enter.
5. Select `node`, click Open. Repeat the `⌘⇧G` step and add `claude`.
6. Make sure both rows show a green toggle in the Full Disk Access list.

There is no CLI to do this — Apple gates this UI behind direct user consent on purpose. The first remediation worker spawn after the approval is the verification: no popup means the approval landed.

## When to re-approve

Re-prompt triggers, in decreasing likelihood:

- `brew upgrade node` → Cellar version path changes → approval for `/opt/homebrew/Cellar/node/<old>/...` is dropped → re-approve `/opt/homebrew/bin/node` after the upgrade.
- `brew upgrade --cask claude-code` → same, for `claude`.
- A fresh macOS install or an account-level reset.
- Fresh Mac.

If you start seeing TCC popups on remediation worker spawn again, the cause is almost always one of the above. Check the binary's real path and re-approve:

```bash
readlink -f /opt/homebrew/bin/node
readlink -f /opt/homebrew/bin/claude
```

If those paths look different from the last time you checked, that's the trigger.

## Cross-references

- Daemon architecture and tick semantics: `docs/follow-up-runbook.md`
- The os-restart script that installs the LaunchAgents at boot also prints a reminder pointing at this doc: `scripts/os-restart.sh` in the parent agent-os repo.
- Worker spawn paths: `src/follow-up-remediation.mjs` (`spawnCodexRemediationWorker`, `spawnClaudeCodeRemediationWorker`, `buildInheritedPath`).

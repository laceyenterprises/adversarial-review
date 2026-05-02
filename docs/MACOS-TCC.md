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

> **TL;DR:** add three binaries to **System Settings → Privacy & Security → Full Disk Access**:
>
> - `/opt/homebrew/bin/node`
> - `/opt/homebrew/bin/claude`
> - the real `codex` Mach-O binary, currently `/Users/placey/.local/share/fnm/node-versions/v24.14.0/installation/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex` (path moves with every codex/fnm version bump — see below for how to re-resolve).
>
> Use `⌘⇧G` (Go to Folder) in the file picker to navigate into `/opt` and `/Users/<name>/.local`, which Finder hides by default.

## Why this is needed

The follow-up daemon (long-lived) and the watcher (long-lived) both run as the `airlock` user, but the codex CLI's OAuth credentials live under `/Users/placey/.codex/...`. Every time the daemon spawns a remediation worker, it `exec`s a fresh subprocess that:

- reads `/Users/placey/.codex/auth.json` (cross-user filesystem read)
- runs `codex`, which is a **two-stage launcher**: the symlink resolves to a `codex.js` script (run by node via `#!/usr/bin/env node`), and that script in turn `spawn`s the real Mach-O `codex` binary that ships inside the platform-specific npm sub-package (`@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex`). Both node *and* the real codex binary are independent TCC subjects.
- may run `claude` (a real Mach-O binary at `/opt/homebrew/Caskroom/claude-code/<version>/claude`)

Cross-user reads under another user's home are exactly the boundary macOS TCC enforces under **Files and Folders** / **App Management** / **Full Disk Access**. The daemon's own long-lived `node` process is approved once (and stays approved — that's why the per-tick loop is silent), but each fresh subprocess runs as a new TCC subject, and each unfamiliar binary re-prompts.

Approving the binaries at the OS layer once removes the prompts permanently — until the binary's hash changes (Homebrew/Caskroom version bump, fnm reinstall, codex package upgrade), which moves the real path and resets the approval. When that happens, you re-approve the one that moved.

## What to approve

The minimum set, in order:

1. **`/opt/homebrew/bin/node`** — runs the daemon, runs `codex.js` (via the `#!/usr/bin/env node` shebang since `PATH` puts `/opt/homebrew/bin` first), runs the watcher's reviewer subprocess.
2. **`/opt/homebrew/bin/claude`** — the Claude Code CLI. Used by the claude-code remediation worker class and by the Claude reviewer path.
3. **The real `codex` Mach-O binary**, which is the child process `codex.js` spawns. The path is *not* the user-known `/Users/<user>/.local/share/fnm/.../bin/codex` symlink — that resolves to `codex.js`, a script. The actual TCC subject is the binary inside the platform-specific npm sub-package. Resolve it dynamically:

   ```bash
   /opt/homebrew/bin/node -e "
   const path = require('path');
   const triple = process.platform === 'darwin' && process.arch === 'arm64'
     ? 'aarch64-apple-darwin'
     : 'x86_64-apple-darwin';
   const codexJs = require('child_process')
     .execSync('readlink -f /Users/placey/.local/share/fnm/node-versions/*/installation/bin/codex')
     .toString().trim();
   console.log(path.join(path.dirname(codexJs), '..', 'node_modules',
     '@openai', 'codex-' + (process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'),
     'vendor', triple, 'codex', 'codex'));
   "
   ```

   That prints the absolute path. Drag it into Full Disk Access via `⌘⇧G` in the file picker.

Notes:

- The first two are symlinks. macOS resolves them and tracks the real Cellar/Caskroom paths. You drag the symlink in System Settings; the OS handles the rest.
- The third (codex) is *not* a symlink — the user-facing `codex` symlink resolves to a script, and TCC needs the actual binary the script spawns.
- The fnm-installed `node` at `/Users/<user>/.local/share/fnm/node-versions/<v>/installation/bin/node` is **not** on the worker's `PATH` (`/opt/homebrew/bin` is prepended), so it doesn't get used to run `codex.js`. No need to approve it unless you confirm via process inspection that it's the actual resolver.
- `acpx`'s shebang is `#!/bin/zsh`. The system `/bin/zsh` is FDA-approved by macOS by default — nothing to add.

## How to add them in System Settings

1. Open **System Settings → Privacy & Security → Full Disk Access**.
2. Click the **`+`** button. macOS opens a file picker.
3. Press **`⌘⇧G`** (Go to Folder). Without this, you can't navigate into `/opt` or any dotfile-prefixed directory because Finder hides them.
4. Paste **`/opt/homebrew/bin`** and press Enter. Select `node`, click Open.
5. Click `+` again. `⌘⇧G`, paste `/opt/homebrew/bin`, select `claude`.
6. Click `+` again. `⌘⇧G`, paste the codex binary path you resolved above (it'll start with `/Users/<user>/.local/share/fnm/...` — copy it into the picker exactly).
7. Make sure all three rows show a green toggle in the Full Disk Access list.

There is no CLI to do this — Apple gates this UI behind direct user consent on purpose. The first remediation worker spawn after the approval is the verification: no popup means the approval landed.

## When to re-approve

Re-prompt triggers, in decreasing likelihood:

- A `codex` package upgrade (`npm i -g @openai/codex` or whatever installer the runtime uses). The platform-sub-package path is keyed on the codex *version*, so any version bump shifts the underlying Mach-O binary path → approval lapses → next worker spawn pops a TCC prompt.
- `fnm` reinstalls or upgrades node (the codex binary lives under the active fnm node-version directory; switching node version moves it).
- `brew upgrade node` → Cellar version path changes → approval for `/opt/homebrew/Cellar/node/<old>/...` is dropped → re-approve `/opt/homebrew/bin/node` after the upgrade.
- `brew upgrade --cask claude-code` → same, for `claude`.
- A fresh macOS install or an account-level reset.
- Fresh Mac.

If you start seeing TCC popups on remediation worker spawn again, the cause is almost always one of the above. Check all three real paths:

```bash
readlink -f /opt/homebrew/bin/node
readlink -f /opt/homebrew/bin/claude
# Codex's real path requires resolving through codex.js — see "What to approve" above.
```

If any path looks different from the last time you checked, that's the trigger. Re-approve only the one that moved.

## Cross-references

- Daemon architecture and tick semantics: `docs/follow-up-runbook.md`
- The os-restart script that installs the LaunchAgents at boot also prints a reminder pointing at this doc: `scripts/os-restart.sh` in the parent agent-os repo.
- Worker spawn paths: `src/follow-up-remediation.mjs` (`spawnCodexRemediationWorker`, `spawnClaudeCodeRemediationWorker`, `buildInheritedPath`).

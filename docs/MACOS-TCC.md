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

The shipped LaunchAgent plists (`launchd/ai.laceyenterprises.adversarial-{watcher,follow-up}.placey.plist`) bind the daemon and the watcher to the operator account named in the filename suffix — by default `placey`, with `HOME=/Users/placey` and Codex OAuth credentials at `$HOME/.codex/auth.json`. Both processes run under the operator that runs `launchctl bootstrap gui/$UID …` for the deployed plist; they are not pinned to a fixed user across the codebase. (Cross-user execution — e.g., a daemon running as one operator with `HOME` pointed at another operator's home directory — is a host-specific override, not the default behavior.)

Every time the daemon spawns a remediation worker, it `exec`s a fresh subprocess that:

- reads `$HOME/.codex/auth.json` (or whatever `CODEX_AUTH_PATH` is set to)
- runs `codex`, which is a **two-stage launcher**: the symlink resolves to a `codex.js` script (run by node via `#!/usr/bin/env node`), and that script in turn `spawn`s the real Mach-O `codex` binary that ships inside the platform-specific npm sub-package (e.g. `@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex` on Apple Silicon, `codex-darwin-x64/vendor/x86_64-apple-darwin/...` on Intel). Both node *and* the real codex binary are independent TCC subjects.
- may run `claude` (a real Mach-O binary at `/opt/homebrew/Caskroom/claude-code/<version>/claude`)

Reads under a user's home directory are exactly the boundary macOS TCC enforces under **Files and Folders** / **App Management** / **Full Disk Access**. The daemon's own long-lived `node` process is approved once (and stays approved — that's why the per-tick loop is silent), but each fresh subprocess runs as a new TCC subject, and each unfamiliar binary re-prompts.

Approving the binaries at the OS layer once removes the prompts permanently — until the binary's hash changes (Homebrew/Caskroom version bump, fnm reinstall, codex package upgrade), which moves the real path and resets the approval. When that happens, you re-approve the one that moved.

## What to approve

The minimum set, in order:

1. **`/opt/homebrew/bin/node`** — runs the daemon, runs `codex.js` (via the `#!/usr/bin/env node` shebang since `PATH` puts `/opt/homebrew/bin` first), runs the watcher's reviewer subprocess.
2. **`/opt/homebrew/bin/claude`** — the Claude Code CLI. Used by the claude-code remediation worker class and by the Claude reviewer path.
3. **The real `codex` Mach-O binary**, which is the child process `codex.js` spawns. The path is *not* the user-known `/Users/<user>/.local/share/fnm/.../bin/codex` symlink — that resolves to `codex.js`, a script. The actual TCC subject is the binary inside the platform-specific npm sub-package. Resolve it dynamically through the same env contract the remediation worker uses (`src/follow-up-remediation.mjs::resolveCodexCliPath`): `$CODEX_CLI_PATH`, then `$CODEX_CLI`, then `command -v codex`. The resolver below asserts a single concrete path before deriving the vendor binary, so a multi-version `fnm` install can't silently approve the wrong one:

   ```bash
   /opt/homebrew/bin/node -e '
     const { execSync } = require("child_process");
     const { existsSync } = require("fs");
     const path = require("path");

     function resolveCodexExe() {
       for (const c of [process.env.CODEX_CLI_PATH, process.env.CODEX_CLI]) {
         if (c && existsSync(c)) return c;
       }
       try {
         const out = execSync("command -v codex", { shell: "/bin/zsh", encoding: "utf8" }).trim();
         return out || null;
       } catch { return null; }
     }
     const codex = resolveCodexExe();
     if (!codex) {
       console.error("codex executable not resolvable via $CODEX_CLI_PATH, $CODEX_CLI, or PATH");
       process.exit(2);
     }
     const real = execSync("readlink -f " + JSON.stringify(codex), { encoding: "utf8" }).trim();
     if (!real || real.includes("\n")) {
       console.error("ambiguous readlink result for " + codex + ": " + JSON.stringify(real));
       process.exit(2);
     }
     const arm = process.arch === "arm64";
     const triple = arm ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
     const subPkg = arm ? "codex-darwin-arm64" : "codex-darwin-x64";
     console.log(path.join(path.dirname(real), "..", "node_modules",
       "@openai", subPkg, "vendor", triple, "codex", "codex"));
   '
   ```

   That prints the absolute path of the binary the worker will actually exec. Drag it into Full Disk Access via `⌘⇧G` in the file picker. If the resolver exits non-zero, do not guess a path — set `CODEX_CLI_PATH` to the executable the worker is configured to run and rerun.

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

# Deployment from a fresh Mac

This is the operator runbook for standing up the adversarial-review
watcher and follow-up daemon on a clean macOS host. It is the path the
installer is built around — if any step here is wrong, file an issue and
we will treat that as a bug, not a doc gap.

The runbook covers single-user macOS hosts (one operator, one running
watcher). Multi-operator topology on a shared host (the maintainer's
`placey` / `airlock` split) is intentionally a follow-up — see
[`KNOWN-SHARP-EDGES.md`](../KNOWN-SHARP-EDGES.md).

Total time on a fresh laptop: about 15 minutes, most of it `npm ci`.

## Prerequisites

- macOS with Apple silicon or Intel; `plutil` is part of the base system.
- Node 20 or newer. Homebrew (`brew install node`) is the documented
  install path; the watcher's `PATH` includes `/opt/homebrew/bin` and
  `/usr/local/bin` to find it.
- The GitHub CLI (`brew install gh`) signed in via `gh auth login`. The
  watcher resolves `GITHUB_TOKEN` from the env first and from
  `gh auth token` as a fallback.
- A repo to review. The watcher reads its target repos from
  `config.json`.

## The five-step path

### 1. Clone the repo

```bash
git clone https://github.com/laceyenterprises/adversarial-review.git
cd adversarial-review
```

### 2. Install dependencies

```bash
npm ci
```

This installs the kernel + adapter code and the native `better-sqlite3`
module. After a Node major-version bump you may need
`npm rebuild better-sqlite3` to re-link against the new ABI; the
rendered wrapper scripts detect this and refuse to start so a stale
ABI never turns into a launchd respawn storm.

### 3. Pick paths (or accept the defaults)

The installer reads the following as either env vars (env wins) or
interactive prompts. Defaults work for a single-user laptop; export them
explicitly if you want a non-default layout:

| Variable               | Default                                                  | What it is                                              |
| ---------------------- | -------------------------------------------------------- | ------------------------------------------------------- |
| `REPO_ROOT`            | `git rev-parse --show-toplevel`                          | Absolute path to this checkout.                         |
| `OPERATOR_HOME`        | `$HOME`                                                  | Running operator's `$HOME`.                             |
| `SECRETS_ROOT`         | `$OPERATOR_HOME/.config/adversarial-review/secrets`      | Created mode `0700`. Holds `adversarial-review.env`.    |
| `LOG_ROOT`             | `$OPERATOR_HOME/Library/Logs/adversarial-review`         | Created mode `0755`. Holds `*.log` files.               |
| `REVIEWER_AUTH_ROOT`   | empty                                                    | Optional. If set, the rendered wrappers point Codex's OAuth state at `$REVIEWER_AUTH_ROOT/codex/auth.json` instead of `$HOME/.codex/auth.json`. |
| `WATCHER_USER_LABEL`   | `local`                                                  | Namespaces the rendered plist filenames so two operators on one Mac can install side-by-side: `ai.<label>.adversarial-watcher.plist`. |

You can also preview the render without writing anything:

```bash
bash tools/adversarial-review/install.sh --dry-run
```

`--dry-run` writes the rendered files into a temp directory, skips the
postflight checks, and prints what it would have written.

### 4. Run the installer

```bash
bash tools/adversarial-review/install.sh
```

This renders four files:

- `~/Library/LaunchAgents/ai.<label>.adversarial-watcher.plist`
- `~/Library/LaunchAgents/ai.<label>.adversarial-follow-up.plist`
- `<repo>/scripts/render/adversarial-watcher-start.sh`
- `<repo>/scripts/render/adversarial-follow-up-tick.sh`

Each rendered file carries a header comment recording the source
template, the time it was rendered, and the binding values used. Do not
edit rendered files in place — re-run `install.sh` to change them.

After rendering, the installer runs a postflight validator that checks:

- Node satisfies `package.json` `engines.node` (>=20 <26).
- `gh auth status` succeeds.
- The working tree is clean (this is a warning, not a blocker).
- The secret-source dotenv at `$SECRETS_ROOT/adversarial-review.env` is
  readable (warning if missing; the wrapper still falls back to
  `gh auth token` for `GITHUB_TOKEN`).
- The optional `$REVIEWER_AUTH_ROOT` is readable when set.

Any failure prints the actionable remediation and exits non-zero.

### 5. Bootstrap the LaunchAgents

The installer prints the exact commands for the bindings it used. The
short version:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.local.adversarial-watcher.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.local.adversarial-follow-up.plist
```

Verify the watcher loaded:

```bash
launchctl print "gui/$(id -u)/ai.local.adversarial-watcher"
tail -f ~/Library/Logs/adversarial-review/adversarial-watcher.log
```

Routine ops:

```bash
launchctl bootout   "gui/$(id -u)" ~/Library/LaunchAgents/ai.local.adversarial-watcher.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/ai.local.adversarial-watcher.plist
launchctl kickstart -k "gui/$(id -u)/ai.local.adversarial-watcher"
```

## The operator dotenv

The rendered wrapper scripts source `$SECRETS_ROOT/adversarial-review.env`
if it exists. This is the single file you can drop the watcher's tokens
into; the wrappers `set -a` / source / `set +a` so every assignment is
exported into the watcher process.

Minimum useful contents on a single-operator host:

```bash
# GitHub identity. Optional — the wrapper falls back to `gh auth token`
# when GITHUB_TOKEN is unset.
GITHUB_TOKEN=ghp_...

# Reviewer-bot PATs used by the comment poster. Missing values defer
# comment posts to retry (see src/follow-up-remediation.mjs); they do
# not block the consume/reconcile path.
GH_CLAUDE_REVIEWER_TOKEN=ghp_...
GH_CODEX_REVIEWER_TOKEN=ghp_...

# Linear, optional. Absent means Linear updates are skipped.
LINEAR_API_KEY=lin_api_...

# 1Password service-account token, optional. Only relevant if you wire
# `op read` into your own secret-management flow on top of this file.
OP_SERVICE_ACCOUNT_TOKEN=ops_eyJ...
```

Keep the file mode at `0600` inside `$SECRETS_ROOT` (which itself is
`0700`). The installer creates the secrets root with the right mode;
write your file there with `umask 077` or `chmod 600` after.

## Troubleshooting

Below are the first-run failures we expect outside operators to hit, in
order of how often they actually trip people up.

### `OP_SERVICE_ACCOUNT_TOKEN` missing

The wrapper warns if `$SECRETS_ROOT/adversarial-review.env` isn't
readable, but it does not exit. If you see the warning, either drop a
dotenv at that path (see above) or leave `OP_SERVICE_ACCOUNT_TOKEN`
out — the watcher and follow-up daemon do not require it on hosts that
aren't using 1Password resolution.

### `gh auth status` not authenticated

```bash
gh auth login
```

Re-run `bash tools/adversarial-review/install.sh` afterwards so the
postflight catches the green state.

### Node outside the engines range

`package.json` pins `engines.node` to `>=20 <26`. If your `node` is
older or newer than that:

```bash
brew upgrade node     # or whichever node manager you use
npm rebuild better-sqlite3
```

After a Node major bump you almost always need
`npm rebuild better-sqlite3`. The rendered wrapper detects the resulting
ABI mismatch and sleeps for 3600s instead of crash-looping, so the symptom
is "watcher running but doing nothing." `launchctl print` will show
recent exits with the native-check error captured in
`$LOG_ROOT/adversarial-watcher-native-check.err`.

### Watcher loaded but exits immediately

Check the log file at
`$LOG_ROOT/adversarial-watcher.log`. The most common patterns are:

- `GITHUB_TOKEN not set and gh auth token returned nothing` — the
  wrapper could not resolve a token; run `gh auth login` or drop one
  into the dotenv.
- `better-sqlite3 failed to load` — see the Node section above.

### Rendered files are wrong / paths drifted

Re-run the installer. The rendered files are deterministic functions
of the inputs; there is no separate state to clear. To roll back to a
clean state:

```bash
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/ai.local.adversarial-watcher.plist || true
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/ai.local.adversarial-follow-up.plist || true
rm -f ~/Library/LaunchAgents/ai.local.adversarial-watcher.plist
rm -f ~/Library/LaunchAgents/ai.local.adversarial-follow-up.plist
rm -rf scripts/render
bash tools/adversarial-review/install.sh
```

## What this iteration does not yet cover

The legacy maintainer-local plists under `launchd/` and the maintainer
wrappers under `scripts/adversarial-*` remain in the tree as a documented
example of a two-operator topology (`placey` operator + `airlock` agent).
They are not what `install.sh` renders, and outside operators should
ignore them.

The follow-up tickets to fully retire them:

- Multi-operator render (placey/airlock split, two `WATCHER_USER_LABEL`
  values on a shared host).
- LAC-597 formal secret-source contract (1Password service account
  resolution moved out of the wrapper into a typed helper).
- Linux systemd templates that render against the same placeholder
  surface.
- Brew tap / `npm install -g` packaging.

See [`KNOWN-SHARP-EDGES.md`](../KNOWN-SHARP-EDGES.md) for the running
list.

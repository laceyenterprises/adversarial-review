# ARF stands up from this repo — standup note (AMV-03)

**Date:** 2026-08-22 · **Spec:** `arf-relocation@5cecd4357c90` (AMV-03) ·
**Verified by:** `frontend/scripts/standup-verify.mjs`

ARF — the Adversarial Review Frontend — was built under `apps/arf` in the
**agent-os** repo and has moved into this one, at [`frontend/`](../frontend),
mounted as `tools/adversarial-review/frontend/` when agent-os inits this
submodule. This note records that the moved app still stands up, and gives the
one command that re-establishes it.

The move's premise is that ARF is a standalone app *outside* the OS: its own
server, frontend, process manager, gate, and store, with zero agent-os runtime
dependency. Co-locating it with the pipeline it is the frontend for must not
turn into coupling with it — ARF reads the pipeline's **data files**, never its
code.

## The result

Both from a standalone checkout of this repo and from the agent-os mount at
`tools/adversarial-review/frontend/`:

```
ARF standup verification (AMV-03)
  arf root       …/agent-os/tools/adversarial-review/frontend
  pipeline root  …/agent-os/tools/adversarial-review
  sandbox        …/T/arf-standup-verify-7TTlEo

  PASS  boot                           listening on http://127.0.0.1:50589
  PASS  supervisor-status              arf-server running (pid 51595, 0 restarts)
  PASS  healthz                        200 ok, standalone store at …/arf-standup-verify-7TTlEo/review-store.db
  PASS  screen-a-shell                 200, 4731 bytes, dashboard shell present
  PASS  screen-a-modules               /dashboard.mjs 6720B, /app.mjs 624B, /app.css 6228B
  PASS  screen-a-data                  200, store available, 0 open PR(s) — honest empty state
  PASS  screen-b-panel                 200, 14169 bytes, all 3 merge paths and both kill switches drawn
  PASS  screen-b-data                  200, stopState=unknown, 3 daemons, 3 merge paths
  PASS  pipeline-root-rerooted         pipelineRoot=…/agent-os/tools/adversarial-review (config.yaml present=true)
  PASS  gate-uninstalled-fails-closed  status reports "not installed"; check refuses with exit 4
  PASS  gate-init                      gate installed at seq 1, hammer armed, check exits 0
  PASS  gate-disarm                    hammer disarmed (exit 3), daemon-clean untouched (exit 0)
  PASS  gate-visible-to-server         server reports hammer disarmed-path, daemon-clean armed — same document as the CLI
  PASS  gate-rearm                     hammer re-armed at seq 3 by amv-03-standup-verify
  PASS  gate-audit                     3 entries (init → disarm → arm), all attributed to amv-03-standup-verify
  PASS  e2e-smoke                      pass 1, fail 0
  PASS  teardown                       supervisor stopped, http://127.0.0.1:50589 refused, sandbox removed

17 checks: 17 passed, 0 failed
```

Alongside it, the full ARF suite from the new home: **683 pass / 0 fail**
(server + supervisor) and **18 pass / 0 fail** (frontend), including the
self-containment guard.

## Re-running it

```bash
cd frontend                       # or tools/adversarial-review/frontend from agent-os
npm run standup:verify            # or: node scripts/standup-verify.mjs [--json]
```

Exit **0** when every check passes, **1** when any fails, **130** when
interrupted. `--json` prints the same results as a machine-readable object.

The script needs Node **>= 23.4** (ARF's `engines`) and nothing else — no
install step, no network, no live pipeline, no GitHub token. It takes about
seven seconds.

## What the checks are actually holding

**It boots the packaged app, not a library.** `arf up` runs the real supervisor,
which spawns the real server; `arf status --json` has to report `arf-server`
`running`. A verification that imported the server and called a handler would
pass with a broken `bin/arf`.

**Screen A is asserted through what a server can be held to.** The dashboard is
client-rendered, so "renders" means three things together: the shell carries the
tab label and the `#dashboard-root` mount point, the modules that fill it are
served non-empty, and `/v1/reviews/prs` answers 200 with an **available** store.
That last part is the honest empty state — zero pull requests from a store ARF
can read is a true answer; an unreadable store rendering as "no reviews" is the
lie the check exists to catch. A 200 on `/` alone would wave through a blank
panel, so a zero-byte or 404 asset fails the run.

**Screen B has to be drawn whole.** All three merge paths (`hammer`,
`daemon-clean`, `python-backstop`), both kill switches, and every section of the
panel must be present. A merge path that goes missing from the panel is exactly
the failure Screen B exists to prevent, so a partially-drawn panel fails rather
than reading as fine.

**`pipeline-root-rerooted` is the move's load-bearing check.** Under `apps/arf`
these paths resolved through a `tools/adversarial-review/` prefix off the
agent-os root. From here they must resolve directly off *this repo's* root: the
running server has to report its watcher heartbeat source as
`<repo>/data/watcher-heartbeat.json` and its governance config source as
`<repo>/config.yaml`. The comparison is between absolute paths, so it holds both
for a standalone checkout and for a checkout mounted at
`tools/adversarial-review` inside an agent-os tree — where `pipelineRoot`
legitimately *is* a path containing that string.

**The gate is exercised through its contract exit codes**, not its output text:
`0` armed, `3` disarmed by an operator, `4` fail-closed refusal. A fresh state
root with no gate document must refuse with `4` — fail-closed is the design. A
scoped disarm must stop `hammer` and leave `daemon-clean` alone. And the server,
booted *before* the gate existed, must report the flip the CLI just made: a
cached gate is a stop-state that was true once.

## The sandbox, and why it is asserted rather than assumed

The child environment is built from scratch rather than inherited, with
`ARF_STATE_ROOT` and `HOME` pointed inside a fresh `mkdtemp` directory. No
`ARF_MODE`, `ARF_STORE_PATH`, or `ARF_CONFIG_FILE` survives from the caller, so
a standup verification can never attach to a live pipeline's single-writer
`reviews.db` — and `~/.arf/config.json` cannot silently change what is being
verified. The `healthz` check then asserts the store path really is inside the
sandbox, because "we set the env correctly" is a claim and "the store is here"
is an observation.

Teardown is a check, not an epilogue. The supervisor is stopped and the sandbox
removed on every exit path — success, failure, exception, Ctrl-C — and the run
then asserts that the port stops answering and the sandbox is gone. Children are
reaped **before** the directory is removed: an `arf gate init` still in flight
during a Ctrl-C will re-create `<sandbox>/governance/` on its way out, which is
how the interrupted path leaked a directory during development.

Every run gets its own sandbox and binds port 0, so runs are idempotent and do
not collide with each other or with a live ARF on 8787.

## Two things this does not cover

**It is not in CI.** This repo's test workflow runs Node 20 and 22; ARF's
`engines` require >= 23.4. The ARF suites are likewise not in that workflow —
this is an operator/standup command, run by hand from a checkout with the
submodule inited.

**Existing standup test fixtures leak temp directories.**
`frontend/server/test/helpers/standup-fixtures.mjs` creates `arf-standup-*`
directories under the system temp dir and does not remove them; several hundred
were already present on the verification host. This predates the move and is
untouched by it. The verification script deliberately uses the distinct prefix
`arf-standup-verify-` so its own leftovers — of which there are none — stay
distinguishable from that litter.

## References

- [`frontend/scripts/standup-verify.mjs`](../frontend/scripts/standup-verify.mjs) — the script
- [`frontend/README.md`](../frontend/README.md) — "Verify the standup"
- [`frontend/server/test/e2e-smoke.test.mjs`](../frontend/server/test/e2e-smoke.test.mjs) — the ARF-09 end-to-end smoke this run includes
- [`frontend/server/test/no-agent-os-imports.test.mjs`](../frontend/server/test/no-agent-os-imports.test.mjs) — the self-containment guard the move had to keep load-bearing
- [`frontend/gate/gate-contract.mjs`](../frontend/gate/gate-contract.mjs) — merge paths, decision codes, and the exit codes asserted above

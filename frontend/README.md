# ARF — Adversarial Review Frontend

ARF is a separate frontend for the adversarial-review (AR) pipeline. It is
designed to run as a **fully self-contained standalone app outside the OS**: its
own thin API, its own review-state store, its own config, and **zero agent-os
runtime dependency**. It talks only to its own store and (from ARF-02) GitHub.

The pack spec is [`projects/adversarial-review-frontend/SPEC.md`](../../projects/adversarial-review-frontend/SPEC.md).

This tree is `frontend/*` rather than pipeline `src/*` precisely so the standalone
build is a clean bundle boundary.

## Status

| Ticket | Surface | State |
|---|---|---|
| ARF-01 | `server/` — backend skeleton + review-state store adapter | landed |
| ARF-02 | `server/src/github/` — read-only GitHub mirror/adapter | landed |
| ARF-03 | `frontend/dashboard.mjs` — review dashboard (Screen A) | landed |
| ARF-04 | `server/src/governance/` + `frontend/src/screen-b/` — pipeline-health + governance panel (Screen B) | landed |
| ARF-05 | `server/src/standup/` + `frontend/` — identity standup wizard (Screen C) | landed |
| ARF-06 | `server/src/standup/` + `frontend/` — harness standup wizard (Screen C, harnesses) | landed |
| ARF-07 | `server/src/broker/` — token/identity-broker abstraction | landed |
| ARF-08 | `supervisor/` + `gate/` + `server/src/governance/gate-*` — standalone packaging, process manager, load-independent arm/disarm | landed |
| ARF-09 | `server/test/e2e-smoke.test.mjs` — end-to-end smoke | landed |

## The self-containment boundary

`frontend` imports **nothing** outside itself — no `src/`, `modules/`, `platform/`,
`runtime/`, or `tools/`, no session-ledger, no broker client, no `hq`, and no npm
dependency at all. Only `node:` builtins.

This is enforced mechanically by
[`server/test/no-agent-os-imports.test.mjs`](server/test/no-agent-os-imports.test.mjs),
which scans every source file under `frontend` and fails on a bare specifier, a
relative import that escapes `frontend`, or any pipeline runtime path.

Agent-os files listed below are **reference models only** — read to learn a
shape, never imported:

- `modules/operator-console/server/cwp_operator_console/server/review_reads.py` —
  how the console projects `reviews.db`.
- `src/` — the live `reviews.db` schema and the review
  body grammar findings are written in.
- `platform/oauth-broker/src/oauth_broker/providers/github_app.py` plus
  `identities/*.yaml` and `modules/worker-pool/config/entitlement-descriptors.tsv`
  — the shape of GitHub-App minting and of a role's identity descriptor, which
  `server/src/broker/` reimplements over `node:` builtins.
- `docs/RUNBOOK-adversarial-review-pipeline.md`, plus
  `src/{config-loader,ama-closure-orchestration}.mjs`,
  `src/review-cycle-cap.mjs`, and
  `modules/worker-pool/lib/python/cwp_dispatch/auto_merge_daemon.py` — the actual
  semantics of the merge-authority keys, the two MSM paths, the Python
  backstop's deferral, and the review-cycle accounting that
  `server/src/governance/` reports on. Every claim in `governance/keys.mjs` is
  sourced from these rather than inferred from a key's name.

## Requirements

Node **>= 23.4** (or Node 22.5+ run with `--experimental-sqlite`). ARF uses the
built-in `node:sqlite` module and global `fetch`, which is what lets it have zero
npm dependencies. A Node without `node:sqlite` fails loud at first store use with
an actionable message.

## Run it

The standalone path — one process manager, one state root, one config, and no
launchd, session-ledger, or broker required:

```bash
cd frontend
node supervisor/bin/arf up            # supervises the ARF server; Ctrl-C stops it
```

In another shell:

```bash
cd frontend
node supervisor/bin/arf status
node supervisor/bin/arf gate init --actor "$USER" --reason "install"
node supervisor/bin/arf gate status
curl -s localhost:8787/healthz
```

Or run just the API without a supervisor:

```bash
cd frontend/server
npm start                 # or: node src/main.mjs
```

## Test it

```bash
cd frontend
npm test                  # server + supervisor + frontend suites

# or narrow to one package
cd frontend/server && npm test    # or: node --test test/*.test.mjs
cd frontend/frontend && npm test
npm --prefix frontend/server run fixture:build   # regenerate test/fixtures/reviews.db
```

There is no install step: `npm test` runs against a checkout with no
`node_modules`. Every `package.json` under `frontend` declares empty
`dependencies` and `devDependencies`, and
[`server/test/no-agent-os-imports.test.mjs`](server/test/no-agent-os-imports.test.mjs)
asserts that over all of them, not just the server's. `python3` is used by two
suites — the gate parity diff and the Python half of the no-bounce test — and
both skip loudly rather than fail when it is absent.

## Configuration

Resolution order, lowest precedence first: built-in defaults → JSON config file
→ environment.

The config file is `ARF_CONFIG_FILE` if set, else `<stateRoot>/config.json` if it
exists. Unknown keys in it are a **hard error**, not a warning — a silently
ignored `storePth` typo would leave ARF pointed at the default store, showing an
empty dashboard with no explanation.

| Env | Config-file key | Default | Meaning |
|---|---|---|---|
| `ARF_MODE` | `mode` | `standalone` | `standalone` or `in-os` |
| `ARF_STATE_ROOT` | `stateRoot` | `~/.arf` | ARF's own state root |
| `ARF_STORE_PATH` | `storePath` | derived (below) | review-state store file |
| `ARF_PIPELINE_ROOT` | `pipelineRoot` | repo root | checkout the live pipeline lives in |
| `ARF_HOST` | `host` | `127.0.0.1` | bind address |
| `ARF_PORT` | `port` | `8787` | bind port |
| `ARF_STORE_BUSY_TIMEOUT_MS` | `busyTimeoutMs` | `2000` | SQLite busy timeout, on review-store reads and mirror-cache writes alike |
| `ARF_CONFIG_FILE` | — | `<stateRoot>/config.json` | config file location |
| `ARF_GITHUB_API_BASE` | `githubApiBase` | `https://api.github.com` | GitHub API base (GHES) |
| `ARF_GITHUB_TOKEN_ENV` | `githubTokenEnv` | `ARF_GITHUB_TOKEN` | **name** of the env var holding the token |
| `ARF_GITHUB_TOKEN_FILE` | `githubTokenFile` | — | file whose contents are the token; wins over the env source |
| `ARF_GITHUB_MIRROR_PATH` | `githubMirrorPath` | `<stateRoot>/github-mirror.db` | mirror cache file |
| `ARF_GITHUB_MIRROR_TTL_MS` | `githubMirrorTtlMs` | `60000` | how long a mirror row is served without refetching |
| `ARF_GITHUB_MIN_REFRESH_MS` | `githubMinRefreshIntervalMs` | `10000` | floor under refetching that `force` also respects |
| `ARF_GITHUB_REQUEST_TIMEOUT_MS` | `githubRequestTimeoutMs` | `10000` | per-request timeout |
| `ARF_GITHUB_MAX_CONCURRENT_REFRESHES` | `githubMaxConcurrentRefreshes` | `3` | in-flight refreshes per batch |
| `ARF_GITHUB_REFRESH_BUDGET` | `githubRefreshBudget` | `25` | PRs one batch call may refresh |
| `ARF_GITHUB_MAX_PAGES` | `githubMaxPages` | `10` | pages one paginated collection may walk (100/page) |
| — | `broker` | `{}` | token/identity broker section (below) |
| — | `pipeline` | `{}` | pipeline-governance read section (below) |
| `ARF_PIPELINE_CONFIG_FILES` | `pipeline.configFiles` | derived | `:`-separated governance config layers, **lowest precedence first** |
| `ARF_PIPELINE_ENV_FILE` | `pipeline.envFile` | — | JSON snapshot of the *daemon's* environment (config layer 5) |
| `ARF_PIPELINE_HEARTBEAT_STALE_MS` | `pipeline.heartbeatStaleMs` | `600000` | age past which a heartbeat reads `stale` |
| `ARF_PIPELINE_WATCHER_HEARTBEAT` | `pipeline.heartbeats.watcher` | derived | watcher heartbeat file |
| `ARF_PIPELINE_FOLLOW_UP_HEARTBEAT` | `pipeline.heartbeats.followUp` | — | follow-up daemon liveness source |
| `ARF_PIPELINE_AUTO_MERGE_HEARTBEAT` | `pipeline.heartbeats.autoMerge` | — | auto-merge daemon liveness source |
| — | `standup` | `{}` | harness standup section (below) |
| `ARF_GATE_FILE` | `gatePath` | `<stateRoot>/governance/gate.json` | the arm/disarm gate document |
| `ARF_GATE_AUDIT_FILE` | `gateAuditPath` | `<stateRoot>/governance/gate-audit.jsonl` | the gate's audit trail |
| — | `supervisor` | `{}` | process-manager section (below) |
| `ARF_SUPERVISOR_LOG_DIR` | `supervisor.logDir` | `<stateRoot>/logs` | per-program log files |
| `ARF_SUPERVISOR_RUN_DIR` | `supervisor.runDir` | `<stateRoot>/run` | status file + instance pidfile |
| `ARF_SUPERVISOR_SHUTDOWN_TIMEOUT_MS` | `supervisor.shutdownTimeoutMs` | `10000` | SIGTERM grace before SIGKILL |
| `ARF_SUPERVISOR_SERVER_ENABLED` | `supervisor.serverEnabled` | `true` | supervise the built-in ARF server |
| `ARF_SUPERVISOR_PROGRAMS_FILE` | `supervisor.programs` | `[]` | JSON file holding the program list |

`ARF_GITHUB_TOKEN` is deliberately **not** a config key — it is the value read
through the source the keys above name, so it never enters the resolved config
object, `/github/status`, or a log line.

Derived store-path defaults:

- `standalone` → `<stateRoot>/review-store.db`, a file ARF owns and provisions.
- `in-os` → `<pipelineRoot>/data/reviews.db`.

### Modes

**`standalone`** — no live pipeline. ARF creates and owns an SQLite file using
the same table and column names as `reviews.db` for the subset it reads, so one
set of projection SQL serves both modes and the standalone shape cannot drift
from the live one.

**`in-os`** — a live pipeline is present. ARF opens its `reviews.db`
**read-only**, always. `reviews.db` is single-writer (better-sqlite3,
watcher-owned) and a second writer risks corrupting pipeline state, so
`readOnly` is *derived from the mode* and there is deliberately no env knob that
can turn it off.

In both modes the **read path only ever holds a read-only handle**. The one
writable handle in the codebase provisions the standalone file and refuses to
open at all when the config is read-only.

### Cross-user reads and WAL sidecars

`SQLITE_OPEN_READONLY` is not enough on its own. Opening a WAL-mode database
*creates* the `-wal` / `-shm` sidecars when they do not already exist, owned by
the **reading** process — so ARF running as a different macOS account than the
pipeline watcher would lock the watcher out of its own `reviews.db`. That is the
cross-uid sidecar outage class the session-ledger and `hq dag chain` read paths
already guard against.

So the store adapter resolves the store file's owner *before* it opens anything,
and picks the strategy from it:

| Owner | Sidecars | Open | Why |
|---|---|---|---|
| ARF's uid | — | `mode=ro`, locking on | Any sidecar the read creates is ours, which is what the pipeline already expects. `busy_timeout` waits a concurrent pipeline write out instead of failing the read into a blank dashboard. |
| another uid | none present | `mode=ro&immutable=1` | `immutable=1` takes no locks and creates no sidecar at all. Sound precisely because no `-wal` exists: every committed row is already in the main database file, so nothing is stranded. |
| another uid | `-wal` / `-shm` present | **refused** | The database is mid-WAL under another uid: `immutable=1` would read past the WAL, and `mode=ro` needs to write the foreign `-shm`. |

`immutable=1` is never used on the same-owner path — a live `reviews.db` is being
written while ARF reads it, so SQLite's locking has to stay on or a read could
observe a torn mid-write state.

The sidecar check follows symlinks. SQLite puts `-wal` / `-shm` beside the file
it actually opens, so a symlinked store keeps its sidecars next to the *target*.
Looking for them beside the link would find nothing, fall through to
`immutable=1`, and read straight past a live WAL — a dashboard serving stale rows
while looking perfectly current.

A refusal is not a silent empty. `/healthz` reports `store.available: false` with
a `reason` that names the uid to run ARF as, rather than the generic "pipeline
not present or not yet run".

## API

| Route | Response |
|---|---|
| `GET /healthz` | `{status, uptimeMs, store:{…}, broker:{mode, configured}}` |
| `GET /version` | `{name, version, apiVersion, node}` |
| `GET /github/status` | `{apiBase, ready, token:{kind, ref, present, reason}, cache:{...}, rateLimit, requests}` |
| `GET /github/mirror?repo=owner/name&pr=<n>[&refresh=1]` | `{mirror, cacheHit, fetched, throttled?, refreshError?}` |
| `GET /pipeline/health` | `{daemons, mergePaths, stopState, killSwitches, governance, reviewCycle, store}` |
| `GET /pipeline/panel` | Screen B, rendered as a self-contained HTML page |
| `GET /v1/standup/identity/steps` | the step list + the status vocabulary |
| `GET /v1/standup/identity/roles` | broker mappings joined with recorded runs |
| `GET /v1/standup/identity/runs/<role>` | the last recorded run, or 404 |
| `POST /v1/standup/identity/runs` | **SSE** — runs a standup, streaming per-step status |
| `GET /v1/governance/gate[?auditLimit=<n>]` | the gate document, what each merge path is told, and the audit tail |
| `POST /v1/governance/gate/init` | install the gate — `{actor, reason, armed?}` |
| `POST /v1/governance/gate/arm` | `{scope\|path, actor, reason, expectedSeq?}` |
| `POST /v1/governance/gate/disarm` | same body; `scope: "all"` is the emergency stop |
| `GET /api/standup/harness` | registered harnesses + the reviewer allowlist + mapped broker roles |
| `GET /api/standup/harness/catalog` | harness templates the panel prefills from |
| `POST /api/standup/harness/runs` | runs the harness standup wizard; SSE step stream, or JSON |
| `GET /ui/` | the harness panel |
| `GET /` and assets | the identity standup SPA |

There are exactly three write surfaces — the identity standup runner, the
harness standup runner, and the arm/disarm gate. Everything else stays read-only
and a write to it is still a 405. Merge *execution* is not here and will not be
(SPEC §5): the gate says whether the pipeline may merge; the pipeline still does
the merging.

The gate write routes are loopback-only and require
`content-type: application/json`. Neither is authentication, and neither is
pretending to be: the first is because ARF binds `127.0.0.1` by default and
arming merge authority should not follow a widened bind out of the box, and the
second is because a JSON content-type cannot be sent cross-origin without a
preflight, so it stops a page the operator has open from arming the hammer
through their own browser. Put real authentication in front of ARF before
exposing it beyond loopback.

`/healthz` returns 200 even when the review store is absent. Store availability
is reported *in the body*, not as process health: a standalone install with no
pipeline is a healthy ARF with an empty store, and conflating the two would turn
a fresh install into a supervisor restart-loop.

`/github/mirror` does the opposite, deliberately. An empty store is a normal
state; a misconfigured GitHub identity is not, and it must not be
reachable-looking — so a missing, unresolved, or rejected token is a **503 with
the reason**, never a 200 carrying a placeholder-shaped body. `/github/status`
stays 200 either way, because a status route that fails when the thing it
describes is broken is useless exactly when it is needed.

| Failure | Status | `error` |
|---|---|---|
| missing / unresolved / rejected token, or insufficient access | 503 | `github_auth` |
| GitHub rate limit exhausted | 429 | `github_rate_limited` |
| PR does not exist or is not visible | 404 | `github_not_found` |
| bad `repo` / `pr` parameter | 400 | `bad_request` |
| upstream 5xx / network / unparseable body | 502 | `github_error` |

## Store adapter

`server/src/store/review-store.mjs` is the data seam every later ARF ticket reads
through.

```js
const store = openReviewStore(loadConfig());

store.describe();                                   // store status, never throws
store.pullRequests({ state: 'open' });              // { store, pullRequests: [...] }
store.pullRequest({ repo, prNumber });              // { store, pullRequest, rounds, passes, findings }
store.findings({ repo, prNumber });                 // { store, findings: [...] }
```

`pullRequests()` orders by most recent review activity
(`COALESCE(last_attempted_at, reviewed_at) DESC`, then `repo`, then
`pr_number`). PR numbers are repository-local, so ordering the list by number
would interleave unrelated repos into a sequence that means nothing.

Rounds group passes by `attempt_number`; one round can hold several passes (a
review and a rereview). The round's verdict, `findings`, `blockingCount`, and
`nonBlockingCount` all come from the **same** pass — its last one. Earlier
passes in the round are superseded, not additive: summing their findings would
let a round report `comment-only` alongside blocking findings the rereview
already cleared. Superseded findings are not lost — every pass stays reachable
under `rounds[].passes`, and `pullRequest().findings` is still the flat list
across all passes.

`pullRequest()` and `findings()` both refuse to guess when an unqualified PR
number exists in more than one repo: they return an empty projection plus
`ambiguousRepo: true` and `repoMatches`, so a caller can tell an ambiguous PR
apart from one with no findings. Pass `repo` to disambiguate.

Findings are parsed out of `reviewer_passes.body_md`, because `reviews.db` has no
findings table: a review's findings live in the posted markdown under
`## Blocking issues` / `## Non-blocking issues`.

### Honesty rules

These are the properties the tests actually pin, and they are the point of the
adapter:

- **Never crash on an absent or foreign store.** A missing file, a stray non-DB
  file at the path, a database with no review tables, or an older
  adversarial-review schema all produce a valid empty (or field-wise null)
  projection with `store.available` saying so. A blank screen that admits it is
  blank is honest; a 500 is not.
- **A missing column degrades that column, not the page.** Projection SQL is
  built from the columns the store actually has, so an install predating a column
  still lists its PRs with that field null.
- **A synthesized default is never hand-picked.** Where the projection fills a
  missing column in, the value comes from the pipeline schema, not from taste.
  `prState` and `reviewStatus` have a `NOT NULL DEFAULT` to mirror — `'open'`
  and `'posted'`. `reviewer_passes.status` does not: it is `NOT NULL` with no
  default, over the vocabulary `running | completed | failed | cancelled`. So a
  null there means only "this install predates the column", and the pass status
  is reconstructed from the row's own completion markers — `'completed'` when
  `ended_at` or a `verdict` is present, `'running'` otherwise. A flat pending
  default would report every finished historical pass as still in flight.
- **No fabricated fields.** `reviews.db` carries no PR title, builder, risk
  class, or round budget, so the adapter does not emit them *at all* — not even
  as `PR #<n>` placeholders. ARF-02's GitHub mirror is the source for those, and
  a placeholder here would make a missing mirror invisible (SPEC AC#2: the
  dashboard shows real titles/builders, no placeholders).
- **Unknown is not zero.** A pass body that is off-template reports
  `blockingCount: null`, distinct from a reviewer who explicitly wrote `- None.`
  and reports `0`.
- **Both heads, always.** Every PR row carries the PR head, the head the latest
  verdict was cast on, and `verdictOnCurrentHead`, so "is this verdict stale?"
  stays answerable — merging over a stale verdict is exactly what this pipeline
  exists to prevent. A PR with no passes yet has no verdict and therefore no
  verdict head: `verdictHeadSha` and `verdictOnCurrentHead` are both `null`,
  never a `true` synthesized by comparing the PR's head to itself.
- **Merged PRs stay out of the open list.** Local `pr_state` is unreliable in
  both directions, so the open filter checks `merged_at` alongside it.

## Token / identity broker

`server/src/broker/` is the credential seam the standup wizards (ARF-05/06) call.
They ask for a role and get a grant; whether it was minted by ARF or handed over
by an existing broker is not their problem.

```js
import { openTokenBroker, UnmappedRoleError } from './broker/index.mjs';

const broker = openTokenBroker(loadConfig());
const grant = await broker.resolveToken('the-hammer');   // throws if unmapped
await postAsBot(grant.token.use((token) => token));
```

### Fail-loud on a missing mapping

**An unmapped role fails. It never returns an ambient or default identity.**

This is the ticket's headline acceptance property and it exists because of the
2026-07-23 ambient-fallback RCA: a role with no token mapping did not fail, it
fell through to whatever identity the process happened to be carrying. The run
looked successful, the writes were attributed to the wrong actor, and the
misconfiguration stayed invisible.

So the arrangement here is deliberate, and
[`server/test/broker-fail-loud.test.mjs`](server/test/broker-fail-loud.test.mjs)
pins every part of it:

- the mapping lookup is the **first** thing `resolveToken` does — before the
  cache, before the in-flight table, before any network call, in both modes;
- the manifest **refuses wildcard and catch-all role keys** (`*`, `default`,
  anything not matching `[A-Za-z0-9][A-Za-z0-9._-]*`), so there is no entry an
  unrequested role could match;
- a warm cache cannot answer for a role whose mapping was removed;
- nothing reads `GITHUB_TOKEN`, `GH_TOKEN`, `gh auth`, or a keychain — the only
  credential inputs are the secret refs a role entry names;
- in external mode the response's own identity claims are checked against the
  request, so the far broker cannot substitute its default either;
- the bundled minter falls back to a PAT only on a **transient** failure. A
  revoked App key is permanent, and quietly posting as a PAT instead would
  substitute an identity nobody asked for.

The same permanent/transient split is applied to resolving the secret itself, not
just to GitHub. The 1Password CLI runs as a subprocess: if the timeout kills it, a
signal kills it, or the spawn fails with a transient errno (`EIO`, `EAGAIN`,
`EMFILE`, …), then 1Password never answered, so that is transient and the PAT
fallback may cover it. If `op` exits non-zero — the ref is wrong, the vault is not
shared, the session is not signed in — 1Password *did* answer, and the failure
stays permanent: falling back there would hide a configuration error behind a
different identity. A missing `op` binary (`ENOENT`) is permanent for the same
reason.

The error names the role, lists the roles that *are* mapped, and says what to do.

### Bounded retries on the transient side

Classifying a failure as transient only pays for itself if it is then *treated*
as transient. Both legs of a mint — the 1Password subprocess and the HTTP call —
run under the same bounded backoff
([`server/src/broker/retry.mjs`](server/src/broker/retry.mjs)): up to
`transientRetryAttempts` attempts, exponential from `transientRetryDelayMs` and
capped at 2s. Only `broker_transient` is retried; a permanent refusal, an
unmapped role, and a refused ambient identity all escalate on the first attempt.

Two orderings matter here:

- **the retry is inside the PAT fallback.** Falling back changes *which identity
  acts*; retrying re-asks with the same one. The App identity's retries are
  spent first, so a blip a second attempt would have survived does not silently
  move the hammer's writes onto its PAT.
- **the retry is inside the `op` split, not around it.** A reference 1Password
  refused is never re-asked — that would just re-run a settled question — while
  a spawn that was cut short is. The 2026-05-16 launchd outage is the recorded
  case of the second being handled like the first.

Set `transientRetryAttempts` to `1` to turn retries off without a code change.

Separately, in external mode a `401`/`403` from the broker drops ARF's memoized
resolution of `endpointTokenRef` — the credential it authenticates *to* the
broker with, which is otherwise resolved once per process. An operator who
rotates that ref is picked up on the next attempt instead of at the next daemon
restart. The rejection itself still surfaces: retrying it silently would hide a
genuinely revoked credential behind a rotation that never happened.

### Freshness on the grant

A grant carries both `expiresAt` (absolute epoch seconds — the authority) and
`expiresInSeconds`. **`expiresInSeconds` is a live getter, not a value captured
at mint time.** It re-derives from `expiresAt` on every read, including through
`redacted()` and `JSON.stringify`, and floors at `0` past expiry.

That distinction is load-bearing because a grant spends most of its life being
served from the cache. A number frozen at mint would tell the twentieth caller
the token still had its full original lifetime left, so a caller sizing a long
operation against it — or caching the credential on the strength of it — would
be holding a token about to return 401. Callers persisting a deadline should
still store `expiresAt`; `expiresInSeconds` is for display and for "do I have
room for this call right now".

The broker itself does not rely on either field being read correctly: a cached
grant is only served while it is fresh by `refreshLeadSeconds`, and a grant
inside that lead window is re-minted rather than handed out.

### Bounded upstream reads

ARF quotes upstream error bodies into its own errors, so it has to read them —
from the external broker, from whatever proxy sits in front of it, and from the
GitHub API host. Those reads go through `readCappedBody`
([`server/src/broker/http.mjs`](server/src/broker/http.mjs)), which **streams**
the body and stops at `MAX_BODY_BYTES` (64 KiB), cancelling the reader rather
than draining it.

Reading with `response.text()` and truncating afterwards would be too late: the
allocation has already happened. A misconfigured proxy answering with a
multi-megabyte block page, or a deliberately hostile response, would otherwise
turn an upstream problem into an out-of-memory crash of the ARF daemon. The cap
applies to both adapters, and both the unit cases and the two adapter-level
wiring cases assert on *bytes pulled from the stream*, not just on the length of
the string that came back.

### Modes

**`bundled`** — ARF mints GitHub-App installation tokens itself: an RS256 App JWT
over `node:crypto`, then `POST /app/installations/<id>/access_tokens`. Same
two-step exchange as the in-OS broker, no import of it.

**`external`** — ARF asks a broker that already exists:

```
POST <endpoint>/token
  request : {"role": "...", "scope": "...", "provider": "...", "principal": "..."}
  response: {"token": "ghs_…", "expires_at": "2026-08-19T12:00:00Z",
             "role"?: "...", "scope"?: "...", "principal"?: "..."}
```

`access_token` / `expiresAt` are accepted as aliases. A role in external mode
**must** carry a `scope` (or `principal`): that is what names the identity to the
broker, and a request without one cannot be distinguished from a request for the
broker's default credential.

### Config

```json
{
  "broker": {
    "mode": "bundled",
    "roles": {
      "the-hammer": {
        "provider": "github_app",
        "appId": "4197249",
        "installationId": "143886388",
        "privateKeyRef": "op://Cliovault/the-hammer.private-key/private key",
        "patFallbackRef": "op://Cliovault/Hammer GH PAT/credential"
      },
      "argus": { "provider": "github_pat", "tokenRef": "op://Cliovault/Argus GH PAT/credential" }
    }
  }
}
```

| Env | `broker.*` key | Default | Meaning |
|---|---|---|---|
| `ARF_BROKER_MODE` | `mode` | `bundled` | `bundled` or `external` |
| `ARF_BROKER_ENDPOINT` | `endpoint` | — | external broker base URL (required in external mode) |
| `ARF_BROKER_ENDPOINT_TOKEN_REF` | `endpointTokenRef` | — | secret ref for authenticating *to* that broker |
| `ARF_BROKER_GITHUB_API_URL` | `githubApiUrl` | `https://api.github.com` | bundled-mode GitHub API base |
| `ARF_BROKER_ROLES_FILE` | `rolesFile` | — | JSON manifest of roles |
| `ARF_BROKER_REQUEST_TIMEOUT_MS` | `requestTimeoutMs` | `10000` | per-request timeout |
| `ARF_BROKER_REFRESH_LEAD_SECONDS` | `refreshLeadSeconds` | `60` | re-mint this long before expiry |
| `ARF_BROKER_PAT_FALLBACK_TTL_SECONDS` | `patFallbackTtlSeconds` | `60` | TTL given to a PAT grant |
| `ARF_BROKER_TRANSIENT_RETRY_ATTEMPTS` | `transientRetryAttempts` | `3` | attempts per transient failure (`1` = no retry) |
| `ARF_BROKER_TRANSIENT_RETRY_DELAY_MS` | `transientRetryDelayMs` | `200` | first backoff; doubles per retry, capped at 2s |
| — | `roles` | `{}` | the role → identity manifest |

The role *map* has no env form — it is nested, so it lives in the config file or
in the JSON file `rolesFile` points at (a bare map or a `{"roles": {…}}` wrapper).
Inline `roles` override same-named entries from `rolesFile`.

A leading `~/` is expanded to the current user's home in `rolesFile` and in every
other ARF path key (`stateRoot`, `storePath`, `pipelineRoot`, `ARF_CONFIG_FILE`),
by the shared helper in [`server/src/paths.mjs`](server/src/paths.mjs). None of
these values passes through a shell — they come from JSON files and from launchd
plist env vars — so an unexpanded `~` would be treated as an ordinary directory
name. A `~` anywhere other than the leading segment is left alone, since it is a
legal filename character.

A **relative** `rolesFile` is resolved against the directory the config file lives
in, or against `stateRoot` when there is no config file — never against the
process working directory. ARF's shipping shape is a background service, and
launchd starts a LaunchAgent with `cwd=/`: anchoring to cwd would make
`"rolesFile": "roles.json"` beside `~/.arf/config.json` mean `/roles.json` under
the daemon while working fine in a shell run from `~/.arf`. A relative path with
no config directory or state root to anchor it to is refused at load rather than
resolved somewhere arbitrary.

The whole section is validated at **load** time, including unknown keys inside a
role entry. A `privateKeyReff` typo or a `github_app` role with no
`installationId` refuses to boot, rather than failing four steps into a standup
wizard with a GitHub App already created and installed on the repo.

An absent `broker` section is not an absent broker: it is a broker with zero
mapped roles, so every `resolveToken` fails loud instead of inviting a caller to
improvise a credential.

### Secret references only

ARF consumes secret **references**, never secret values (SPEC §7). Three schemes:

| Ref | Resolved by |
|---|---|
| `op://<vault>/<item>/<field>` | the 1Password CLI (`op read`) |
| `file:///absolute/path` | reading the file |
| `env:NAME` | the environment |

A raw secret written where a reference belongs is **refused**, not accepted as an
opaque string — otherwise it would live in the config file and in every
`describe()` response.

A resolved value is a `SecretValue`: it has no property that returns the
material, and it redacts under string coercion, template literals, `JSON`,
`util.inspect`, and error interpolation. `use(fn)` is the single deliberate exit,
and a test asserts exactly which three files call it (signing the JWT, building
the broker `Authorization` header, and classifying a token by issuer prefix).

Text ARF did not author gets scrubbed before it is quoted into an error: an
upstream that echoes a token or an `Authorization` header into its own message
would otherwise have ARF republish it. Audit records carry refs, a token type,
and a truncated SHA-256 fingerprint — never material.

### Freshness

A cached grant is served only while it is still fresh by `refreshLeadSeconds`; a
grant inside that window is re-minted rather than handed out, because a token
with seconds of life left fails at a call site far from the broker. Concurrent
resolves for one role share a single in-flight mint.

## GitHub mirror

`reviews.db` knows a PR's *review state* and nothing about the PR itself. That
is why the operator-console Review space renders `PR #<n>` and `builder = —`: it
has nothing better. The mirror is the something better — a cached read of the
fields the store lacks, which ARF-03 joins onto the store's PR rows.

```js
const client = new GithubReadClient({ config });
const store = new MirrorStore({ path: config.github.mirrorPath, reviewStorePath: config.storePath });
const mirror = new GithubMirror({ config, client, store });

await mirror.get(repo, pr);                    // { mirror, cacheHit, fetched, ... }
await mirror.getMany(refs, { limit });         // bounded batch + a join index
mirror.cached(repo, pr);                       // cache only, never a request
await mirror.describe();                       // token source + cache counters

joinPullRequests(pullRequests, mirrors);       // store rows + `.mirror`
```

It carries PR title, author login, builder, labels, state/draft/merged,
mergeable + `mergeable_state`, head sha, base ref, the check rollup, and the
review bodies.

### Where the token comes from

A **configured** source and nothing else: an env var this config *names*
(`githubTokenEnv`, default `ARF_GITHUB_TOKEN`) or a file it *points at*
(`githubTokenFile`). There is no ambient fallback — not `gh auth token`, not the
keychain, not `clio-airlock`, and not a bare `GITHUB_TOKEN` that happens to be
exported. An operator who wants `GITHUB_TOKEN` sets `githubTokenEnv=GITHUB_TOKEN`,
which is a decision with a record rather than an accident of the calling shell.

That is the direct mitigation for SPEC §6's "no-token-mapping → ambient identity
fallback masks failure" (RCA 2026-07-23). Every ambient fallback is a path where
a broken identity produces plausible output under the *wrong* identity.

The token is read on every request, so rotation takes effect without a restart
and revocation fails loud on the next read. An unresolved `op://` reference is
rejected by name rather than sent as a bearer token — otherwise it 401s and the
operator goes looking at GitHub App permissions instead of at the reference they
forgot to resolve.

That per-request read is **asynchronous** (`readGithubToken` and
`describeTokenSource` both return promises, and `GithubMirror.describe()` is
async because it resolves the token source). A file-backed token read
synchronously would put a blocking disk read on the critical path of every
outbound call: a batch refresh issues `githubMaxConcurrentRefreshes` requests at
a time across a page of PRs, each costing up to `3 * githubMaxPages + 2`
requests, so a single sweep is hundreds of reads. Synchronously, each one stalls
the whole event loop — no new connection accepted, `/healthz` unanswered, and a
liveness probe able to fail while ARF is doing nothing but re-reading a token.
Re-reading per request is the property worth keeping; doing it synchronously was
not.

### Cache policy

| Bound | Knob | What it prevents |
|---|---|---|
| TTL | `githubMirrorTtlMs` (60s) | a dashboard poll becoming a GitHub poll |
| minimum refresh interval | `githubMinRefreshIntervalMs` (10s) | a refresh button (or a `force`-passing render loop) becoming a hammer |
| in-flight de-duplication | — | ten tabs opening at once being ten refreshes |
| refresh budget | `githubRefreshBudget` (25) | a 200-PR list becoming 200 refreshes |
| concurrency cap | `githubMaxConcurrentRefreshes` (3) | a burst that trips secondary rate limits |
| pagination bound | `githubMaxPages` (10) | one PR's collections becoming unbounded API load |

Refs past the budget are served from cache and **reported** as `deferred` with
their refs — a bounded sweep that does not report its bound reads as complete
coverage.

The budget is spent only on refs that actually make a request. Under `force`, a
ref still inside `githubMinRefreshIntervalMs` is served from cache and reported
separately as `throttled`; it does not consume a budget slot, because doing so
would defer a genuinely stale ref in favour of one the refresh floor was going to
refuse anyway. `throttled` and `deferred` stay distinct for the same reason —
"asked for fresh too soon" and "budget ran out" call for different caller
behavior.

One refresh is 5 requests for an ordinary PR. Three of those five — reviews,
check runs, commit statuses — are paginated collections, so a PR that exceeds
`per_page=100` on one of them costs one extra request per extra page. The
per-refresh cost is still bounded (`3 * githubMaxPages + 2`), which is what keeps
the TTL a meaningful bound on API load.

### Pagination, and why the bound raises instead of truncating

GitHub caps `per_page` at 100 and hands the rest back through `Link` headers.
A first-page-only read is therefore a **silent** truncation, and the failure it
produces is specifically bad here: a matrix build routinely crosses 100 check
runs, and a required context that landed on page 2 never reaches
`summarizeChecks`, which — correctly conservative — calls a required context
that never reported `pending`. The rollup then sits `pending` forever on a PR
whose checks are all green. Reviews truncate the same way and worse: GitHub
returns them oldest-first, so the rows that fall off the end are the newest
verdicts.

So the client follows `rel="next"` to the end of each collection, with two
guardrails:

- **The `next` URL must share the configured API origin.** The paginated request
  carries ARF's bearer token, and a response header does not get to choose who
  receives it. An off-origin `Link` is refused, not followed.
- **Exceeding `githubMaxPages` raises**, rather than returning a short list. A
  bound that truncates quietly just relocates the stuck-`pending` bug to a higher
  page number. The error is `github_too_many_pages` — an `ArfGithubError`, which
  is *transient*, so the mirror falls back to the stale cached row with
  `refreshError` set, and the message names the knob to raise.

### Rate limits are transient, not auth failures

GitHub signals three different things with `403`, and only one of them is an auth
failure:

| Signal | How it looks | Class |
|---|---|---|
| primary budget exhausted | `x-ratelimit-remaining: 0` | `ArfGithubRateLimitError` (`scope: 'primary'`) |
| secondary (burst/concurrency) limit | `retry-after` and/or a "secondary rate limit" body message, **primary budget untouched** | `ArfGithubRateLimitError` (`scope: 'secondary'`) |
| genuine permissions failure | neither | `ArfGithubAuthError` |

A `429` is a rate limit unconditionally. The secondary limit is the one worth
naming: it is reachable *by design* here, because `githubMaxConcurrentRefreshes`
sends concurrent reads and that is exactly what trips it. Classifying it as an
auth error would make it fail-loud, and fail-loud on a throttle aborts the batch
refresh and answers the dashboard with a 503 instead of the stale-but-real rows
it already holds. A secondary limit carries `retryAfterMs` and derives its
`resetAt` from `retry-after`, because it does not publish an `x-ratelimit-reset`
and the primary reset would be a misleading answer for it.

The cache is a separate SQLite file (`<stateRoot>/github-mirror.db`) in **both**
modes, never `reviews.db`. In `in-os` mode that is load-bearing: `reviews.db` is
pipeline-owned and single-writer, and ARF's handle on it is read-only forever.
Both `loadConfig` and `openWritableMirror` refuse a config where the two paths
resolve to one file — stated twice so the invariant survives an edit to either.

### The rollup is conservative about green

This repo merged PR #4223 over a repo-guards FAILURE, and #4224/#4233/#4235 with
zero reviews. A rollup that rounds toward "looks fine" is how a dashboard
participates in that, so:

- A **required context that never reported** is `pending`, not absent. A rollup
  computed only over checks that showed up calls a PR green when its required
  workflow never started.
- An **unrecognised conclusion** is `pending`, not success — new GitHub
  vocabulary should degrade toward "don't merge yet".
- `stale` and `cancelled` **block**; `neutral` and `skipped` pass, matching
  branch protection's own behaviour.
- When branch protection is unreadable (403 — the normal case, since a reviewer
  identity is not a repo admin), `requiredKnown` is `false` and **every**
  reported check gates. That is broader than GitHub's gate, and it is labelled
  as such rather than presented as the required-check answer. An entry's
  `required` is then `null`, not `false`: "we could not find out" is a different
  claim from "it is not".

A tolerated status still **releases its response body** (cancelled, not just
dropped). `fetch` holds a connection open until the body is read or cancelled, so
because the 403 above is the normal case, dropping the response would leak one
socket per PR per refresh and end in file-descriptor exhaustion — with the
symptom being ARF refusing new connections rather than anything pointing at the
protection read.

### Honesty rules

- **A missing mirror row is `null`.** Not an object of nulls that renders like
  data. A PR with no mirror row yet is the *only* case where a caller should
  fall back to showing `PR #<n>`.
- **`mergeable: null` stays null.** GitHub answers null while it computes the
  test merge commit; calling that `false` reports a clean PR as conflicted.
- **Age travels with every row.** `ageMs` and `stale` are computed at read time,
  so nothing has to trust that a row is current because it exists.
- **A transient failure over a cached row returns the cached row**, marked
  `stale` with a `refreshError`. That is real data with its age stated — not a
  placeholder. A PR with no cached row propagates the error instead.
- **An auth failure is never softened.** Not into a cached row, not into an
  empty one, and a batch aborts rather than returning half-real rows: with one
  identity, one 401 means the rest would 401 too.
- **A throttle is never mistaken for one.** Fail-loud is reserved for identity
  failures; a rate limit — primary or secondary — degrades to the stale cached
  row. Treating a transient 403 as fatal takes the dashboard down over a backoff.
- **A truncated collection is never reported as complete.** Pagination runs to
  the end; hitting the page bound raises rather than returning a short list.
- **The builder is the worker class**, taken from the agent-os title prefix
  (`[claude-code] …`), with `builderSource: 'title-prefix'`. The GitHub author is
  a bot login, so every agent PR would otherwise read as the same builder. A PR
  with no prefix falls back to the author login and says so.
- **The join refuses to guess.** PR numbers are repository-local, so the key is
  `(repo, pr)`; a bare PR number resolves only when it is unique across the
  mirrored repos. Splicing a stranger's title onto a review timeline is worse
  than the placeholder this ticket removes.
- **GET only.** There is no `post`/`patch`/`delete` in the client and no code
  path that takes a method as a parameter. Merge execution stays pipeline-owned
  (SPEC §5).
## Identity standup wizard (Screen C)

`server/src/standup/` drives a remediator role's GitHub-App lifecycle end to end
and streams it as SSE; `frontend/` is the panel that renders it.

```bash
curl -N -X POST localhost:8787/v1/standup/identity/runs \
  -H 'content-type: application/json' \
  -d '{"role":"the-hammer","appId":"4197249",
       "privateKeyRef":"op://Cliovault/the-hammer.private-key/private key",
       "patFallbackRef":"op://Cliovault/Hammer GH PAT/credential",
       "repos":["laceyenterprises/agent-os"],
       "verifyRepo":"laceyenterprises/agent-os","verifyIssue":5543}'
```

### The five steps

| # | Step | What it does | Replayed on a re-run? |
|---|---|---|---|
| 1 | Create / select GitHub App | App JWT → `GET /app`; captures `app_id` and the slug | yes |
| 2 | Install on repo(s) | `GET /repos/{o}/{r}/installation`; captures `installation_id` | yes |
| 3 | Store private key + PAT fallback | records the secret **references**, proves they resolve | yes |
| 4 | Wire token (role→token map) | writes the mapping, reloads the broker, resolves a token | **never** |
| 5 | Verify: readyz + bot-attributed post | provider readiness, then a real comment whose attribution is read back | **never** |

ARF does **not** create the App. GitHub's manifest-conversion flow returns the
private key as raw PEM in a response body, and ARF never handles raw secret
values (SPEC §7) — so the wizard sends you to the browser form, you store the key
in your vault, and it takes the *reference* from there.

### Statuses, and the "waiting" state

A step reports exactly `pending | running | ok | failed`. There is deliberately no
fifth status for "waiting on a human": a step that needs the App created, the key
stored, or the installation approved fails with `code:
operator_input_required`, `resumable: true`, and a `nextAction` naming the URL and
the parameters to supply. The panel renders that as *waiting* rather than as an
error, and because the run is resumable, "do the thing and re-run" picks up
exactly where it stopped. That is the mockup's `▸ waiting` chip, expressed
without inventing a status the contract does not have.

### Fail-loud on a missing mapping

**A role with no role→token mapping FAILS at the wire step. It never falls back to
an ambient identity.**

This is the acceptance property, and it exists because of the 2026-07-23 RCA
(SPEC §6): a role with no mapping fell through to whatever identity the process
happened to be carrying, so the run looked successful and the writes were
attributed to the wrong actor. The wire step has exactly three branches:

1. the role is already mapped **and the mapping names the identity just stood
   up** → resolve a token against it;
2. the role is unmapped and `broker.rolesFile` gives ARF a manifest → write the
   entry, reload the broker **from disk**, resolve a token;
3. the role is unmapped and there is nowhere to record a mapping → **fail**
   (`token_map_unavailable`).

There is no fourth branch. Nothing reads `GITHUB_TOKEN`, `GH_TOKEN`, `gh auth`, or
a keychain; the only path to a credential is `broker.resolveToken`, whose own
`UnmappedRoleError` is allowed to propagate rather than being caught and worked
around. A mapping that points at a *different* App or installation than the run
captured is refused too (`identity_mismatch`) — repointing it silently would
attribute the role's writes to an identity nobody asked for, by a slower route.

The reload in branch 2 is from disk on purpose: what you are shown succeeding is
then the same thing a restarted ARF would see, rather than an entry patched into a
live object that no next boot would find.

### The verification post is the proof

Step 5 posts a comment and reads back `user.login` / `user.type` from GitHub's
response. ARF cannot tell from its own side whether the credential it holds
carries the identity it asked for — only GitHub's attribution of a real write can
say so. A post attributed to a human account, or to a different bot, fails the run
even though every HTTP call returned 2xx.

A consequence worth knowing: **a grant that came from a role's PAT fallback cannot
pass this step**, because a PAT posts as its owner. That is correct rather than
unfortunate — the fallback keeps the pipeline moving during an outage, but it is
not the App identity, and certifying it as one would be certifying the wrong
thing.

### Resume

Runs are recorded per role at `<stateRoot>/standup/identity/<role>.json`, written
after **every** step so an interrupted run still leaves a resumable prefix. A
re-run replays the completed prefix and executes from the first step it cannot.

Each recorded step carries a fingerprint over the inputs it consumed, and is
replayed only while that fingerprint still matches. Correct a typo'd `appId` and
step 1 re-runs — along with everything after it — rather than showing you a green
tick for an App nobody is standing up any more.

Steps 4 and 5 are never replayed. "This mapping resolves to a token" and "this
identity posts as itself" are claims about the present, and a cached green tick
would be the fail-loud gate quietly turned off. So a re-run of a completed standup
re-proves both, and "resume from the last completed step" means the last
*replayable* one.

A replayed step reports `status: "ok"` with `resumed: true`. Both halves matter:
the status keeps the four-value vocabulary intact, and the flag stops a tick from
over-claiming what this run actually verified. The panel draws the two
differently.

A record that is absent, truncated, or from an older schema means "nothing to
resume from" and produces a clean run — not a crash on a file nobody can be
expected to have kept intact.

### The SSE frames

| Frame | When | Carries |
|---|---|---|
| `run` | once, first | the whole step list with resume already resolved |
| `step` | every transition | `running`, then `ok` or `failed` |
| `complete` | terminal | outputs + the final step list |
| `failed` | terminal | failing step, `code`, `resumable`, `nextAction` |

Exactly one terminal frame is always emitted, including for an unanticipated
error: a stream that just stops is indistinguishable from a dropped connection,
and the panel would spin forever.

Unless there is nobody left to send it to. A client that disconnects mid-run
aborts the standup between steps, and every write after that point is skipped
rather than attempted — including the terminal frame, which now has no reader. The
whole chain ends in one terminal `catch`, because `handleRequest` returns long
before the stream does: a rejection escaping there would be an unhandled rejection,
and an unhandled rejection ends the ARF process. One closed tab must not be able to
take the daemon down for everyone else on it.

A request body over 64 KiB is refused with `400 invalid_params` *while* it is being
read, so a single POST cannot decide how much memory ARF uses. The read is paused
rather than the socket destroyed — destroying it would take the response with it,
and the caller would get a hangup where the explanation should have been.

The wire format lives in
[`frontend/shared/sse-wire.mjs`](frontend/shared/sse-wire.mjs) — the one ARF module
that exists on both sides. The server imports it to frame the stream and the
browser is served it to parse the stream, so the framer and the parser cannot
drift. The panel reads it with `fetch` rather than `EventSource`, because
`EventSource` can only issue a bodyless GET and a standup's parameters — including
secret references — have no business in a query string.

### Secret references, still only references

`privateKeyRef` and `patFallbackRef` go through `parseSecretRef` at the door, so a
raw PEM or `ghp_…` pasted where a reference belongs is a `400` **before a run
exists** — it never reaches a step, a log line, or the run record. The record and
the roles manifest hold references, coordinates, and fingerprints; a test asserts
no secret material reaches either.

### Config note: `broker.rolesFile` may not exist yet

`rolesFile` names the file ARF keeps mappings in, and on a fresh install that file
does not exist until the first identity is stood up — so an **absent** manifest is
an empty manifest, not a boot failure. Nothing is weakened: zero roles is a broker
that fails loud on every `resolveToken`, so a path typo still surfaces with the
path in the message, at first use rather than at boot.
`describe().rolesFileExists` (and the `/roles` route) report which of the two you
are looking at. A manifest that exists but cannot be *read* still refuses to boot,
because there the operator's mappings are present and ARF cannot see them.

A manifest ARF creates gets the `{"roles": {…}}` wrapper, matching the config
file's own section. One that already exists keeps whichever accepted shape it has,
and other roles in it are preserved — a standup for one role must not take the
rest of the fleet's identities down with it.

### Merging a manifest does not take it over

The merge is a write-temp-then-rename, and a rename replaces the file's ownership
and mode as wholesale as its contents. So a manifest ARF **created** is `0600`
— it decides which identity ARF acts as, and a mapping another account can
rewrite is a way to make ARF post as something else — but a manifest that
**already existed** keeps the `uid`, `gid`, and mode it had.

That is not politeness about file attributes. `rolesFile` is read by more than
ARF: the pipeline daemon reads the same manifest, and it may run as another user
or rely on group read. Narrowing the file to ARF-owned `0600` would lock those
readers out at the exact moment a standup reported success, which is a
cross-process outage produced by a write that looked fine.

Ownership ARF cannot preserve is a refusal, not a shrug: the standup fails with
the uid/gid in the message and the manifest is left as it was. Renaming anyway is
the takeover this rule exists to prevent, and doing it silently is what would make
the outage hard to trace back to a standup.

## Pipeline health and governance (Screen B)

`GET /pipeline/health` answers one question — **what can still merge?** — and
`GET /pipeline/panel` draws the answer. Both always return 200: a missing
governance config or a silent daemon *is* the answer this surface exists to
deliver, and a 503 would take the panel dark exactly when an operator is trying
to find out whether merges stopped.

### Three merge paths, not two

The MSM model has two paths. The panel carries three, because three actors can
merge:

| Path | Executor | What arms it |
|---|---|---|
| `hammer` | adversarial-watcher | `enabled` **and** `autonomous_merge_execution_enabled` **and** `hammer_lifetime_ceiling > 0` |
| `daemon-clean` | adversarial-watcher | `enabled` **and** `autonomous_merge_execution_enabled` |
| `python-backstop` | auto-merge-daemon | **no merge-authority key at all** — only its launchd job |

The third row is the point. The Python `auto_merge_daemon` does not read
`autonomous_merge_execution_enabled`, and `enabled: false` does not disable it —
it removes its 30-minute deferral to the AMA closer, so the "off" position of
that switch makes the backstop merge *sooner*. A panel showing only the two MSM
paths would render both disarmed and invite an operator to read that as "the
pipeline is stopped" while merges continued. So the backstop is a first-class
path, its arm state comes from its liveness, and every kill switch reports which
merge-capable paths it does **not** govern.

`strict_mode` and `strict_non_blocking_remediation` are carried as *modifiers*,
in a separate field from the arm requirements. They change what an armed path
may merge; neither arms or disarms anything, and they are two different keys
(`strict_mode` shapes the daemon-clean path, `strict_non_blocking_remediation`
shapes the eligibility predicate) that are routinely confused, so both are shown.

### Armed is not the same question as stopped

Each path carries two states, and collapsing them is the recorded failure mode:

- **`armed`** — tri-state (`true` / `false` / `null`), derived purely from the
  governing config. A path is disarmed the moment *any one* required input
  fails, so neither kill-switch key can outvote the other, and a key ARF could
  not establish is `null`, never `false`.
- **`effective`** — `merging-possible` / `stopped` / `unknown`. A disarming
  config over a *live* executor is `unknown`, not `stopped`: the watcher's
  `process.env` is frozen at boot and the canonical env override outranks every
  YAML file, so a config flip is not a stop until a bounce. On 2026-07-26 two
  config-flag halts plus bounces did not stop live merges.

The asymmetry is deliberate. Claiming `armed` while the pipeline is stopped
strands PRs; claiming `stopped` while it is still merging is how a governance
breach goes unnoticed. So `unknown` always wins over `stopped`, and the
aggregate `stopState` is only `stopped` when **every** path is disarmed *and*
every executor is demonstrably not beating.

The derivation lives in
[`server/src/governance/merge-paths.mjs`](server/src/governance/merge-paths.mjs).
It imports only the key registry — no filesystem, no store, nothing whose size
depends on how many PRs are in flight — so the answer is O(1) and
load-independent, and a test asserts that import list rather than trusting it.

`adoption` is the seam for proving a flip landed: given an executor start time
later than the newest governance-config mtime, *and* an observable environment
layer, a disarming flip over a live daemon becomes a proven `stopped`. Nothing
reports a daemon start time today, so it normally reads `unproven`; ARF-08's
supervisor knows when it started a process and can settle it without this module
changing.

### Where the values come from

ARF reproduces layers 1–4 of the pipeline's own resolution order by reading the
files, lowest precedence first:

```
code defaults → <root>/config.yaml → <root>/config.local.yaml
  → environment (layer 5)
```

Two things about that are load-bearing:

- **A key nobody sets resolves to the *pipeline's* schema default**, taken from
  `config-loader.mjs` — and the two headline defaults are opposites: `enabled`
  defaults to **false**, `autonomous_merge_execution_enabled` to **true**. But if
  *no* layer was readable at all, keys report `known: false` instead, because a
  deploy pointed at a pipeline that is not there does not get to present schema
  defaults as live values.
- **The environment layer is reported as unobservable by default.** ARF is a
  different process from the watcher; reading its own `process.env` would
  describe ARF's environment and label it the daemon's. A plist-pinned
  `AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_AUTONOMOUS_MERGE_EXECUTION_ENABLED`
  is exactly the override that silently wins, so every env-overridable key
  carries an `env-layer-not-observable` caveat until `pipeline.envFile` points at
  a JSON snapshot of the daemon's environment. A test asserts
  `config-source.mjs` contains no `process.env` at all.

The YAML is read by [`server/src/governance/scalar-yaml.mjs`](server/src/governance/scalar-yaml.mjs),
a deliberately incomplete reader: nested mappings of inline scalars, and nothing
else. Sequences, flow collections, block scalars, anchors/aliases/tags, tab
indentation, and multi-document streams all mark the subtree they appear in as
refused and **drop every value under it**, including values read before the
refusing construct. Its contract is that a construct it does not understand can
never produce a *wrong* value for a governance key — only an unknown one. It is
not a general-purpose parser and must not become one; if ARF ever needs to read
a list out of pipeline YAML, that is the moment to reach for a real parser.

### Daemon liveness

Heartbeat-first, because `launchd`-"running" is not liveness. Four states, and
the fourth is the point:

| State | Meaning |
|---|---|
| `up` | a heartbeat newer than `heartbeatStaleMs` |
| `stale` | a heartbeat older than it — the daemon exists but is not ticking |
| `down` | a **configured** source with no heartbeat at all |
| `unknown` | no source configured, or one ARF could not interpret |

Only the watcher writes a daemon-level heartbeat today (the follow-up daemon
heartbeats per *job*, the Python auto-merge daemon writes none), so the other two
default to no source and report `unknown`. For the auto-merge daemon that
distinction is not cosmetic: its liveness **is** its arm state, so rendering an
un-probed daemon as `down` would manufacture a stop that does not exist. Point
`pipeline.heartbeats.autoMerge` at a real source (a file path, or
`{path, field: "mtime"}` for a touch-file) to probe it.

### Review-cycle burndown

The cap is a config value (`review_cycle_cap` / `review_cycle_window_hours`) and
the count is a store value (`review_cycle_counters`); pairing them is the
burndown. Two rules follow from the pipeline's own accounting:

- **Counters are per head, not per PR** — a moved head is owed its own budget, so
  a PR can appear more than once and each row names its head.
- **A lapsed window has already reset.** The pipeline restarts the count at 1
  once the last verdict is older than the window, so a row at `5/5` whose window
  has lapsed is *not* exhausted. Reporting it as exhausted would show an operator
  a wall that is not there.

`used`, `remaining`, and `exhausted` are all null-able: an unreadable cap gives
`remaining: null`, never a number that looks like headroom.

### Arm/disarm is not here

SPEC §5: the UI arms and disarms through the **ARF-08** gate, which is in this
tree now — see "The merge-authority gate" below and
[`server/src/governance/gate-store.mjs`](server/src/governance/gate-store.mjs).
ARF-04 remains a read surface: the panel draws the two buttons from the Screen B
mockup **disabled**, because a live-looking control that does nothing is its own
kind of misreport. Until a later ticket wires those buttons up, arming and
disarming is `arf gate arm|disarm` or the `/v1/governance/gate` write routes.

### One renderer

The panel is server-rendered whole and reloads itself; there is no client-side
re-render. A second renderer in the browser would be a second implementation of
"is this path armed", and two implementations of that question disagree
eventually — which is precisely the class of defect this screen exists to
surface. The same renderer also emits the SPEC §1 text form, which is what the
tests assert against character-for-character.
## Harness standup wizard (Screen C)

The harness half of Screen C stands up a review harness as a product flow:
register the worker/reviewer class and entitlement, provision model auth, verify
the runtime, and wire the bot login into the reviewer allowlist so posted reviews
actually count.

```
POST /api/standup/harness/runs
  {"harness": { …spec… }, "dryRun": false}
```

Five steps are streamed as SSE (`run.start`, `step.start`, `step.ok` /
`step.skipped` / `step.failed`, `run.done`) or returned as one JSON summary when
the client does not ask for an event stream:

| Step | What it does |
|---|---|
| `register-class` | writes class + entitlement + allowed models + bot identity to the harness manifest |
| `provision-model-auth` | broker-OAuth through the ARF-07 seam, or a standalone token reference |
| `verify-runtime` | resolves the harness CLI and runs its version probe |
| `wire-allowlist` | adds the bot login and declared aliases to the reviewer allowlist |
| `verify-allowlist` | re-reads the allowlist file and confirms the entry is there |

`modelAuth.mode` chooses the credential source:

```json
{"mode": "broker-oauth", "brokerRole": "claude-reviewer"}
{"mode": "standalone-token", "tokenRef": "env:ANTHROPIC_API_KEY"}
```

In standalone-token mode the broker is not consulted. In broker-OAuth mode an
unmapped role fails the step and the run; no ambient credential is substituted.

Runtime probing is shell-free and allowlisted: the command must appear in
`standup.runtimeCommandAllowlist`, runtime install is separately gated by
`standup.allowRuntimeInstall`, and the installer is retried only for transient
network/process failures.

### Harness config

```json
{
  "standup": {
    "harnessManifestPath": "harnesses.json",
    "reviewerAllowlistPath": "reviewer-allowlist.json",
    "runtimeCommandAllowlist": ["agy-nightly"],
    "runtimeSearchPath": ["/opt/homebrew/bin"],
    "allowRuntimeInstall": false,
    "runtimeProbeTimeoutMs": 15000
  }
}
```

| Env | `standup.*` key | Default | Meaning |
|---|---|---|---|
| `ARF_STANDUP_HARNESS_MANIFEST_PATH` | `harnessManifestPath` | `<stateRoot>/harnesses.json` | the harness manifest ARF owns |
| `ARF_STANDUP_REVIEWER_ALLOWLIST_PATH` | `reviewerAllowlistPath` | `<stateRoot>/reviewer-allowlist.json` | the reviewer allowlist |
| `ARF_STANDUP_RUNTIME_PROBE_TIMEOUT_MS` | `runtimeProbeTimeoutMs` | `15000` | per-probe timeout |
| `ARF_STANDUP_ALLOW_RUNTIME_INSTALL` | `allowRuntimeInstall` | `false` | operator gate for running an install command |
| — | `runtimeCommandAllowlist` | `claude, codex, gemini, agy, node, python3` | commands ARF may execute; config entries extend the built-ins |
| — | `runtimeSearchPath` | `[]` | directories searched ahead of `PATH` |

The two list keys have no env form on purpose: an allowlist assembled from a
delimiter-split env string is one quoting mistake away from allowing something
nobody chose. Relative paths anchor to the state root, never to the process
working directory — ARF runs as a background service, and launchd gives a
LaunchAgent `cwd=/`.

`runtimeSearchPath` exists because that same minimal daemon `PATH`
(`/usr/bin:/bin:/usr/sbin:/sbin`) makes a Homebrew-installed harness CLI
invisible to ARF while an operator can run it by hand. The probe reports the
absolute path it resolved, so "the runtime is broken" and "the daemon cannot see
it" stay distinguishable.

The **install command is resolved the same way**, against `runtimeSearchPath`
first and `PATH` second, and is spawned by the absolute path that search
returned. An installer is exactly as likely to live outside the daemon's `PATH`
as the runtime it installs — a Homebrew `npm` or `brew` is the ordinary case —
so passing the configured bare name straight to `execFile` would fail with
`ENOENT` and take `allowRuntimeInstall` with it for anything a third-party
package manager owns. An installer that cannot be found fails the step as
`runtime_installer_not_found`, naming the installer and pointing at
`standup.runtimeSearchPath`, rather than surfacing a bare spawn error.

When the probe or the install command *fails*, the step message carries **every
non-empty line** the subprocess printed, not just its first. A failing tool puts
the header on line one and the reason underneath — `npm ERR! code E404` above the
package it could not find, an auth error above the `claude login` that fixes it —
so keeping only line one keeps the least useful line. stderr is preferred and
stdout is read when stderr is silent, because an installer script that reports on
stdout and exits non-zero would otherwise collapse to a bare "Command failed". A
runtime killed for hanging still reports what it managed to say first, which is
what separates "unresponsive" from a fixable auth prompt. The whole block is
bounded at 4000 characters and says so when the bound bites (`[output truncated
at 4000 of N characters]`) — a cap that silently dropped the tail would read as
complete output that simply never explained itself. The successful version banner
is still taken as a single line: that is the whole answer there, and it is what
the `minVersion` check parses.

### State files

Both are ARF's own (SPEC §5: standalone, ARF owns an equivalent manifest;
`modules/worker-pool/worker-classes.json` is the reference model, never an
import). They are written atomically — temp file, fsync, rename — under an
in-process queue *and* an `O_EXCL` lock file, because adding an allowlist entry
is a read-modify-write and the entry a lost race drops is the one whose absence
is invisible. A corrupt file is refused rather than replaced by an empty one, and
a file owned by another uid is refused before it is opened. A stale/dead lock
does not trigger automatic pathname takeover; ARF fails loudly and leaves the
lock in place for inspection so two stale-lock waiters cannot delete a fresh
replacement lock.

## Standalone packaging and the process manager

`frontend/supervisor` is ARF's own process manager, and `arf` is its CLI. It is
deliberately not trying to be launchd: no sockets, no calendar intervals, no
system boot. It does the one thing a standalone app needs, which is keeping its
own processes alive.

```
arf up                                    run the supervisor in the foreground
arf status [--json]                       what it is running
arf gate init|status|arm|disarm|check|audit
```

Running in the foreground is the design. A standalone app that daemonizes itself
has to reimplement pidfile handling, log rotation, and reparenting — and every
environment that would want it (launchd, systemd, Docker, tmux, a terminal)
supervises a foreground process better than it can supervise itself.

### What it supervises

| role | what |
|---|---|
| `arf-server` | Built in. The ARF API, which also serves the SPA. |
| `frontend` | A separately-hosted frontend, if a deployment has one. |
| `pipeline` | An adversarial-review daemon. **Standalone mode only.** |
| `aux` | Anything else an operator wants kept alive beside ARF. |

The frontend is not a second process by default, and that is honest rather than
a gap: ARF's SPA is plain HTML, CSS, and ES modules with no build step, served
in-process by the ARF server, so supervising the server *is* supervising the
frontend. Inventing a second process to make the org chart look right would add
something that can fail without adding anything that works.

`pipeline` programs are refused outside `mode: standalone`, with the program
named. In `in-os` mode launchd already owns the watcher and the auto-merge
daemon; a second supervisor starting its own copies would put two watchers on the
same review claims and the same merge lease.

Children are launched with `process.execPath` — never the string `node` — so a
standalone install works on a machine with no `node` on PATH.

Example `~/.arf/config.json` for a standalone deployment that also runs the
pipeline:

```json
{
  "mode": "standalone",
  "supervisor": {
    "programs": [
      { "id": "watcher", "role": "pipeline", "command": "/usr/local/bin/node",
        "args": ["/opt/adversarial-review/src/watcher.mjs"] },
      { "id": "auto-merge", "role": "pipeline", "command": "/usr/bin/python3",
        "args": ["/opt/worker-pool/auto_merge_daemon.py"] }
    ]
  }
}
```

Every child is given `ARF_GATE_FILE`, `ARF_GATE_AUDIT_FILE`, `ARF_STATE_ROOT`,
`ARF_SUPERVISED_BY`, and `ARF_PROGRAM_ID`, so a supervised daemon finds the gate
with nothing else configured.

### Restart policy

A killed child is restarted. A child that *keeps* dying immediately is a
different situation — a bad command, a bound port, a config error at import
time — so consecutive fast failures back off exponentially
(`initialDelayMs` → `maxDelayMs`) and then stop, with the program marked
`failed` and its last exit recorded. Restarting forever pins a core and buries
the one useful error under thousands of identical ones.

"Fast" is what makes the cutoff safe: a child that stayed up longer than
`healthyAfterMs` has its backoff and its failure count reset, so a process that
crashes once an hour is restarted promptly every time rather than eventually
being treated as a crash loop.

Shutdown sends SIGTERM to every child and escalates to SIGKILL after
`shutdownTimeoutMs`. The escalation is not optional: a child ignoring SIGTERM
would leave the supervisor hanging, an operator would `kill -9` the supervisor,
and that would orphan exactly the processes it exists to manage.

### The status file

`<runDir>/supervisor.json` records, per child, its pid, state, restart count,
and **the time it started**. That last field is not telemetry. ARF-04's Screen B
has to answer "has this daemon restarted since the governance config changed",
and the reason it normally cannot is that nothing knows when the daemon started.
A supervisor does. Under standalone ARF, that file settles it.

`<runDir>/supervisor.pid` is an instance lock: two supervisors over one state
root would each start their own ARF server on the same port (one of them
crash-looping, burying the reason) and their own pipeline daemons. A pidfile
whose process is gone is taken over; one whose process is alive is a refusal
naming the pid.

## Governance: the load-independent arm/disarm gate

Full detail — the contract, the decision codes, and how a merge path honours it —
is in [`gate/README.md`](gate/README.md). The short version:

ARF writes one small JSON document. The merge paths read it **at each merge
decision** rather than at boot, so a flip takes effect in an already-running
daemon with no `launchctl bootout`/`bootstrap` and no config edit. It represents
all three merge-capable actors — `hammer`, `daemon-clean`, and the Python
`python-backstop` — independently, plus a master scope that is the emergency
stop.

```bash
arf gate init   --actor "$USER" --reason "install"
arf gate disarm --path hammer --actor "$USER" --reason "PR 5543 rebase storm"
arf gate disarm --all --actor "$USER" --reason "emergency stop"
arf gate check  --path hammer          # 0 armed, 3 disarmed, 4 fail-closed refusal
arf gate audit
```

This is deliberately *not* the config-flag design it sits beside. That one needs
an edit plus a bounce per daemon, and its canonical env override silently
outranks every YAML file — on 2026-07-26 two config-flag halts with bounces did
not stop live merges. ARF-04's Screen B reports that mechanism honestly,
including the fact that a disarming config over a live daemon resolves to
`unknown` rather than `stopped`; this gate is the mechanism where the same
question has an answer.

Properties worth knowing before relying on it:

- **O(1) and load-independent.** One `open`/`fstat`/`read`/`close` of a document
  with one entry per merge path — a fixed three. Nothing in the read touches the
  review store, the network, or the audit trail, and nothing in the document
  grows with PRs in flight. There is a size cap, and exceeding it is a refusal
  rather than a slow allow.
- **No cache, on purpose.** An mtime-keyed cache cannot see two writes inside one
  filesystem timestamp tick and would serve a pre-disarm answer for the life of
  the process — the staleness this replaces, one layer down.
- **Fail closed.** Missing, unreadable, oversized, malformed, not valid UTF-8,
  wrong-version, or no entry for the path: every one refuses. Refusals carry
  `failClosed` so a caller can page on a broken gate without paging on a
  deliberate stop. Both readers decode strictly, so a byte one runtime would
  silently replace cannot make the Node paths merge under a gate the Python
  backstop refuses.
- **Attributed, or not applied.** Every flip requires an actor and a reason and
  appends to `gate-audit.jsonl` with the resulting posture, so one line answers
  "what was in force after this". The audit trail is opened for append *before*
  the gate document is touched: a flip that could not be recorded is refused
  rather than going into force unattributed.
- **Safe to write while it is being read.** Write-temp-then-rename under an
  exclusive lock, with an optional `expectedSeq` so a panel holding a stale read
  cannot clobber a disarm it never saw. The lock is broken only for a holder that
  is provably dead — never for one that is merely slow — and released only by the
  writer that took it, so two flips cannot run their read-modify-write sections
  concurrently and lose one.
- **Cross-uid readable, sidecar-free.** `0644` in a `0755` directory, and a plain
  file rather than SQLite — a WAL-mode read creates `-wal`/`-shm` owned by the
  *reading* process and would lock the writer out of its own file.

Two implementations read this document — Node for the watcher's paths, Python for
the auto-merge backstop — which is the `config-schema.multi-loader-parity` shape.
`server/test/gate-parity.test.mjs` is the parity gate: it deep-diffs the two
contracts and drives both over the same documents, so a constant changed in one
and not the other fails a test rather than showing up as one merge path honouring
a disarm and the other not.

## Layout

```
frontend/
  README.md
  package.json                      the app manifest; `npm test` runs every suite
  frontend/
    package.json                    zero dependencies
    index.html                      identity standup shell (`/`)
    app.css                         identity-panel stylesheet
    standup-panel.mjs               drives the identity SSE endpoint
    harness.html                    harness standup shell (`/ui/`)
    harness-panel.mjs               form -> POST /runs -> SSE step stream
    arf.css                         harness-panel stylesheet
    shared/
      sse-wire.mjs                  the SSE format shared by server/browser
    src/
      screen-b/
        panel.mjs                   Screen B renderer (HTML + the SPEC text form)
    test/
      *.test.mjs
  gate/
    README.md                         how a merge path honours the gate
    gate-contract.mjs                 version, merge paths, decision + exit codes
    gate-client.mjs                   the Node reader (node:fs only)
    arf_gate.py                       the Python reader + CLI (stdlib only)
  supervisor/
    package.json                      zero dependencies
    bin/arf                           the `arf` entrypoint
    src/
      cli.mjs                         up / status / gate ...
      supervisor.mjs                  spawn, restart policy, shutdown, status file
      programs.mjs                    the program set; pipeline-role mode rule
      program-config.mjs              the `supervisor` config section
  server/
    package.json                    zero dependencies
    src/
      main.mjs                      entrypoint
      server.mjs                    node:http routes (health, version, /github/*, /pipeline/*, standup, SPA)
      static.mjs                    frontend serving; traversal + extension guards
      ui.mjs                        static serving for frontend/ under /ui
      version.mjs                   build identity + API contract version
      config.mjs                    env + file config; mode -> readOnly; token source
      paths.mjs                     ~/ expansion + base-anchored resolution
      store/
        review-store.mjs            the adapter: rounds / passes / findings
        mirror-store.mjs            GitHub mirror cache, keyed (repo, pr_number)
        sqlite.mjs                  ownership-aware read-only open, drift tolerance
        schema.mjs                  standalone store DDL
        findings.mjs                findings parser over a pass body
      github/
        client.mjs                  read-only REST client (GET only)
        mirror.mjs                  cache policy, projection, join seam
        checks.mjs                  check normalization + required-check rollup
        token.mjs                   configured token source, no ambient fallback
        errors.mjs                  auth / not-found / rate-limit / other
      governance/
        index.mjs                   the /pipeline/health payload
        keys.mjs                    governance keys + merge-path definitions
        merge-paths.mjs             arm-state + stop-state derivation (pure, O(1))
        config-source.mjs           layered read of the pipeline governance config
        scalar-yaml.mjs             scoped YAML reader; refuses rather than guesses
        liveness.mjs                heartbeat probes for the three daemons
        cycle-cap.mjs               review-cycle cap burndown
        pipeline-config.mjs         the `pipeline` config section
      broker/
        index.mjs                   the seam ARF-05/06 import
        token-broker.mjs            resolveToken(); fail-loud gate, cache, single-flight
        manifest.mjs                broker config + role -> identity manifest
        github-app.mjs              bundled minter: App JWT -> installation token
        external.mjs                external broker client + identity confirmation
        http.mjs                    streamed, byte-capped upstream body reads
        retry.mjs                   bounded backoff over the transient half
        secrets.mjs                 secret refs, SecretValue redaction, scrubbing
        errors.mjs                  error vocabulary
      standup/
        identity-run.mjs            the step-state machine (async generator)
        steps.mjs                   the five steps; alwaysRun on 4 and 5
        github-ops.mjs              GET /app, installation lookup, comment, readyz
        role-mapping.mjs            builds + persists the role -> token entry
        run-store.mjs               durable run records; resume fingerprints
        atomic-file.mjs             the shared write-temp-then-rename scratch path
        params.mjs                  request validation; refuses raw secrets
        errors.mjs                  standup error vocabulary + codes
        harness-wizard.mjs          the five-step harness run + its event stream
        harness-manifest.mjs        spec validation, posting-login derivation
        reviewer-allowlist.mjs      add / find / verify an allowlist entry
        model-auth.mjs              broker-OAuth vs standalone token ref
        runtime-probe.mjs           allowlisted, shell-free runtime verification
        state-store.mjs             atomic, locked, ownership-aware JSON state
        catalog.mjs                 harness templates the panel prefills from
        routes.mjs                  the ar-standup harness HTTP surface
        config.mjs                  the `standup` config section
        sse.mjs                     server-sent-events writer
      governance/
        gate-store.mjs              the gate's write side: lock, atomic write, audit
        gate-document.mjs           strict writer-side schema + the panel projection
        gate-api.mjs                `ar-govern` routes; loopback + JSON guards
    test/
      fixtures/
        build-reviews-fixture.mjs   regenerates the fixture DB
        reviews.db                  committed fixture, live pipeline schema
        fake-github.mjs             counting fake GitHub API (PRs 5543 / 5541)
      helpers/
        broker-fixtures.mjs         RSA keypair, fake resolver, recording fetch
        standup-fixtures.mjs        identity + harness standup fixtures
      *.test.mjs
```

The state root ARF owns, after a standalone boot with the gate installed:

```
~/.arf/
  config.json                       optional; unknown keys are a hard error
  review-store.db                   standalone review store (in-os reads reviews.db instead)
  github-mirror.db                  the GitHub mirror cache
  governance/
    gate.json                       the arm/disarm gate — 0644, cross-uid readable
    gate-audit.jsonl                append-only; who flipped what, and why
  run/
    supervisor.json                 per-child pid, state, and start time
    supervisor.pid                  the instance lock
  logs/
    arf-server.log                  one appended log per supervised program
  standup/identity/<role>.json      durable standup run records
```

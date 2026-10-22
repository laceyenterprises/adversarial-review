# RUNBOOK — gemini-reviewer GitHub App

> Status: **provisioned** (confirmed 2026-06-17). This runbook documents the
> already-created `gemini-reviewer-lacey` GitHub App and the token wiring, and
> gives the rotation procedure. App/account creation is historical context here,
> **not** a pending task — do not re-create the App. To wire/verify the runtime,
> see [Token wiring](#token-wiring) and [Preflight & failure modes](#preflight--failure-modes).

The gemini reviewer is the third adversarial-review reviewer identity, alongside
`claude-reviewer-lacey` and `codex-reviewer-lacey`. It posts adversarial reviews
to GitHub as its own bot identity, using a GitHub App **installation token** with
its own ~15 000/hr REST budget (isolated from the operator PAT and from the other
reviewers).

## Identity & provisioning (historical context — already done)

| Thing | Value |
| --- | --- |
| GitHub account | `gemini-reviewer-lacey` (user id **291672739**) |
| GitHub App | `lacey-gemini-reviewer` |
| App id | **3994139** |
| Installation id | **138773049** |
| App private key (1Password) | `lacey-gemini-reviewer.2026-06-07.private-key` (Cliovault) |
| Reviewer token item (1Password) | `GEMINI_REVIEWER_GH_TOKEN` (Cliovault), field `token` |
| Broker provider | `github-app-gemini-reviewer` |

These were provisioned out-of-band (SPEC §7). The App id / installation id above
are the values the OAuth broker response is pinned to — see the
`OAUTH_BROKER_GEMINI_REVIEWER_EXPECTED_APP_ID` /
`OAUTH_BROKER_GEMINI_REVIEWER_EXPECTED_INSTALLATION_ID` keys in
`launchd/ai.laceyenterprises.adversarial-watcher.airlock.plist`.

## Token wiring

There are two layers, and they use **different names on purpose**:

- **1Password item name:** `GEMINI_REVIEWER_GH_TOKEN` (in vault `Cliovault`).
- **Runtime env var the code reads:** `GH_GEMINI_REVIEWER_TOKEN` — and *only* this
  one. It is the `botTokenEnv` registered for the `gemini-reviewer` role in
  `src/reviewer-broker-refresh.mjs` (`BROKER_REVIEWER_ROLES`).

The 1Password item is mapped onto the canonical runtime var in the watcher
secret-ref file `config/watcher-op.env`:

```
GH_GEMINI_REVIEWER_TOKEN=op://Cliovault/GEMINI_REVIEWER_GH_TOKEN/token
```

> **Never export `GEMINI_REVIEWER_GH_TOKEN` (the item name) into the runtime
> process.** Only the resolved value, under the canonical `GH_GEMINI_REVIEWER_TOKEN`
> name, may be present. The launcher and the node preflight both fail closed if a
> stray `GEMINI_REVIEWER_GH_TOKEN` env var is detected (see below).

### Broker activation (default path)

In production the token is **not** read from 1Password at all on the hot path —
it is fetched from the local OAuth broker as a short-lived App installation token,
refreshed under the ~1h expiry by `refreshReviewerBrokerTokens()`. Activation is
the per-role flag:

```
GEMINI_REVIEWER_AUTH_VIA_BROKER=true
```

set in the launchd plists
(`launchd/ai.laceyenterprises.adversarial-watcher.airlock.plist`,
`launchd/ai.laceyenterprises.adversarial-follow-up.airlock.plist`) exactly as the
claude/codex flags are. When the flag is `true`,
`scripts/adversarial-watcher-start.sh` calls
`resolve_reviewer_token_via_broker GH_GEMINI_REVIEWER_TOKEN gemini-reviewer`
(fail-closed: a broker failure refuses to fall back to the PAT path). When the
flag is unset/`false`, the launcher falls back to reading the
`GH_GEMINI_REVIEWER_TOKEN=op://Cliovault/GEMINI_REVIEWER_GH_TOKEN/token` mapping
via 1Password.

### Required PR-context reads (LAC-2082)

The source owner is `src/reviewer-context-auth.mjs::fetchPRContext`, called before model
execution with the dispatch's selected `botTokenEnv`. The local runtime
(`src/adapters/reviewer-runtime/cli-direct/index.mjs`) snapshots the daemon
environment into a separate reviewer process; its OAuth fallback stripping
preserves the reviewer broker flags, routes, expected App/installation IDs and
shared-secret **file path**. A later daemon refresh does not update that child.
`github-api.mjs` first tries the optional adapter and then the required
GraphQL context reader. The GraphQL executor does not use `gh-cli.mjs`'s
watcher-auth refresh hook.

The required read pins both `GH_TOKEN` and `GITHUB_TOKEN` to the selected bot
token and refuses a missing selected token before any GitHub read. On a GitHub
authentication rejection (401/expired credential), it may refresh only that
role, and only when its `<ROLE>_AUTH_VIA_BROKER` flag is exactly `true`.
`resolveReviewerAppToken(..., { force: true })` requests
`/token?provider=<selected-provider>&force=1`: bypassing the caller's refresh
clock alone does **not** invalidate the broker's cached token. Provider and
configured App/installation checks still apply. An unchanged token or a
replacement without a known future expiry is refused. A valid replacement is
re-pinned before one retry of the whole context capture, discarding partial
pages. Review posting retains its separate bounded refresh and exact-head
commit attribution; its auth refresh also requests `force=1`.
The canonical reviewer broker route also refuses
`metadata.credential_source=github_pat_fallback`, even when the response carries
matching App/installation IDs. Those IDs do not turn a PAT into a bot token.

If refresh fails or GitHub rejects the replacement, the reviewer exits with
`github-auth-outage`. The existing watcher settlement parks the PR at
`pending-upstream` without charging a review attempt; a naturally scheduled
eligible attempt can recover later. Do not reset budgets or manually retrigger
to prove this fix. A permissions 403, missing PR 404 or provider quota outage
does not authorize this context-token remint. Operator GitHub reads prove
neither the selected bot's credential nor its installation permissions.

After normal source review, merge and deployment, prove recovery using a
**naturally scheduled** review: record repository/PR, scheduled attempt/session,
selected role, successful required-context capture, reviewed head SHA and the
posted GitHub review ID/login/`commit_id`. The review must be under the selected
bot identity and bound to that reviewed head. Source publication, deploy revision
and this live proof are separate evidence. Do not restart active services to
obtain it, and never collect token values, bearer headers or broker response
bodies. See [the incident RCA](RCA-reviewer-pre-context-auth-2026-10-22.md).

If the selected provider cannot mint because its App key was revoked, the App
owner must generate a replacement key in that **same** App, store it via the
existing secret source and follow [Rotation](#rotation). If the installation
was suspended, the organization owner must unsuspend it; if removed, reinstall
the same reviewer App with access to the affected repository and required
permissions, then reconcile any changed installation ID in the broker and its
expected-ID pins through the governed owner deployment. Verify that provider's
mint before awaiting natural recovery. A code retry cannot repair revoked
authority; keep the read closed. Do not substitute an operator PAT, another
reviewer role or the merge-agent App.

## Preflight & failure modes

`scripts/adversarial-watcher-start.sh` and `src/gemini-reviewer-preflight.mjs`
enforce the same two invariants so a misconfiguration is loud, never a silent
mis-post under another reviewer's identity:

1. **Unresolved token.** If a gemini reviewer is selected but
   `GH_GEMINI_REVIEWER_TOKEN` resolves empty, startup/posting fails with:

   ```
   gemini reviewer selected but GH_GEMINI_REVIEWER_TOKEN unresolved — check the op.env mapping for GEMINI_REVIEWER_GH_TOKEN (see docs/RUNBOOK-gemini-reviewer-app.md)
   ```

   Fix: confirm the `config/watcher-op.env` mapping above resolves, that the
   1Password item `GEMINI_REVIEWER_GH_TOKEN` exists in `Cliovault` with a `token`
   field, and (broker path) that the broker provider `github-app-gemini-reviewer`
   is serving tokens.

2. **Legacy env-var conflict.** If `GEMINI_REVIEWER_GH_TOKEN` (the item name) is
   present as a runtime env var, startup/preflight fails before posting. Fix:
   `unset GEMINI_REVIEWER_GH_TOKEN` and rely on the canonical
   `GH_GEMINI_REVIEWER_TOKEN` mapping only.

## Rotation

Rotating the gemini reviewer's GitHub App private key (the broker's signing key):

1. In GitHub → the `lacey-gemini-reviewer` App settings → **Generate a new
   private key**; download the `.pem`.
2. Store it in 1Password (Cliovault) as a new dated item, e.g.
   `lacey-gemini-reviewer.<YYYY-MM-DD>.private-key`, mirroring the existing
   `lacey-gemini-reviewer.2026-06-07.private-key`.
3. Point the OAuth broker's `github-app-gemini-reviewer` provider at the new key
   (broker PEM config) and reload the broker.
4. `launchctl kickstart -k gui/<uid>/ai.laceyenterprises.adversarial-watcher.airlock`
   to bounce the watcher; the next tick re-fetches a fresh installation token.
5. Revoke the old App private key in GitHub once the new one is confirmed serving
   (broker logs show `provider=github-app-gemini-reviewer` tokens minting).

Rotating the **PAT-fallback** token item (`GEMINI_REVIEWER_GH_TOKEN`, used only
when `GEMINI_REVIEWER_AUTH_VIA_BROKER` is unset/`false`): update the value of the
`token` field on the `GEMINI_REVIEWER_GH_TOKEN` item in `Cliovault` and bounce the
watcher. The `config/watcher-op.env` ref does not change.

## Related

- `src/reviewer-broker-refresh.mjs` — `BROKER_REVIEWER_ROLES` / per-tick refresh.
- `scripts/lib/reviewer-broker.sh` — the bash broker fetch contract.
- `src/gemini-reviewer-preflight.mjs` — the node-side preflight guards.
- `config/watcher-op.env` — the 1Password secret-ref mapping.

## Gemini quota routing hold

Provider quota exhaustion is independent of this App's GitHub rate limit.
A runtime-classified Gemini quota failure creates
`data/gemini-quota-cooldown.json` (or directly under
`ADVERSARIAL_REVIEW_STATE_DIR`) and routes reviews through the eligible base
reviewer using that reviewer's bot token. Missing, invalid or past reset times
use a 30-minute window, configurable with positive
`AGENT_OS_GEMINI_QUOTA_COOLDOWN_MS`; all durations are capped at seven days.
After verifying quota has recovered, remove the resolved cooldown file to
resume configured Gemini selection on the next routing read without restart.
See [the runtime recovery procedure](RUNBOOK-antigravity-gemini-reviewer.md#provider-wide-quota-cooldown).

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

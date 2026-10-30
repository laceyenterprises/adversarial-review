# SEV2 — isolated Codex service home dropped effective OAuth

Date: 2026-10-30. Follow-up: [LAC-2131](https://linear.app/laceyenterprises/issue/LAC-2131).
Status: source correction and offline regression coverage; deployed recovery
requires the separate proofs below.

## Impact and evidence

Direct adversarial-review Codex remediators received HTTP 401 with a missing
bearer credential before editing or producing remediation artifacts. The
confirmed incident covered agent-os PRs #9803, #9804, #9807 and #9811 and a
Finch PR #27 remediation. Native HQ Codex workers remained healthy, which localized
the failure to the direct AR launch path rather than fleet OAuth login or
provider availability.

The incident evidence directory is `/private/tmp/os-rescue-20261030-0618`.
The representative failed job is
`laceyenterprises__agent-os-pr-9807-2026-10-30T04-14-33-156Z`.
These are operator-supplied incident references, not test inputs. No real
credentials are read or logged by the offline regression suite.

## Root cause

`prepareServiceCodexHome` replaced the staged credential `CODEX_HOME` with a
new config-only directory to isolate tooling, trust and catalog settings.
Callers retained `CODEX_AUTH_PATH` pointing to the staged OAuth file and
assumed the native CLI would use it. The deployed `/opt/homebrew/bin/codex`
ignores that environment variable for credential discovery: offline dummy auth
external to `CODEX_HOME` reports not logged in; the same dummy auth under
`CODEX_HOME/auth.json` reaches the auth parser and reports ChatGPT login.

The config-only home split entered in CODEXHOMEISO-01, commit `f9c7371b`
([source PR #1621](https://github.com/laceyenterprises/adversarial-review/pull/1621)).
CODEXHOMEISO-02, commit `c59db6b9`
([source PR #1623](https://github.com/laceyenterprises/adversarial-review/pull/1623)),
retained that credential-consumption gap while adding per-home catalog seeding.

The credential source-selection contract and the CLI credential-consumption
contract had been conflated. Tests checked environment forwarding without
crossing the CLI file-store boundary. Reviewer execution, compatibility/MCP
discovery and direct remediation all shared the faulty helper, so repairing
only the failing remediator would leave sibling launches vulnerable.

The sibling audit also found staging cleanup missing on preparation errors,
and corporate startup validation comparing inherited source-home paths with
newly materialized staging paths. The latter rejected a legitimate ownership
handoff. Neither issue requires changing provider selection or role pins.

## Source correction

All native service-home callers now use the reviewed template with
`cli_auth_credentials_store = "file"`. The helper snapshots only ChatGPT
access/ID/account fields into its private `auth.json`, replaces refresh with
the existing non-rotating per-worker sentinel, strips API-key fallback
environment variables and never imports interactive config. Source files are
neither linked, modified nor deleted by service-home cleanup. Broker/per-worker
materialization remains responsible for credential selection and refresh;
corporate staging remains mandatory.
Legacy token-bearing OAuth files without `auth_mode`, accepted by the deployed
CLI in a dummy-only offline probe, are normalized to explicit ChatGPT mode.
Explicit other auth modes remain rejected.

The exact spawn binary must recognize ChatGPT login from the effective isolated
home before catalog retrieval or paid execution. Malformed/missing credentials,
unsupported/rejected status or parser errors fail with the existing OAuth
classification and sanitized output. Local status is a consumption proof,
not a remote validation of expiry or revocation.

Reviewer/probe homes are removed after use. Direct remediation releases its
owned staging after snapshot preflight and deletes only the service credential
on exit, retaining sessions for accounting. An opaque persisted cleanup receipt
allows the same cleanup after daemon restart only for the matching temporary
home of an exited local worker. Legacy/mismatched receipts do nothing.
Preparation/spawn failures remove their service home and owned staging.

## Regression evidence

Dummy-only tests exercise the deployed CLI offline when available, plus a
subprocess fixture implementing its supported config/home/file-store boundary
on every platform. The fixture deliberately ignores external `CODEX_AUTH_PATH`;
removing the effective home credential must fail.

Coverage includes source precedence, private file modes, no interactive-config
copy, no source refresh/writeback, OAuth-only snapshots, sanitized errors,
preflight ordering before catalog/output/spawn, all three service-home callers,
personal and corporate materialization (including the personal kill switch),
failure cleanup and serialized-worker terminal cleanup while retaining sessions.
Catalog failure remains an authenticated fallback; auth failure cannot take it.
The complete offline validation commands are recorded in the source PR.

No config.yaml keys, schemas, CI runners, triggers or merge eligibility rules
change. The existing strict-loader parity, terminal-PR and claim-CAS contracts
remain authoritative.

## Recovery proofs and operational constraints

Recovery is not established by publication or a green offline test:

1. Obtain a settled cross-model review on the current source PR head and merge
   through ordinary CI/merge authority.
2. Observe the parent repository advance its adversarial-review submodule
   pointer to the merged source.
3. Deploy those bytes through the normal operator-owned service rollout.
4. Retain an organic successful authenticated remediation receipt with shell
   execution, publication/re-review handoff, isolated-home config evidence and
   no missing-bearer/tool-host regression.

No deployed service files, active PR branches, queues, leases or reviews DB
are mutated by this source change. Healthy rescue and closer workers must
continue. OAuth re-login, shared-token rotation, API keys, provider routing
changes, hand-pinned roles and admin gatekeeper bypass are not recovery actions
for this regression.

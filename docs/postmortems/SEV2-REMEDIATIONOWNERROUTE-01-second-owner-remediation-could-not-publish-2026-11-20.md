# SEV2 — second-owner remediation could not publish

Date: 2026-11-20. Ticket: REMEDIATIONOWNERROUTE-01. Severity: SEV2. Every
remediation round for repositories under a non-home GitHub owner was blocked.
Status: diagnosis corrected and holds now name their check. The unblock needs
a broker change outside this repository and waits on an operator decision.

## Impact and timeline

Follow-up jobs for PRs in a second owner's repository stayed `pending`. Each
had `ownerAuthHold` with `capability: "contents:write (codex)"` and the reason
"owner publication route unavailable or lacks permission". The same builder
App was already pushing builder commits to that owner's repository. The
operator closed the affected PRs by hand. Names below are synthetic
(`home-org`, `alternate-org`).

## Investigation (Phase 0)

The dispatch blamed a broker mint that did not send the target owner. An
unrouted builder-provider request appeared in broker logs three seconds before
the hold. Phase 0 tested that with a synthetic broker stub and the real
`selectRemediationPushRoute` and `fetchReviewerTokenFromBroker`. It refuted the
claim:

- For an `alternate-org` repository, the mint sends
  `GET /token?provider=github-app-codex-agent&owner=alternate-org`. The client
  pins the echoed owner and `alternate-org:<owner installation>`. This matches
  the builder push path in the worker-pool helper, which also sends `&owner=`.
  So the remediation request is not the unrouted request in the log. That
  request belongs to another caller.
- Given that request, the broker resolves `<provider>@<owner>` and echoes the
  owner. The owner, App id and installation checks therefore pass.
- The check that fails is the permission check. The broker's GitHub App token
  metadata includes `app_id`, `installation_id`, `merge_capability`,
  `permissions_digest`, `repository_selection` and `owner`. It never includes a
  `permissions` map. So `permissions?.contents !== 'write'` fails for every
  live broker token. A bare `catch {}` collapsed this into the generic reason.
  A stub that sends the live response shape now holds with
  `owner publication route: broker reported no token permissions`.

The check arrived with alternate-owner publication (LAC-2248). Its test
fixture returned a `permissions` map that the real broker never sends. That is
why the suite was green while every live attempt held.

## Correction and boundaries

In this repository, each publication stage now raises a hold that names its
check, with no token material. Broker-client rejections carry a fixed `check`
label. The owner routing, installation pin and permission checks are unchanged
and still fail closed. Fixtures now cover the live response shape.

The unblock is to have the broker add GitHub's granted permission map to
installation-token metadata. It already reads that map when it computes
`permissions_digest`. Removing or weakening the client check would make
GitHub's push refusal the only permission gate, so it was not done. That broker
change belongs to the broker's own repository and is the open operator
decision. No live broker, config, service or job state was touched.

## Validation

See the [change note](../changes/REMEDIATIONOWNERROUTE-01.md). Synthetic
fixtures only. No new CI check, gate, ratchet or label.

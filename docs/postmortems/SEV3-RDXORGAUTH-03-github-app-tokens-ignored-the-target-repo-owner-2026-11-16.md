# SEV3: GitHub App tokens ignored the target repository owner

Ticket: RDXORGAUTH-03

Date: 2026-11-16

Status: latent cross-org authentication defect; repair prepared without activation

## Finding

A read-only source probe found GitHub broker requests without an owner, one
installation pin per role, no owner-echo validation and process-wide tokens at
each PR transport. The startup seed had the same home-installation assumption.
Repository discovery covered the configured home org; explicit repository
registration was required before automatic review traffic could reach another
org. The repository's name never determined which installation was needed.

The broker contract accepts a lowercased owner on GitHub App providers, refuses
unconfigured owners and echoes the owner with its installation metadata while
keeping the base provider name. An older broker that ignores the owner would
omit that echo, which must be a refusal rather than an accepted home token.

## Impact

A PR in a second org could never be reviewed, commented on, labeled or merged
using a private repository's required installation authority: every request
carried the home-org token. GitHub would reject the wrong installation's token
with a permission or not-found response. Registration alone could therefore
create a permanently blocked review pipeline. No cross-org activation is part
of this repair.

## Cause

Credential state modeled one installation per role. Octokit, gh, adapter
subprocesses and raw review REST calls knew their request's target but ignored
its owner when choosing authority. Reviewer subprocess refresh and direct
workflow-push escalation inherited the same assumption. A matching provider
name alone could not distinguish a home installation from an owner response.

## Fix

One shared selector reads the home owner once, derives repository owners from
request targets and lazily caches tokens by role and owner with single-flight
mints and expiry skew. Node-minted tokens carry role provenance; inherited
reviewer tokens are recognized by their selected environment variable. Unknown
service credentials cannot acquire cross-org authority. The watcher's pre-poll
Node broker refresh records its service token role before routed requests;
matching an unverified shell startup seed to an ambient token variable does not
authorize owner minting.

Routed broker requests append the owner and require its case-insensitive metadata echo,
the configured App pin and any owner installation pin. PAT fallbacks are
refused. Installation budget bindings require both pins. Owner tokens stay out
of process-wide home environments and refresh clocks. Authentication failures
invalidate the owner cache so existing bounded recovery obtains a fresh token.

All four PR transports select owner authority, including GraphQL repository
variables used by reviewer context reads. GitHub API and posting budget
admission select the same owner credential before waiting. Synchronous gh
calls use the cache only. Managed hammer entitlements remain untouched. Direct
workflow-push mints derive their owner from the job repository. Missing adapter
environment credentials refuse routed broker mode until its upstream contract
supports owners.

Offline tests use synthetic owners, IDs, broker responses and executors. Legacy
transport fixtures use a per-worker configuration without a home org, including
CLI descendants, rather than an inherited `NODE_OPTIONS` routing override;
a separate routed suite supplies synthetic home and other orgs. No live token,
configuration change, restart, registration or merge is part of the repair.

## Follow-ups

- Complete upstream builder, remediation and hammer entitlement owner routing.
- Complete closer policies, per-owner installation pins and adapter broker-mode
  owner arguments and cache identity in the upstream runtime.
- Replace the adapter broker-mode refusal after that upstream support lands.
- Route remediation workspace clone/fetch/push credentials and managed hammer
  sessions through their owning entitlement mechanisms.
- Handle repository registration and merge-authority decisions separately.

The bash startup seed, per-role health probes, model OAuth and bundled minter
retain their existing contracts. Home and unknown-owner traffic remains
unchanged; merge authority remains configured as before.

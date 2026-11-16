# SEV4: Grok reviewer token had consumers but no producer

Ticket: GROKREVIEWTOKEN-01

Date: 2026-11-16

Status: latent defect; repair prepared without activating the lane

## Finding

A read-only source probe searched `src`, `scripts`, and configuration for
`GH_GROK_REVIEWER_TOKEN`, enumerated reviewer broker resolution calls in shell
launchers, and inspected `BROKER_REVIEWER_ROLES`.

The seven token references were consumers or mappings in routing, the Grok
reviewer, review-body capture, reviewer termination handling, spawn settlement,
the shared reviewer, and the watcher. None assigned or exported the token.
The watcher launchers, follow-up launcher, and runtime refresh registry covered
only the Claude, Codex, and Gemini reviewer roles.

## Impact

The defect was latent because the Grok master switch and reviewer lane default
to disabled. Once enabled, Grok reviews could never post: the reviewer correctly
refused missing posting authority before starting. Seeding a token only at boot
would leave a second failure after the installation token's roughly one-hour
lifetime.

## Cause

The Grok reviewer route and credential consumers were added without a matching
broker token producer or runtime refresh role. The missing-authority refusal
was correct; the credential lifecycle was incomplete.

## Fix

A shared CFG-backed predicate requires both lane switches. Every watcher
launcher and the follow-up launcher seed the broker-only Grok token when that
predicate is true. Failure warns, clears inherited authority, and lets startup
continue. Disabled lanes make no broker request.

The runtime registry now includes the Grok role and supported identity aliases.
The existing expiry-driven refresh and metadata checks apply to it. Disabled
lane skips log once per process; per-role error handling keeps other reviewer
refreshes running. Offline fixtures cover lane gating, export, failure
continuation, aliases, and renewal. No activation or live broker request is
part of this repair.

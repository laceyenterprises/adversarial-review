# SEV4: Enabling the Grok reviewer would replace primary routes

Ticket: GROKREVIEWMODE-01. Date: 2026-11-16. Status: latent behavior corrected.

## Probe and impact

Source inspection found that `baseRouteForSubject` replaced the per-tag route
with Grok whenever its lane flags allowed review and no operator pin existed.
The reviewer schema admitted only `enabled`; no selection mode existed.
The AFH candidate list omitted Grok. The adversarial reviewer role resolves to
no pin, so it did not prevent the replacement. Synthetic offline tests reproduce
these conditions without configuration or service reads.

The lane remained disabled. Enabling it would have replaced eligible non-Grok
base routes, before the optional Gemini selection layer, rather than providing
only exhausted-reviewer coverage. No live impact is asserted.

## Cause and correction

GRK-11 supplied a single on/off lane gate without a reviewer selection mode.
The correction adds `off`, `fallback`, and `always-on`. The default `always-on`
preserves existing behavior until configuration explicitly chooses otherwise.
Lane flag defaults remain false. Fallback runs after Gemini for row quota caps;
AFH offers Grok after Gemini and requires known xai grounding. Pins, lane flags,
same-family refusals and per-head exclusions remain authoritative.

The paired OS schema update is required before setting the key. Activation is
separate work; this change performs no service or configuration mutation.

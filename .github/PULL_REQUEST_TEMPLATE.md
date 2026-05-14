<!--
  Thanks for opening a PR!

  Outside contributors: please ignore the [codex] / [claude-code] /
  [clio-agent] title prefix machinery — those are for the maintainer's
  internal worker fleet and the PR title validator only enforces on
  `OWNER`, `MEMBER`, and `COLLABORATOR` associations. Outside
  contributors and first-time contributors are skipped, so just give
  your PR a normal, descriptive title.

  Maintainer worker PRs: use the canonical helper
  `npm run pr:create:tagged -- --tag <codex|claude-code|clio-agent>
  --title "<unprefixed>" -- <gh args...>` so the prefix is applied
  consistently.
-->

## What changed

<!-- A short summary of the change. No marketing. -->

## Why it changed

<!--
  The user-visible problem or contract gap being addressed.
  If this is a new domain, explain why same-model self-review isn't
  enough for the subject type.
-->

## How it was verified

<!--
  Concrete verification:
    - which test files ran
    - any byte-equivalence assertions added
    - relevant demo or walkthrough output
-->

- [ ] `npm test`
- [ ] `npm run typecheck:contracts`
- [ ] `bash demo/research-finding-walkthrough.sh` (if you touched the kernel or any adapter)

## Reviewer notes

<!--
  Anything a reviewer should focus on, or specific tradeoffs you'd like
  pushback on. Be honest about what isn't covered yet.
-->

---

By submitting this contribution you affirm that you have the right to
submit the code under [Apache-2.0](https://github.com/laceyenterprises/adversarial-review/blob/main/LICENSE). No CLA required.

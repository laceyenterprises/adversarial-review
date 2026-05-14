# Known Sharp Edges

This is the honest list of things in this repo that an attentive reader
will notice and that a future maintainer will eventually have to address.
It's published as a first-class file rather than left as silent debt
because:

1. The maintainer would rather hear them from us than discover them in a
   review comment.
2. Naming the rough edges out loud is the only way the next contributor
   can confidently propose a fix without re-litigating the framing.
3. None of these block the documented quick-start or test suite path —
   they're real, but bounded.

If you find something not on this list, [open an issue](https://github.com/laceyenterprises/adversarial-review/issues/new)
or send a PR adding it here. We'd rather grow this file than pretend it
isn't needed.

---

## 1. `src/follow-up-*.mjs` are large legacy modules

`src/follow-up-remediation.mjs` (~111 KB), `src/follow-up-jobs.mjs`
(~61 KB), and `src/watcher.mjs` (~55 KB) are God modules accumulated
across the production lifetime of the GitHub-PR pipeline. They predate
the kernel/adapter split, are tightly coupled to GitHub-PR semantics,
and need a refactor pass to be brought under the same adapter discipline
as the newer code in `src/kernel/` and `src/adapters/`.

**What works today:** they are heavily tested (see the matching
`test/follow-up-*.test.mjs` files, several over 100 KB), and the byte-
equivalence tests on JSONL transcripts and remediation replies catch
behavior drift.

**What needs to happen:** factor `follow-up-remediation.mjs` into a
remediation-loop kernel + a GitHub-PR remediation adapter, mirroring
the review-loop kernel split. Until that lands, treat these files as
"change with care and full test coverage."

## 2. Maintainer-local default paths in production code

Several modules carry default paths from the maintainer's hosted
environment as fallbacks. The current set is documented in
[`DEPLOYMENT.md`](DEPLOYMENT.md), but for honesty's sake the load-bearing
ones are:

- `src/reviewer.mjs` resolves an `ACPX_CLI` default that points at
  `<operator-home>/.openclaw/tools/acpx/node_modules/.bin/acpx`. This is
  only consulted when ACPX is the configured reviewer runtime, which it
  is not by default.
- `src/alert-delivery.mjs` defaults its secret root to
  `<operator-home>/.config/adversarial-review/secrets` and probes a
  legacy `<operator-home>/agent-os/agents/clio/credentials/local` path
  as a compatibility fallback. The whole alert path is optional.
- `src/follow-up-remediation.mjs` defaults reply storage to
  `<operator-home>/agent-os-hq` when `HQ_ROOT` is set, and to
  `<repo>/data/replies` otherwise.
- `src/watcher.mjs` defaults the reviewer subprocess `HOME` to
  `<operator-home>` when no environment override is present.

**What works today:** every one of these has an env-var override and a
local-mode default, and the demo path uses the local-mode defaults. None
of them prevent a fresh clone from running the test suite or the
walkthrough.

**What needs to happen:** the maintainer-local defaults should be moved
out of the source and into a runtime-loaded operator config so the source
tree is portable by default and the operator's environment is supplied
explicitly. Tracked as a refactor pass against `DEPLOYMENT.md` §"Load-
Bearing Runtime Defaults".

## 3. The "any subject" pluggability is real but only one non-PR adapter exists

The README and `docs/ARCH-adversarial-review-adapter-architecture.md`
describe a kernel/adapter split that lets the review loop run over any
"subject," not just GitHub PRs. That split is real — the kernel does not
import any concrete-domain code, and `test/research-finding-end-to-end.test.mjs`
proves a non-PR domain runs end to end against the same contracts.

But the only non-PR domain that exists today is `research-finding`, and
its adapters (`markdown-file`, `slack-thread`, `linear-triage`) are
**fixture stubs**: the Slack adapter writes a local JSONL transcript
instead of calling Slack, and the Linear adapter no-ops without a
Linear API key.

**What works today:** the kernel contracts are stable. A new domain
honestly only needs new adapter files, a domain config, and a prompt
set — not kernel changes.

**What needs to happen:** ship a second non-fixture domain end to end
(probably a real Slack delivery integration) so the pluggability claim
is load-bearing in production, not just in the offline demo.

## 4. SDK dependencies are not on latest

`package.json` currently pins `@anthropic-ai/sdk ^0.39.0` and `openai
^4.98.0`. Both are noticeably older than the current SDK majors. They
work, the tests pass, and the production deployment has been running
against them for months — but a polish pass should bump them and re-run
the suite.

## 5. Two duplicate review-loop entry points

Adversarial-review and the maintainer's separate worker-pool dispatcher
(`hq`, in the Agent OS substrate) overlap on parts of the queue/lease/
launch surface. This is intentional — the
[CLAUDE.md primer in the parent project](https://github.com/laceyenterprises/agent-os)
explains why the two pipelines are kept independent (independent failure
domains, smaller-footprint deployment lane, dev isolation, different
completion shapes). But a reader skimming this repo and the parent
project might assume the overlap is an accident, and it is not.

## 6. Two pre-existing failing tests, marked skipped

The OSS-polish pass added CI that runs `npm test` on every PR. At the
time CI was wired up, two tests in `test/reviewer-final-round.test.mjs`
and `test/spec-touch-prompt-presence.test.mjs` were already failing on
`main` due to drift between reviewer-prompt source files and the test
assertions:

- **`buildReviewerPromptPrefix appends the lenient addendum on the final round`**
  asserts the legacy "base prompt + addendum" concatenation shape of the
  lenient-round reviewer prompt, but `buildReviewerPromptPrefix` was
  refactored to load the dedicated `prompts/code-pr/reviewer.last.md`
  stage file directly. Either the test needs to assert on the stage-`last`
  content, or the implementation needs to restore the concat shape.
- **`reviewer prompt carries the shared spec-touch guidance block verbatim`**
  asserts that `ADVERSARIAL_PROMPT` includes the output of
  `buildSpecTouchPromptSection()` verbatim. The stage prompt no longer
  embeds the shared block verbatim — the spec-touch section is composed
  at runtime instead. Either the stage prompt needs to be regenerated
  to include the block, or the test needs to assert on the runtime
  composition path.

Both fixes are substantive: they change what the reviewer prompt
*actually says*, which is a load-bearing production decision. Rather
than make that decision inside an OSS-polish PR, the tests are marked
`{ skip: '...' }` with clear pointers to this file. The skips show up
in CI output ("ℹ skipped 3") so the debt is visible, not hidden.

**What needs to happen:** decide on the canonical lenient-round prompt
shape (concat vs. dedicated stage file), update either the test or the
prompt to match, and remove the skip annotations. Same for the
spec-touch block: decide whether it's embedded statically or composed
at runtime, fix the test/prompt accordingly, remove the skip.

## 7. Single CI matrix, no provider integration tests

The CI workflow at [`.github/workflows/test.yml`](.github/workflows/test.yml)
runs the kernel + adapter suite and the offline demo on Node 20 and 22.
It does NOT exercise live Anthropic, OpenAI, GitHub, or Linear APIs.

**What works today:** the kernel contracts and adapter fixture paths are
fully tested. The byte-equivalence assertions catch the kinds of drift
that have actually broken production.

**What needs to happen:** an optional, gated CI lane that runs the live-
provider integration paths against test accounts, with secrets supplied
via repository environments. Until that exists, integration regressions
are caught at production rollout time, not in CI.

## 8. `tools/adversarial-review/` is a deploy template

The nested `tools/adversarial-review/` directory in this repo contains
launchd / systemd templates and a `bounce.sh` operator helper. The name
collision with the repo name itself is confusing on first read. It exists
because this code is also vendored as a submodule under the parent
project's `tools/adversarial-review/` path, and the deploy assets were
co-located with the submodule to keep operator surface area in one place.

Outside operators can use the templates as-is or ignore them in favor of
their own supervisor of choice. The name will probably be renamed
(`deploy/templates/` is the obvious target) in a future cleanup.

---

## What this file is NOT

It's not a list of bugs — those go in
[GitHub Issues](https://github.com/laceyenterprises/adversarial-review/issues).

It's not a TODO list — those live in the maintainer's tracker.

It's not an apology. The code here is shipped, working, and exercised in
production. The items above are the honest texture of a system extracted
from a larger operating substrate, and naming them is more useful than
hiding them.

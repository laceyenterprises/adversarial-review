# SEV3 LAC-2221 — SDK runtime closure refused after intervening remediation

Agent OS #11134's HAM published its seven finding dispositions and the
hosted checks settled successfully. Closure stopped at `primary-change-reverted`
because the whole HAM parent patch had changed since the cited review. The
rebased builder patch does match the reviewed patch. The subsequent
ordinary remediation adds three paths and changes three more before HAM.
The available evidence supports the refusal. A collector or evaluator change
would need proof for that intervening state.

## Exact evidence

| Role | Immutable SHA |
| --- | --- |
| Reviewed merge base | `02eddf797e2b90d764a6a5a07b562f6aa3234a7c` |
| Cited review head | `2c6a8daf10fe714a544997fef1189e0c393381d5` |
| Rebasing target | `3d160b97e222c4c23922abbc331f57bb04734627` |
| Rebasing result for the builder | `4563161dd9fab277cf9213f5fde11113a2818175` |
| Ordinary remediation and first HAM parent | `b9f4b1cadf399dd07902df78823fc7715b357d63` |
| HAM publication | `915cba0a3a66fd003d120859f176e2f51f9baf96` |
| Rescue operator's later integration | `30de2e178e832237e65c7464648bb973bf02dbdc` |

GitHub reports the cited head and HAM parent as `diverged`. Comparing each
branch against its own base removes the trunk delta. The original review and
rebased builder then agree on all ten changed paths by path, status and
changed-line multiset. The rebased HAM parent has thirteen changed paths.
Its additional delta is the patch of `b9f4b1cadf39`, tagged `codex-remediation`.
[Diverged comparison](https://github.com/laceyenterprises/agent-os/compare/2c6a8daf10fe714a544997fef1189e0c393381d5...b9f4b1cadf399dd07902df78823fc7715b357d63) · [Reviewed patch](https://github.com/laceyenterprises/agent-os/compare/02eddf797e2b90d764a6a5a07b562f6aa3234a7c...2c6a8daf10fe714a544997fef1189e0c393381d5) · [Rebased builder](https://github.com/laceyenterprises/agent-os/compare/3d160b97e222c4c23922abbc331f57bb04734627...4563161dd9fab277cf9213f5fde11113a2818175) · [HAM parent patch](https://github.com/laceyenterprises/agent-os/compare/3d160b97e222c4c23922abbc331f57bb04734627...b9f4b1cadf399dd07902df78823fc7715b357d63) · [Intervening remediation](https://github.com/laceyenterprises/agent-os/commit/b9f4b1cadf399dd07902df78823fc7715b357d63)

- Three new paths in the PR patch document the SDK receipt:
  `docs/data-model/18-peripheral-service-stores.md`,
  `docs/data-model/catalog.d/domains/peripheral-service-stores.json` and
  `docs/data-model/catalog.json`.
- Three paths already in the reviewed patch gained changes:
  `modules/paddock-host/changes/SDKCOMMITBUILD-01.md`,
  `modules/paddock-host/scripts/install_runtime.py` and
  `modules/paddock-host/tests/test_runtime_install.py`.

Claude review `5971931534` (`PRR_kwDOR6Em7c8AAAABY_Rxjg`) is bound to
`2c6a8daf10fe`. The HAM commit has a linked HAM author and verified
`web-flow` committer. Its two citations are non-blocking findings 2 and 3.
The first refused production region is in
`modules/main-catchup/lib/python/main_catchup/paddock_runtime_hydration.py`,
base lines 27–28. Finding 2 cites lines 25–30 in that file and asks for the
SDK path narrowing the HAM applied. Finding 3 cites the Paddock host README.
The audit reports zero verified authorizations and `reviewed-parent-patch-differs`
for each citation. GitHub check-run reads for `915cba0a3a66` returned five
successes and three skips. [Claude review](https://github.com/laceyenterprises/agent-os/pull/11134#pullrequestreview-5971931534) · [HAM commit](https://github.com/laceyenterprises/agent-os/commit/915cba0a3a66fd003d120859f176e2f51f9baf96) · [Terminal audit](https://github.com/laceyenterprises/agent-os/pull/11134#issuecomment-7005513624)

## Root cause and required evidence

LAC-2134's landed REVERSALPARENT-01 repair maps a rewritten HAM parent to the
actual parent of an independently proven original reversal. The review list
for #11134 contained only the Gemini and Claude reviews of `2c6a8daf10fe`.
Neither pins an earlier authorized HAM reversal on a parent with the
intervening edits. No verified historical authorization for the refused
region surfaced in the available evidence. The App identity and HAM audit
establish who published the edit and what the worker reported. The changed
parent still lacks the required review binding. Using the equivalent
`4563161dd9fa` builder as the parent would omit the actual intervening edits.
[LAC-2134 source repair](https://github.com/laceyenterprises/adversarial-review/pull/1754)

The supported approval is an authoritative review bound to the actual
pre-reversal state in the closure lineage, with a specific File/Lines finding
covering the hydration input region and any other protected region the repair
reverses. For a non-blocking finding, strict remediation must apply. A genuine
HAM repair in that reviewed lineage must carry the corresponding review and
finding citation and prove the removed/restored content. For a subsequent
rewrite, REVERSALREBASE/REVERSALPROV still require equivalent parent evidence
or a qualifying original or durable verified-region proof. The rescue operator
owns arranging that review and publication. An approval label, a green check
rollup or a standalone approval of the already-reversed tip supplies no
authorization for the earlier reversal.

The offline incident projection retains the actual hydration patches and one
data-model edit to reproduce both rejection reasons. A diagnostic control
isolates the hydration path and confirms that finding 2 can authorize it when
the projected parent matches. Finding 3 alone still refuses, and the
non-blocking finding still requires strict policy. The projection supplies no
whole-PR authority. The existing synthetic REVERSALPARENT-01 tests independently
verify the immutable-original path and its identity, patch and ambiguity fences.

## Publication and recovery

- **Source publication.** `915cba0a3a66` was published. The rescue operator
  later integrated main at `30de2e178e83`, whose first parent is the refused
  head. The integration retains the SDK narrowing and the existing HAM
  commit. [Rescue operator record](https://github.com/laceyenterprises/agent-os/pull/11134#issuecomment-7011047954)
- **Merge.** #11134 was open and unmerged at the read of `30de2e178e83`.
  Read and evaluate the current head before any merge. The reproduced gate
  result is bound to `915cba0a3a66`. [Agent OS #11134](https://github.com/laceyenterprises/agent-os/pull/11134)
- **Deployment and runtime loading.** This RCA and regression add no runtime
  change to deploy. SDK deployment and loaded runtime bytes were unverified.
- **Organic closure.** No successful organic closure was observed. The
  conflicting source history and the provenance refusal have separate
  evidence. The rescue integration addresses the former.

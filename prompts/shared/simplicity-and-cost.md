## Optional simplicity advice

Only when warranted, append one final section, `## Simplicity and cost (advisory)`, after Verdict. Reserve it for pure simplicity: fewer lines or reuse of an existing function. Write it ONLY if the change adds a mechanism, layer, flag or wrapper beside an existing one that could be repaired instead, or adds more than about 300 net lines of non-test code without justification in the PR body. Runtime-cost defects do not belong here; report them as findings under the runtime-cost rule.

Name ONE concrete simpler alternative: an existing function or file to reuse, or code to delete. Include a rough estimate of lines saved. Keep the section to about six lines at most. Otherwise omit it entirely, with no boilerplate.

This is optional advice, never a blocking or non-blocking finding. Keep it out of both finding lists and the verdict. It never changes strict-mode gating, round counts or retry caps, and never alone requests remediation, a Hammer or re-review. Existing rounds may apply it when it reduces net lines or runtime cost without changing behavior. After merge, the non-blocking findings batch owns applying or declining it and recording the outcome, including when the advisory is the only review feedback.

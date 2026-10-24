## Optional simplicity and cost advice

Only when warranted, append one final section, `## Simplicity and cost (advisory)`, after Verdict. Write it ONLY if the change adds a mechanism, layer, flag or wrapper beside an existing one that could be repaired instead; adds more than about 300 net lines of non-test code without justification in the PR body; or adds recurring runtime cost (a subprocess, network call or poll per tick or item) where a builtin, cache or event-driven path would do.

Name ONE concrete simpler alternative: an existing function or file to reuse, code to delete, or a cheaper runtime approach. Include a rough estimate of lines saved or cost avoided. Keep the section to about six lines at most. Otherwise omit it entirely, with no boilerplate.

This is optional advice, never a blocking or non-blocking finding. Keep it out of both finding lists and the verdict. It never changes strict-mode gating, round counts or retry caps, and never alone requests remediation, a Hammer or re-review. It may be acted on only within a round already running for other reasons, when it reduces net lines or runtime cost without changing behavior.

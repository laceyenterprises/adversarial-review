## Blocking evidence contract (REVIEWEVIDENCE-01)

Mark a finding blocking only when it cites `path:line` (or a line range) that
resolves on the PR head and states concrete failing behaviour. Use the existing
File and Lines fields; in Problem write `Input or state: <concrete trigger>;
Wrong outcome: <observed or directly demonstrated failure>`. For JSON findings,
put the citation in path and the same behaviour statement in detail.
Quote the relevant code or give a short reproduction when needed to demonstrate
the claim. A possible concern, preference, or unsupported assertion is insufficient.
If either location or behaviour evidence is missing, record it as non-blocking
and explain what evidence is missing. Non-blocking findings cannot escalate the verdict.

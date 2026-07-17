You are performing a FINAL adversarial SECURITY review of a pull request diff. You did NOT write this code.

This is the last review under the current remediation budget. Escalate only real,
exploitable security risk as blocking. Keep every remaining concern visible under
`## Non-blocking issues`.

Security rubric (walk every changed hunk against each category):
- **Injection** — attacker-influenced input reaching an interpreter (SQL/NoSQL, OS command, template, LDAP, XPath, header, log) without parameterization or escaping.
- **Authorization & access control** — missing or bypassable authz, IDOR, privilege escalation, trust-boundary confusion, tenant isolation gaps.
- **Secret handling** — credentials/tokens/keys hardcoded, logged, echoed into errors, or forwarded to a subprocess/child env that should not receive them.
- **Supply chain** — untrusted or unpinned dependencies, install/postinstall scripts, or fetch-and-execute of remote code.
- **Unsafe deserialization** — decoders that instantiate arbitrary types from attacker input.
- **SSRF & outbound requests** — server-side requests to a user-derived URL/host without an allowlist.

Do NOT praise. Be specific, skeptical, and direct.

Output requirements:
- Return valid GitHub-flavored Markdown only
- Do not include any preamble, explanation, code fences, XML, JSON, or text before the first required heading
- Do not include any epilogue or trailing notes after the Verdict section
- Use exactly these top-level section headings, spelled exactly this way, in exactly this order, each appearing exactly once:
  1. ## Summary
  2. ## Blocking issues
  3. ## Non-blocking issues
  4. ## Suggested fixes
  5. ## Verdict
- Under issue sections, render each finding as a nested-bullet card:
  - `- **<Title>**` — bold title naming the vuln class and location (3-8 words, not generic).
  - `  - **File:** \`<path>\``
  - `  - **Lines:** \`<range>\``
  - `  - **Problem:** <one paragraph>`
  - `  - **Why it matters:** <one paragraph>`
  - `  - **Recommended fix:** <one paragraph>`
- Do not put blank lines between top-level finding bullets, or between a finding's title bullet and its nested sub-bullets.
- If a section has no items, write exactly: - None.
- In ## Verdict, end with exactly one of:
  - Request changes
  - Comment only
- Verdict is a pure function of the structured `## Blocking issues` list:
  - Use `Comment only` when `## Blocking issues` is empty / `- None.`
  - Use `Request changes` only when at least one blocking issue is listed
  - Non-blocking issues never escalate the verdict

---

# Final-round verdict threshold (load-bearing)

This is the **final** review on this PR under the current remediation budget. The
lenient threshold below changes the **categorization** bar (what counts as
blocking vs. non-blocking), but it does **not** change the merge gate. On the
final round, `Comment only` is allowed whenever there are no remaining blocking
security issues; non-blocking findings remain visible as advisory comments.

## Categorization (use on the final round)

Only escalate to `## Blocking issues` a finding that is a concrete, exploitable
security vulnerability with a named attack path — from the rubric above:
injection, broken authorization, secret disclosure, malicious/unsafe supply
chain, unsafe deserialization, or SSRF (and the related path-traversal / XSS /
disabled-TLS / weak-crypto classes) — where you can name the untrusted input,
the sink it reaches, and the resulting harm.

Everything else goes under `## Non-blocking issues`, including defense-in-depth
hardening, lower-severity issues gated behind other controls, wording, and
speculative or unproven concerns.

## Verdict policy (pure blocking-list mapping)

- **`Comment only`** — when `## Blocking issues` is empty / `- None.`. Any `## Non-blocking issues` remain visible as advisory findings.
- **`Request changes`** — only when `## Blocking issues` contains at least one item. Non-blocking issues never escalate the verdict.

The lenient threshold exists to keep the final round honest about which issues
are truly exploitable, not to hide remaining advisory concerns.

## When to ship clean (`Comment only`)

Look hard before declaring the blocking list clean — re-walk every rubric
category against the diff. If no exploitable vulnerability remains after a
careful pass, say so plainly, keep any advisory findings under
`## Non-blocking issues`, and emit `Comment only`.

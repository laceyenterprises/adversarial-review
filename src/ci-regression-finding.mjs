import { maskReviewFences } from './kernel/review-markdown.mjs';

export function addCiRegressionFinding(reviewBody, reason) {
  const finding = '- **[ci-regression] Failed external CI**\n  - **File:** Current-head CI check output\n'
    + `  - **Problem:** ${String(reason).replace(/\s+/g, ' ')}\n`
    + '  - **Why it matters:** The current head cannot be reviewed until external CI is green.\n'
    + '  - **Recommended fix:** Repair the failing checks on the current head within the remaining remediation budget.\n';
  let body = String(reviewBody || '').replace(/\r\n/g, '\n');
  // Replace a previous CI card rather than accumulating one per poll/round.
  const prior = [...maskReviewFences(body).matchAll(/^- \*\*\[ci-regression\] Failed external CI\*\*\n(?:[ \t]+[^\n]*\n)*/gm)];
  for (const match of prior.reverse()) body = body.slice(0, match.index) + body.slice(match.index + match[0].length);
  const heading = /^##[ \t]+Blocking[ \t]+Issues?[ \t]*$/im.exec(maskReviewFences(body));
  if (!heading) return `## Blocking issues\n${finding}\n${body}`;
  const at = heading.index + heading[0].length;
  return `${body.slice(0, at)}\n${finding}\n${body.slice(at)}`;
}

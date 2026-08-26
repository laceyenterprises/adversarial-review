const HAM_AUDIT_COMMENT_AUTHOR_LOGINS = new Set([
  'hammer-worker',
  'lacey-hammer-worker',
  'lacey-hammer-reviewer',
  // The hammer now operates under the merge-agent app identity, so its audit /
  // closing comment is authored by the merge-agent bot. Accept it even if the
  // commit-author login resolution lags. (worker-pool: hq_resolve_worker_identity
  // hammer -> merge-agent-lacey.)
  'merge-agent-lacey',
  'lacey-merge-agent[bot]',
  // HQ hammer workers may write PR comments through the owner-lane gh token
  // while the commit itself is authored by merge-agent-lacey.
  'clio-airlock',
  // Dedicated hammer user-token installs resolve to this login when the
  // GitHub App bot token is not available in the worker environment.
  'hammer-lacey',
  // MERGE_AGENT_GH_TOKEN comments from the dedicated hammer app resolve to
  // this GitHub App bot login in PR timelines.
  'the-hammer-lacey[bot]',
  // HSC-01: the SAME GitHub App, without the `[bot]` suffix. REST renders the
  // suffixed form but GraphQL (`gh pr view --json comments`) renders the bare
  // app slug, and the closer reads the rollup through the GraphQL path -- so the
  // suffixed entry alone left `checks.auditCommentAuthor` false on every real
  // hammer audit comment (observed on agent-os#5908). The slug is reserved by
  // the App, so this is the same identity and not a new one.
  'the-hammer-lacey',
]);

function normalizeHamLogin(value) {
  return String(value || '').trim().toLowerCase();
}

// HSC-01: blank lines BETWEEN trailer lines must not truncate the scan. The
// hammer commits its provenance with one `git commit -m` per trailer
// (templates/hammer-prompt.md), and git renders every `-m` as its OWN paragraph
// -- so the live message is `subject\n\nWorker-Class: hammer\n\nWorker-Ticket:
// HAM\n\nReviewed-Head: <sha>\n\n...`. The old scan stopped at the first blank
// line after entering the trailer block, so it only ever recovered the LAST
// trailer and dropped `Worker-Class` / `Reviewed-Head` / `Closed-By`. That made
// `checks.workerClass` false for EVERY hammer terminal-remediation commit, so
// the closer's ground-truth self-certification could never pass its safety core
// and remediated PRs parked on `stale-review-head` forever
// (laceyenterprises/agent-os#5908).
//
// The scan still terminates at the first non-trailer line, so prose can never be
// absorbed, and line 0 (the subject) is never consumed even when it happens to
// look like `Word: text`.
export function parseCommitTrailers(message) {
  const lines = String(message || '').replace(/\r\n/g, '\n').split('\n');
  const trailers = {};
  for (let index = lines.length - 1; index >= 1; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    const match = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.+)$/.exec(line);
    if (!match) break;
    trailers[match[1].trim().toLowerCase()] = match[2].trim();
  }
  return trailers;
}

export function parseRemediatedFindingsTrailer(value) {
  const match = /^\s*(\d+)\s+addressed\s+\((\d+)\s+blocking,\s+(\d+)\s+non-blocking\)\s*$/i
    .exec(String(value || ''));
  if (!match) return null;
  const counts = {
    total: Number(match[1]),
    blocking: Number(match[2]),
    nonBlocking: Number(match[3]),
  };
  if (!Object.values(counts).every(Number.isInteger)) return null;
  if (counts.total !== counts.blocking + counts.nonBlocking) return null;
  return counts;
}

export function hamAuditCommentAuthorMatches(authorOrComment) {
  const rawAuthor = typeof authorOrComment === 'object'
    ? authorOrComment?.author
    : authorOrComment;
  const commentAuthor = normalizeHamLogin(rawAuthor);
  if (!commentAuthor) return false;
  return HAM_AUDIT_COMMENT_AUTHOR_LOGINS.has(commentAuthor);
}

export { HAM_AUDIT_COMMENT_AUTHOR_LOGINS };

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
]);

function normalizeHamLogin(value) {
  return String(value || '').trim().toLowerCase();
}

export function parseCommitTrailers(message) {
  const lines = String(message || '').replace(/\r\n/g, '\n').split('\n');
  const trailers = {};
  let inTrailerBlock = false;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) {
      if (inTrailerBlock) break;
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.+)$/.exec(line);
    if (!match) break;
    inTrailerBlock = true;
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

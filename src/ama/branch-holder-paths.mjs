import { join } from 'node:path';

// Shared canonical holder parsing for provision and in-run checkout recovery.
export function samePrHammerHolderWorktreePaths(errOrText, prNumber, hqRoot) {
  const detail = typeof errOrText === 'string'
    ? errOrText
    : [
      errOrText?.code,
      errOrText?.message,
      errOrText?.stderr,
      errOrText?.stdout,
    ].filter(Boolean).join('\n');
  const text = String(detail || '');
  const paths = [];
  const seen = new Set();
  const pushPath = (candidate) => {
    const path = String(candidate || '').trim();
    if (path && !seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  };
  const workersPrefix = typeof hqRoot === 'string' && hqRoot.trim()
    ? join(hqRoot, 'workers') + '/'
    : null;
  const isCanonicalWorkerWorktreePath = (candidate) => /\/workers\/[^/]+\/[^/]+$/.test(candidate);
  const isReapableHolderPath = (candidate) => {
    if (!candidate) return false;
    if (!isCanonicalWorkerWorktreePath(candidate)) return false;
    if (workersPrefix) return candidate.startsWith(workersPrefix);
    return true;
  };

  // (1) Prior hammer-ama worktrees for THIS pr.
  const normalizedPr = String(prNumber || '').trim();
  if (/^[0-9]+$/.test(normalizedPr)) {
    const escapedPr = normalizedPr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hammerPattern = new RegExp(
      `(['"]?)(/[^'"\n]*?/workers/hammer-ama-pr-${escapedPr}(?:-[^/'"\n]+)?/[^/'"\n]+)\\1`,
      'g',
    );
    for (const match of text.matchAll(hammerPattern)) {
      const candidate = (match[2] ?? '').trim();
      if (text[match.index + match[0].length] !== '/' && isReapableHolderPath(candidate)) {
        pushPath(candidate);
      }
    }
  }

  // (2) The actual branch holder named by git, scoped to the HQ workers dir.
  const holderPatterns = [
    // fatal: '<branch>' is already used by worktree at '<PATH>'
    /already used by worktree at\s+(['"])([^'"\n]+)\1/g,
    /already checked out (?:at|in worktree)\s+(['"])([^'"\n]+)\1/gi,
    // [hq] PR branch '<branch>' is already checked out by another worker worktree (<PATH>).
    /\balready checked out by another worker worktree\s+\((\/[^\n)]+\/[^/\n)]+)\)/gi,
    // ... or inspect holder worktree `<PATH>`.
    /\binspect holder worktree\s+`([^`\n]+\/[^/`\n]+)`/gi,
    // [hq] refusing grace-waived git worktree holder drop for branch '<b>': ...: <PATH>
    /refusing grace-waived git worktree holder drop[^\n]*?:\s*(\/[^\n'"]+\/[^/'"\n]+)/g,
  ];
  for (const pattern of holderPatterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = (match[2] ?? match[1] ?? '').trim();
      if (isReapableHolderPath(candidate)) {
        pushPath(candidate);
      }
    }
  }

  return paths;
}

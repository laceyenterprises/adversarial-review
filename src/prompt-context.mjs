import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function buildMarkdownFence(text) {
  const content = String(text ?? '');
  let width = 3;
  while (content.includes('`'.repeat(width))) {
    width += 1;
  }
  return '`'.repeat(width);
}

function formatFencedBlock(text, language = 'text') {
  const content = String(text ?? '').trim() || '(empty)';
  const fence = buildMarkdownFence(content);
  return `${fence}${language}\n${content}\n${fence}`;
}

export function interpolatePromptTemplate(template, variables = {}) {
  return String(template ?? '').replace(/\$\{([A-Z0-9_]+)\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(variables, key)) {
      return match;
    }
    return String(variables[key]);
  });
}

export function parseGitHubBlobPath(url, expectedRepo) {
  const match = String(url ?? '').match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/[^/]+\/(.+)$/i);
  if (!match) return null;
  const [, repo, relPath] = match;
  if (repo.toLowerCase() !== String(expectedRepo || '').toLowerCase()) return null;
  return relPath;
}

export function extractLinkedRepoDocs(text, repo) {
  const rels = new Set();
  const patterns = [
    /(?:^|\s)(projects\/[A-Za-z0-9._\/-]+\.md|docs\/[A-Za-z0-9._\/-]+\.md|agents\/[A-Za-z0-9._\/-]+\.md|knowledge\/[A-Za-z0-9._\/-]+\.md|modules\/[A-Za-z0-9._\/-]+\.md|tools\/[A-Za-z0-9._\/-]+\.md|SPEC\.md|README\.md)/g,
    /\((\.?\/?(?:projects|docs|agents|knowledge|modules|tools)\/[A-Za-z0-9._\/-]+\.md|\.?\/?SPEC\.md|\.?\/?README\.md)\)/g,
  ];

  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const rel = m[1];
      if (!rel) continue;
      const normalized = rel.replace(/^\.\//, '');
      if (normalized.endsWith('.md')) rels.add(normalized);
    }
  }

  const urlMatches = String(text ?? '').match(/https:\/\/github\.com\/[^\s)]+/g) || [];
  for (const rawUrl of urlMatches) {
    const relPath = parseGitHubBlobPath(rawUrl, repo);
    if (relPath) {
      rels.add(relPath);
    }
  }

  return [...rels].sort();
}

export async function fetchLinkedSpecContents(repo, prNumber, {
  fetchPRContextImpl,
  execFileImpl,
} = {}) {
  if (!fetchPRContextImpl) throw new Error('fetchPRContextImpl is required');
  if (!execFileImpl) throw new Error('execFileImpl is required');

  const pr = await fetchPRContextImpl(repo, prNumber);
  const combinedText = [pr.body || '', ...(pr.comments || []).map((c) => c.body || '')].join('\n\n');
  const linked = extractLinkedRepoDocs(combinedText, repo).slice(0, 12);
  if (!linked.length) return '';

  const sections = await Promise.all(linked.map(async (relPath) => {
    try {
      const { stdout } = await execFileImpl(
        'gh',
        ['api', `repos/${repo}/contents/${relPath}?ref=${pr.headRefOid}`, '--jq', '.content'],
        { maxBuffer: 10 * 1024 * 1024 }
      );
      const decoded = Buffer.from(stdout.replace(/\n/g, ''), 'base64').toString('utf8');
      const trimmed = decoded.length > 12000 ? `${decoded.slice(0, 12000)}\n\n[truncated]` : decoded;
      return `### ${relPath}\n\n\`\`\`md\n${trimmed}\n\`\`\``;
    } catch (err) {
      return `### ${relPath}\n\n[failed to fetch linked spec: ${err.message}]`;
    }
  }));

  return `\n\n---\n\nAdditional linked project context from the PR body/comments (fetch and use these as governing docs when relevant):\n\n${sections.join('\n\n')}`;
}

export function buildObviousDocsGuidance({ repoRootRelative = true, includeSelfContainedHint = true } = {}) {
  const lines = [
    'If the PR/review touches architecture, behavior contracts, operator workflows, or queue/state semantics, inspect the obvious governing docs in the repo before concluding or patching.',
    'Start with likely sources of truth such as README.md, SPEC.md, docs/, module-local runbooks, and prompt files when present.',
  ];

  if (includeSelfContainedHint) {
    lines.push('If the needed spec context is self-contained in the repo, go read it directly rather than guessing from the diff alone.');
  }

  if (repoRootRelative) {
    lines.push('Prefer repo-local docs over external assumptions unless the prompt already supplied stronger governing context.');
  }

  return `\n\n---\n\nGoverning-doc fallback guidance:\n\n- ${lines.join('\n- ')}`;
}

export function collectWorkspaceDocContext(workspaceDir, {
  candidates = ['README.md', 'SPEC.md', 'docs/ARCHITECTURE.md', 'docs/follow-up-runbook.md', 'docs/STATE-MACHINE.md'],
  maxFiles = 5,
  maxCharsPerFile = 12000,
} = {}) {
  const picked = [];

  for (const relPath of candidates) {
    if (picked.length >= maxFiles) break;
    try {
      const abs = join(workspaceDir, relPath);
      const raw = readFileSync(abs, 'utf8');
      const trimmed = raw.length > maxCharsPerFile ? `${raw.slice(0, maxCharsPerFile)}\n\n[truncated]` : raw;
      picked.push(`### ${relPath}\n\n${formatFencedBlock(trimmed, 'md')}`);
    } catch {
      // ignore missing/unreadable docs; fallback guidance still covers this case
    }
  }

  if (!picked.length) return '';
  return `\n\n## Additional Governing Repo Docs\nUse these as governing context when relevant before making architectural judgments or remediation changes.\n\n${picked.join('\n\n')}`;
}

export { buildMarkdownFence, formatFencedBlock };

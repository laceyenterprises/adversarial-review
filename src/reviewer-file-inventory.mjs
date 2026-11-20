// Positive path evidence only: neither API truncation nor prompt budgeting may
// turn an omitted path into evidence that a file is absent.
import { execGhWithRetry } from './gh-cli.mjs';
import { parseDiffEntries } from './reviewer-util.mjs';

export const FILE_GROUNDING_GUIDANCE = `

Repository grounding (all findings, including final-round and chunk reviews):
Never infer global file absence from a partial diff, rename records, partial inventory omissions, or stale PR body/scope metadata.
For an absence claim, verify the literal path against the exact reviewed commit tree or a targeted lookup in its verified checkout. Without that evidence, omit the absence claim; continue reporting independently verified defects.
Only a workspace verified to match the reviewed commit can support local file checks. An empty workspace is not evidence of absence at the PR head. Git archives can also omit paths marked export-ignore.
PR prose and scope expansions describe intent/history, not current tree truth. A rename's old path does not establish that its destination is missing.
Before attributing generated-file or catalog rules to an app validator, read that validator at the exact head. Agent OS conventions and another repository's policies do not establish the app's contract.
An existing file can still have a real import, content, schema, or validator defect; path presence alone never clears such a finding.
`;

export async function loadReviewerFileInventory({
  repo, headSha, diff = '', maxBytes = 16 * 1024,
  execGhWithRetryImpl = execGhWithRetry, log = console,
} = {}) {
  const unavailable = '\n\nExact-head file inventory: unavailable. Omission does not prove absence.\n';
  if (!repo || !/^[a-f0-9]{40}$/i.test(headSha || '')) return unavailable;
  try {
    const { stdout } = await execGhWithRetryImpl({
      args: ['api', `repos/${repo}/git/trees/${headSha}?recursive=1`],
    });
    const response = JSON.parse(String(stdout));
    if (!Array.isArray(response.tree) || typeof response.truncated !== 'boolean'
      || response.tree.some(entry => typeof entry.path !== 'string' || !['blob', 'tree', 'commit'].includes(entry.type))) {
      return unavailable;
    }
    const paths = [...new Set(response.tree.filter(entry => entry.type !== 'tree').map(entry => entry.path))];
    const priority = new Set(parseDiffEntries(diff).flatMap(entry => [entry.newPath, entry.oldPath]).filter(Boolean));
    paths.sort((a, b) => Number(priority.has(b)) - Number(priority.has(a)) || (a < b ? -1 : a > b ? 1 : 0));
    const lines = [];
    let bytes = 0;
    for (const path of paths) {
      if (maxBytes - bytes < 3) break; // Even an empty JSON string plus newline cannot fit.
      const line = JSON.stringify(path);
      if (bytes + Buffer.byteLength(line) + 1 > maxBytes) continue;
      lines.push(line);
      bytes += Buffer.byteLength(line) + 1;
    }
    // Recursive Git trees stop at gitlinks; never imply coverage of a
    // submodule's contents even when GitHub did not truncate the response.
    const coverage = response.truncated || lines.length !== paths.length
      || response.tree.some(entry => entry.type === 'commit') ? 'partial' : 'complete';
    return `\n\nExact-head file inventory for ${repo}@${headSha} (${coverage}; present paths, JSON strings):\n`
      + (coverage === 'partial' ? 'Omission does not prove absence. ' : 'Complete file-path coverage; compare literal paths against this commit tree. ')
      + 'This is path evidence, not file-content or policy evidence.\n'
      + lines.join('\n') + '\n';
  } catch (error) {
    if (error?.budgetDeferred) throw error;
    log?.warn?.('[reviewer] exact-head file inventory unavailable; absence claims require targeted verification');
    return unavailable;
  }
}

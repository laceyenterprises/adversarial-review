/** Live GitHub proof; unknown, truncated, or failed responses never authorize closure. */
export async function verifyNoCiConfigured({ repo, base, head, get }) {
  const branch = await get(`repos/${repo}/branches/${encodeURIComponent(base)}`);
  if (typeof branch?.protected !== 'boolean' || typeof branch?.commit?.sha !== 'string' || !branch.commit.sha) throw new Error('branch state unavailable');
  for (const ref of new Set([branch.commit.sha, head])) {
    if (!ref) throw new Error('head unavailable');
    const tree = await get(`repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    if (tree?.truncated !== false || !Array.isArray(tree.tree)) throw new Error('workflow tree unavailable');
    if (tree.tree.some((entry) => typeof entry?.path !== 'string' || !['blob', 'tree', 'commit'].includes(entry.type))) throw new Error('workflow entries unavailable');
    if (tree.tree.some((entry) => entry.path?.startsWith('.github/workflows/') && entry.type === 'blob')) return null;
  }
  const rules = await get(`repos/${repo}/rules/branches/${encodeURIComponent(base)}`);
  if (!Array.isArray(rules) || rules.some((rule) => !rule?.type)) throw new Error('branch rules unavailable');
  if (rules.some((rule) => rule.type === 'required_status_checks' || rule.type === 'workflows')) return null;
  if (branch.protected) {
    const protection = await get(`repos/${repo}/branches/${encodeURIComponent(base)}/protection`);
    if (!protection || typeof protection !== 'object' || Array.isArray(protection)) throw new Error('protection unavailable');
    if (protection.required_status_checks != null) return null;
    if (typeof protection.url !== 'string') throw new Error('protection state unavailable');
  }
  return { reason: 'no CI configured', repo, base, head, baseHead: branch.commit.sha, checkedAt: new Date().toISOString() };
}

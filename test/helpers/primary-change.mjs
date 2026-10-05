export function primaryChangeFixture(headSha) {
  const file = { filename: 'src/config-loader.mjs', status: 'modified', additions: 1, deletions: 1,
    patch: '@@ -1 +1 @@\n-shadow_only: true\n+shadow_only: false' };
  return { headSha, ciCost: { headSha, ok: true }, hasHammerCommits: true, primaryHead: 'a'.repeat(40), mergeBase: 'b'.repeat(40),
    primaryFiles: [file], finalFiles: [file] };
}

// A complete file listing is bound to the observed PR head before the census uses it.
export async function collectDuplicateContent({ octokit, owner, repo, prNumber, headSha }) {
  const paths = [];
  for (let page = 1; ; page += 1) {
    const { data } = await octokit.rest.pulls.listFiles({ owner, repo, pull_number: prNumber, per_page: 100, page });
    paths.push(...data.map((file) => file.filename));
    if (data.length < 100) break;
    if (page >= 30) throw new Error('duplicate-family file listing truncated');
  }
  const { data: live } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  if (live.head.sha !== headSha) throw new Error('duplicate-family head moved during file listing');
  return { headSha, paths };
}

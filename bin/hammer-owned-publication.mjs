#!/usr/bin/env node
import { hammerNetworkCall, hammerLocalGit } from '../src/ama/hammer-api-network.mjs';
import { hammerPublicationFailureReason } from '../src/ama/hammer-api-publish.mjs';
import { withHammerPublication, settleHammerRebasePublication } from '../src/ama/hammer-publication-ownership.mjs';
import { inspectHammerSource, movedPublicationHead, readHammerSource } from '../src/ama/hammer-source-publication.mjs';
import { hammerTokenSession } from '../src/hammer-token.mjs';

const [repo, prNumber, mode, headSha, ...args] = process.argv.slice(2);
try {
  const result = await withHammerPublication({ repo, prNumber }, async beginMutation => {
    if (mode === 'head' && args.length === 2) {
      const [branch, expectedHead] = args;
      if (!/^[a-f0-9]{40}$/.test(expectedHead)) throw new Error('expected Git source head unavailable');
      const source = await readHammerSource(repo, prNumber);
      const ref = `refs/heads/${source.branch}`;
      if (source.branch !== branch) throw movedPublicationHead('PR branch moved before Git publication');
      const remote = (await hammerNetworkCall('git', ['ls-remote', '--exit-code', 'origin', ref])).toString().trim();
      if (remote !== `${source.previousHead}\t${ref}`) throw movedPublicationHead('Git and PR head reads disagree');
      const { previousHead } = source;
      if (previousHead !== expectedHead && previousHead !== headSha) throw movedPublicationHead('PR head moved before Git publication');
      const kind = await inspectHammerSource({ ...source, localHead: headSha });
      if (kind === 'unchanged') return { route: 'unchanged', head: headSha, previousHead };
      if (source.custody) {
        const live = await readHammerSource(repo, prNumber);
        if (live.previousHead !== expectedHead || live.branch !== branch || live.baseRef !== source.baseRef) {
          throw movedPublicationHead('PR source or base changed before custody publication');
        }
      }
      beginMutation();
      try {
        await hammerNetworkCall('git', ['push', '--porcelain', `--force-with-lease=${ref}:${expectedHead}`, 'origin', `${headSha}:${ref}`]);
      } catch (error) {
        if (/\[rejected\]\s+\(stale info\)/.test(String(error.stdout))) {
          return { route: 'refused', phaseOutcome: 'head-changed', reason: 'Git exact-head lease refused publication' };
        }
        throw error;
      }
      return { route: 'published', head: headSha, previousHead };
    }
    if (mode !== 'rebase' || args.length !== 1 || !/^[a-f0-9]{40}$/.test(headSha || '') || !args[0]) {
      throw new Error('invalid owned publication request');
    }
    if (!hammerTokenSession({ hammerToken: true }).managed) throw new Error('hammer publication credential unavailable');
    beginMutation();
    const result = JSON.parse(await hammerNetworkCall('gh', ['api', 'graphql',
      '-f', 'query=mutation($id: ID!, $head: GitObjectID!) { updatePullRequestBranch(input: {pullRequestId: $id, expectedHeadOid: $head, updateMethod: REBASE}) { pullRequest { headRefOid } } }',
      '-f', `id=${args[0]}`, '-f', `head=${headSha}`]));
    const head = await settleHammerRebasePublication({ result, oldHead: headSha, base: process.env.HAM_PUBLICATION_BASE,
      readHead: async () => JSON.parse(await hammerNetworkCall('gh', ['pr', 'view', prNumber, '--repo', repo,
        '--json', 'headRefOid'])).headRefOid,
      fetchHead: head => hammerNetworkCall('git', ['-c', 'fetch.recurseSubmodules=false', 'fetch', '--no-tags', 'origin', head]),
      git: async args => hammerLocalGit(args).toString() });
    return { head, result };
  });
  process.stdout.write(`${JSON.stringify(result.result ?? result)}\n`);
  if (result.phaseOutcome === 'head-changed') process.exitCode = 20;
} catch (error) {
  const phaseOutcome = error.gitCredentialRefreshFailed ? 'git-credential-refresh-failed' : error.phaseOutcome ?? 'source-publication-refused';
  if (mode === 'head') {
    process.stdout.write(`${JSON.stringify({ route: 'refused', phaseOutcome, reason: hammerPublicationFailureReason(error) })}\n`);
  } else {
    process.stderr.write(`${error.stderr || error.message}\n`);
  }
  process.exitCode = error.gitCredentialRefreshFailed ? 76 : phaseOutcome === 'head-changed' ? 20 : 1;
}

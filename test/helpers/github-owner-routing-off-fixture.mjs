// Legacy transport fixtures use arbitrary owners and ambient credentials. Run
// them in the supported no-org configuration; routing tests set a synthetic
// home owner explicitly and exercise every changed transport with routing on.
import { githubOwnerTokens, createGithubOwnerTokenSelector } from '../../src/github-owner-token.mjs';
Object.assign(githubOwnerTokens, createGithubOwnerTokenSelector({ readHomeOwner: () => null }));
// CLI fixtures are descendants of the isolated worker and need the same no-org
// auth configuration. The URL follows the worker's symlinked repository root.
const preload = `--import=${import.meta.url}`;
if (!String(process.env.NODE_OPTIONS || '').includes(preload)) {
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' ');
}

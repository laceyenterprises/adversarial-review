import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

// Captured immutable GitHub reads, with transport-only projections documented
// beside the fixture. Tests never use gh, a token, a host checkout or a network.
export function migration9692Fixture() {
  const { repo, evidence, responses } = JSON.parse(gunzipSync(readFileSync(
    new URL('../fixtures/migration-renumber-9692/history.json.gz', import.meta.url))));
  const calls = [];
  const blob = text => {
    const bytes = Buffer.from(text);
    const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    responses[`repos/${repo}/git/blobs/${sha}`] = { text };
    return sha;
  };
  const get = async path => {
    calls.push(path);
    const value = responses[path];
    if (!value) throw new Error(`Uncaptured immutable read: ${path}`);
    if (typeof value.text === 'string') {
      const bytes = Buffer.from(value.text);
      return { encoding: 'base64', size: bytes.length, content: bytes.toString('base64') };
    }
    if (value.oversizedTreeEntryCount) return { truncated: value.truncated,
      tree: Array(value.oversizedTreeEntryCount).fill({}) };
    return value;
  };
  get.metadata = async path => {
    const { status, total_commits, merge_base_commit } = await get(path);
    return { status, total_commits, merge_base_commit };
  };
  const text = sha => responses[`repos/${repo}/git/blobs/${sha}`].text;
  const snapshots = evidence.diagnosticCommitRange.map(({ sha }) => ({ sha,
    files: sha === evidence.headSha ? evidence.finalFiles
      : responses[`repos/${repo}/compare/${evidence.baseSha}...${sha}`].files }));
  // Counterfactual tree mutation for boundary tests. Copy the path so a shared
  // immutable base object remains untouched by the simulated snapshot edit.
  const replaceTreeFile = (head, path, sha, previousPath = path) => {
    const parts = path.split('/');
    const copy = (ref, index) => {
      const response = structuredClone(responses[`repos/${repo}/git/trees/${ref}`]);
      const entry = response.tree.find(entry => entry.path === parts[index])
        || (index === parts.length - 1 && response.tree.find(entry => entry.path === previousPath.split('/').at(-1)));
      if (!entry) throw new Error(`Missing fixture path ${path}`);
      entry.sha = index === parts.length - 1 ? sha : copy(entry.sha, index + 1);
      entry.path = parts[index];
      const key = createHash('sha1').update(JSON.stringify(response)).digest('hex');
      responses[`repos/${repo}/git/trees/${key}`] = response;
      return key;
    };
    const root = copy(head, 0);
    responses[`repos/${repo}/git/trees/${head}`] = responses[`repos/${repo}/git/trees/${root}`];
  };
  return { evidence, responses, snapshots, calls, blob, text, replaceTreeFile,
    args: { repo, headSha: evidence.headSha, get } };
}

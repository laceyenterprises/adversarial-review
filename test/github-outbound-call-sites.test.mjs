import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const src = join(dirname(fileURLToPath(import.meta.url)), '../src');
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? files(join(dir, entry.name)) : entry.name.endsWith('.mjs') ? [join(dir, entry.name)] : []);
}
function visit(node, ancestors, callback) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') callback(node, ancestors);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end') continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child.type === 'string') visit(child, [...ancestors, node], callback);
    }
  }
}

// Inventory locks the number of body write sites, not line numbers. A new write
// must join the shared transform and be explicitly accounted for here.
const expected = {
  'duplicate-family-workflow-cli.mjs': 1,
  'argus-security-review-deps.mjs': 1,
  'daemon-clean-merge.mjs': 1,
  'duplicate-family-state.mjs': 1,
  'github-adapter-client.mjs': 3,
  'fast-merge-processing.mjs': 1,
  'ama/dispatch-closer.mjs': 1,
  'ama/hammer-api-publish.mjs': 1,
  'reviewer.mjs': 1,
  'reviewer-exact-head-post.mjs': 2,
  'empty-pr-close.mjs': 1,
  'adapters/subject/github-pr/pr-create-tagged.mjs': 3,
  'review-cycle-cap-actions.mjs': 1,
  'adapters/comms/github-pr-comments/index.mjs': 2,
  'adapters/comms/github-pr-comments/pr-comments.mjs': 1,
};
function inventory(source, name) {
  const writes = [];
  visit(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }), [], (node, ancestors) => {
    let sink = false;
    if (node.type === 'Literal' && (node.value === '--body' || /^body=/.test(String(node.value)))) sink = true;
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
      && ['createComment', 'updateComment', 'createReview', 'updateReview'].includes(node.callee.property.name)
      && !name.startsWith('adapters/operator/')) sink = true;
    if (node.type === 'CallExpression' && node.callee.name === 'writeGitHubAdapter'
      && ['issue-comment', 'pull-request-review'].includes(node.arguments[0]?.value)) sink = true;
    if (node.type === 'Property' && node.key.name === 'body'
      && (name === 'reviewer-exact-head-post.mjs' || name === 'ama/hammer-api-publish.mjs')) sink = true;
    if (!sink) return;
    // Ignore examples/help/comments (comments are absent from the AST).
    if (node.type === 'Literal' && !ancestors.some((parent) => parent.type === 'ArrayExpression' || parent.type === 'CallExpression')) return;
    const scope = ancestors.filter((parent) => /Function/.test(parent.type)).map((parent) => source.slice(parent.start, parent.end)).join('\n');
    writes.push({ filtered: /\bfilterGitHubBody\(/.test(scope), snippet: source.slice(node.start, node.end) });
  });
  return writes;
}
test('every GitHub body write site uses the shared outbound filter', () => {
  const actual = {};
  for (const file of files(src)) {
    const name = file.slice(src.length + 1);
    const source = readFileSync(file, 'utf8');
    const writes = inventory(source, name);
    if (!writes.length) continue;
    actual[name] = writes.length;
    for (const write of writes) assert.equal(write.filtered, true, `${name}: unfiltered GitHub body sink ${write.snippet}`);
  }
  assert.deepEqual(actual, expected, 'new body write site: route through filterGitHubBody and update this ordinary unit-test inventory');
});
test('inventory detects newly added review and inline comment writes', () => {
  for (const code of [
    'async function send(o, body) { await o.rest.pulls.createReview({body, comments: [{body}]}); }',
    'async function send(exec, body) { await exec("gh", ["pr", "comment", "1", "--body", body]); }',
  ]) {
    const writes = inventory(code, 'new-writer.mjs');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].filtered, false);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const src = join(dirname(fileURLToPath(import.meta.url)), '../src');
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? files(join(dir, entry.name)) : /\.[cm]?js$/.test(entry.name) ? [join(dir, entry.name)] : []);
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
  '../bin/dispute-finding.mjs': 1,
  'duplicate-family-workflow-cli.mjs': 1,
  'argus-security-review-deps.mjs': 1,
  'daemon-clean-merge.mjs': 1,
  'duplicate-family-state.mjs': 1,
  'github-adapter-client.mjs': 3,
  'fast-merge-processing.mjs': 1,
  'ama/dispatch-closer.mjs': 1,
  'ama/stacked-base.mjs': 1,
  'ama/hammer-api-publish.mjs': 1,
  'reviewer.mjs': 1,
  'reviewer-exact-head-post.mjs': 2,
  'empty-pr-close.mjs': 1,
  'adapters/subject/github-pr/pr-create-tagged.mjs': 2,
  'review-cycle-cap-actions.mjs': 1,
  'adapters/comms/github-pr-comments/index.mjs': 2,
  'adapters/comms/github-pr-comments/pr-comments.mjs': 1,
};
function inventory(source, name) {
  const writes = [];
  visit(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }), [], (node, ancestors) => {
    let sink = false;
    if (node.type === 'Literal' && (['--body', '--body-file'].includes(node.value) || /^body=/.test(String(node.value)))) sink = true;
    if (node.type === 'TemplateLiteral' && /^body=/.test(node.quasis[0]?.value.raw || '')) sink = true;
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
      && ['createComment', 'updateComment', 'createReview', 'updateReview', 'createReviewComment', 'updateReviewComment', 'createReplyForReviewComment'].includes(node.callee.property.name)
      && !name.startsWith('adapters/operator/')) sink = true;
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
      && ['create', 'update', 'request'].includes(node.callee.property.name)
      && ['pulls', 'issues', 'octokit'].includes(node.callee.object.property?.name || node.callee.object.name)
      && node.arguments.some((arg) => arg.type === 'ObjectExpression' && arg.properties.some((property) => property.key?.name === 'body'))) sink = true;
    if (node.type === 'CallExpression' && node.callee.name === 'writeGitHubAdapter'
      && ['issue-comment', 'pull-request-review'].includes(node.arguments[0]?.value)) sink = true;
    if (node.type === 'Property' && node.key.name === 'body'
      && (name === 'reviewer-exact-head-post.mjs' || name === 'ama/hammer-api-publish.mjs')) sink = true;
    if (node.type === 'Property' && node.key.name === 'body'
      && ancestors.some((parent) => parent.type === 'CallExpression' && parent.callee.object?.name === 'JSON' && parent.callee.property?.name === 'stringify')
      && ancestors.some((parent) => parent.type === 'Property' && parent.key.name === 'input')) sink = true;
    if (!sink) return;
    // Ignore examples/help/comments (comments are absent from the AST).
    if (node.type === 'Literal' && ['--body', '--body-file'].includes(node.value)
      && !['ArrayExpression', 'CallExpression'].includes(ancestors.at(-1)?.type)) return;
    const scopes = ancestors.filter((parent) => /Function/.test(parent.type));
    const scope = scopes.map((parent) => source.slice(parent.start, parent.end)).join('\n');
    // For CLI body arguments, prove that this argument (rather than some
    // unrelated text in the same function) reaches the shared transform.
    let bodyArg = null;
    if (node.type === 'Literal' && ['--body', '--body-file'].includes(node.value)) {
      const parent = ancestors.at(-1);
      const args = parent.type === 'ArrayExpression' ? parent.elements : parent.arguments;
      bodyArg = args?.[args.indexOf(node) + 1];
    }
    function transformed(value, seen = new Set()) {
      if (!value) return false;
      if (value.type === 'CallExpression' && value.callee.name === 'filterGitHubBody') return true;
      if (value.type === 'Identifier' && !seen.has(value.name)) {
        const nextSeen = new Set([...seen, value.name]);
        let found = false;
        for (const functionNode of scopes) visit(functionNode, [], (candidate) => {
          if (candidate.type === 'AssignmentExpression' && candidate.left.name === value.name) found ||= transformed(candidate.right, nextSeen);
          if (candidate.type === 'VariableDeclarator' && candidate.id.name === value.name) found ||= transformed(candidate.init, nextSeen);
        });
        return found;
      }
      return false;
    }
    // An enum of accepted CLI flags is not itself an outbound write.
    if (bodyArg?.type === 'Literal' && String(bodyArg.value).startsWith('-')) return;
    writes.push({ filtered: bodyArg ? transformed(bodyArg) : /\bfilterGitHubBody\(/.test(scope), snippet: source.slice(node.start, node.end) });
  });
  return writes;
}
test('every GitHub body write site uses the shared outbound filter', () => {
  const actual = {};
  for (const file of [...files(src), ...files(join(src, '../bin'))]) {
    const name = file.startsWith(`${src}/`) ? file.slice(src.length + 1) : `../bin/${file.split('/').at(-1)}`;
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
    'async function send(exec, body) { await exec("gh", ["api", "--method", "POST", "repos/acme/widgets/issues/1/comments"], {input: JSON.stringify({body})}); }',
    'async function send(exec, body) { await exec("gh", ["api", "-f", `body=${body}`]); }',
    'async function send(o, body) { await o.rest.pulls.update({body}); }',
    'async function send(o, body) { await o.rest.pulls.createReviewComment({body}); }',
    'async function send(exec, file) { await exec("gh", ["pr", "comment", "--body-file", file]); }',
    'async function send(exec, raw) { const safe = filterGitHubBody(raw); await exec("gh", ["pr", "comment", "1", "--body", raw]); }',
  ]) {
    const writes = inventory(code, 'new-writer.mjs');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].filtered, false);
  }
});

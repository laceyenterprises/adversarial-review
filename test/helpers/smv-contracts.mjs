import { parse } from 'acorn';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export const digest = value => createHash('sha256').update(value).digest('hex');
// Hash only state writers/guards/enums. Unrelated functions and comments may change.
export function stateProjection(source) {
  const clean = node => JSON.parse(JSON.stringify(node, (key, value) => ['start', 'end', 'raw'].includes(key) ? undefined : value));
  const property = node => node?.type === 'Identifier' ? node.name : node?.value;
  const field = node => node?.type === 'MemberExpression' && /^(state|status|owner|review_status)$/.test(property(node.property));
  const rows = [];
  function walk(node, guards = []) {
    if (!node || typeof node !== 'object') return;
    const sql = node.type === 'TemplateLiteral' && node.quasis.some(q => /review_status/.test(q.value.raw))
      || node.type === 'Literal' && typeof node.value === 'string' && /review_status/.test(node.value);
    const write = node.type === 'Property' && /^(state|status|owner|review_status)$/.test(property(node.key))
      || node.type === 'AssignmentExpression' && field(node.left)
      || node.type === 'CallExpression' && node.callee?.name === 'action'
      || node.type === 'VariableDeclarator' && /(?:STATE|STATES|STATUS|STATUSES|PENDING|DISPATCHED|TERMINAL|HANDED_TO_REVIEW)$/.test(node.id?.name || '')
      || node.type === 'CallExpression' && ['has', 'includes'].includes(property(node.callee?.property)) && /state|status/i.test(JSON.stringify(clean(node)))
      || node.type === 'BinaryExpression' && (field(node.left) || field(node.right));
    if (sql || write) rows.push({ node: clean(node), guards: guards.map(clean) });
    for (const [key, value] of Object.entries(node)) {
      if (key === 'start' || key === 'end') continue;
      const nested = ['IfStatement', 'ConditionalExpression', 'SwitchCase'].includes(node.type) && key !== 'test'
        ? [...guards, { branch: key, test: node.test }] : guards;
      if (Array.isArray(value)) for (const child of value) walk(child, nested);
      else if (value && typeof value === 'object') walk(value, nested);
    }
  }
  walk(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }));
  return JSON.stringify(rows);
}
export function checkMap(map, readSource, graphHash) {
  assert.equal(map.version, 1);
  assert.equal(digest(JSON.stringify(map.objects)), graphHash, 'independently reviewed graph changed');
  assert.equal(new Set(map.objects.map(o => o.id)).size, 7);
  for (const object of map.objects) {
    assert.ok(object.owner && object.codeSources.length);
    const states = new Set(object.states.map(s => s.name));
    assert.equal(states.size, object.states.length);
    for (const state of object.states) {
      assert.equal(typeof state.terminal, 'boolean');
      if (!state.terminal) {
        assert.ok(state.exitOwner && state.overdueRecipient && state.maxDurationSeconds > 0);
        assert.ok(['present', 'missing'].includes(state.enforcement));
        if (state.enforcement === 'missing') assert.ok(state.deadEndEvidence);
      }
    }
    assert.equal(new Set(object.transitions.map(e => e.id)).size, object.transitions.length);
    for (const edge of object.transitions) {
      assert.ok((states.has(edge.from) || edge.from === '[*]') && (states.has(edge.to) || edge.to === '[*]'));
      assert.ok(edge.trigger && map.sourceProjectionSha256[edge.codeSource]);
      assert.ok(object.codeSources.includes(edge.codeSource), `missing code source: ${object.id}: ${edge.codeSource}`);
    }
  }
  for (const [file, hash] of Object.entries(map.sourceProjectionSha256)) assert.equal(digest(stateProjection(readSource(file))), hash, `source drift: ${file}; review states AND transitions before refreshing`);
  // An independent producer inventory: persisted SQL writes, not diagram data.
  const row = map.objects.find(o => o.id === 'review-row');
  const writes = [...readSource('src/review-state-statements.mjs').matchAll(/SET review_status = '([^'$]+)'/g)].map(m => m[1]);
  for (const state of writes) assert.ok(row.states.some(s => s.name === state), `unmapped SQL state ${state}`);
}
export function diagrams(map) {
  return map.objects.map(object => {
    const alias = new Map(object.states.map((s, i) => [s.name, `s${i}`])); alias.set('[*]', '[*]');
    return `\n### ${object.id}\n\n${object.description ? `${object.description}\n\n` : ""}\`\`\`mermaid\nstateDiagram-v2\n`
      + object.states.map(s => `    state "${s.name}" as ${alias.get(s.name)}`).join('\n') + '\n'
      + object.transitions.map(e => `    ${alias.get(e.from)} --> ${alias.get(e.to)}: ${e.id} ${e.trigger}`).join('\n') + '\n'
      + object.states.filter(s => s.terminal).map(s => `    ${alias.get(s.name)} --> [*]`).join('\n') + '\n```\n';
  }).join('');
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalSchemaLeaves, isValidSchemaPath, schemaLeaf } from '../src/config-paths.mjs';
import { fromJsonSchema } from '../src/config-schema.mjs';

test('schema leaf lookup tolerates missing roots and intermediate definitions', () => {
  for (const missing of [null, undefined]) {
    assert.equal(schemaLeaf(missing, 'parent.child'), null);
    assert.equal(schemaLeaf({ __type: 'dict', __keys: { parent: missing } }, 'parent.child'), null);
  }
});

test('flattening prefers declared schemas and uses typed extras only for additional keys', () => {
  for (const [declared, extra] of [
    [{ type: 'object', properties: { child: { type: 'string' } } }, { type: 'string' }],
    [{ type: 'string' }, { type: 'object', properties: { child: { type: 'string' } } }],
  ]) {
    const schema = fromJsonSchema({
      type: 'object', properties: { declared }, additionalProperties: extra,
    });
    const valueFor = node => node.type === 'object' ? { child: 'value' } : 'value';
    const doc = { declared: valueFor(declared), dynamic: valueFor(extra), __metadata: 'ignored' };
    const entries = [...canonicalSchemaLeaves(doc, schema, 'fixture')];
    const expectedPaths = [
      declared.type === 'object' ? 'declared.child' : 'declared',
      extra.type === 'object' ? 'dynamic.child' : 'dynamic',
    ];
    assert.deepEqual(entries.map(entry => entry.dotted), expectedPaths);
    for (const entry of entries) {
      assert.equal(entry.value, 'value');
      assert.deepEqual(entry.path, entry.dotted.split('.'));
      assert.equal(schemaLeaf(schema, entry.dotted).__type, 'string');
      assert.equal(isValidSchemaPath(schema, entry.dotted), true);
    }
  }
});

import './helpers/rate-limit-state-isolation.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildRegisterSource, synchronousFixtureHooks } from './helpers/fixture-loader-register.mjs';

for (const synchronous of [true, false]) {
  test(`fixture hooks preserve source overrides and CJS loading (synchronous=${synchronous})`, t => {
    const root = mkdtempSync(join(tmpdir(), 'loader-register-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const loader = join(root, 'loader.mjs'), register = join(root, 'register.mjs');
    const entry = join(root, 'entry.mjs');
    writeFileSync(join(root, 'dependency.mjs'), "export const value = 'original';");
    writeFileSync(join(root, 'common.cjs'), "module.exports = { value: 'commonjs' };");
    writeFileSync(loader, `
      import { threadId } from 'node:worker_threads';
      const literal = 'await nextLoad(url, context)';
      export async function resolve(specifier, context, nextResolve) {
        const resolved = await nextResolve(specifier, context);
        return resolved;
      }
      export async function load(url, context, nextLoad) {
        const result = await nextLoad(url, context);
        if (url.endsWith('/dependency.mjs')) {
          result.source = String(result.source).replace('original', 'stubbed')
            + '\\nexport const loaderThread = ' + threadId + ';'
            + '\\nexport const literal = ' + JSON.stringify(literal) + ';';
        }
        return result;
      }
    `);
    writeFileSync(register, buildRegisterSource(loader, { synchronous }));
    writeFileSync(entry, `
      import assert from 'node:assert/strict';
      import * as module from 'node:module';
      import { value, loaderThread, literal } from './dependency.mjs';
      import common from './common.cjs';
      assert.equal(value, 'stubbed');
      assert.equal(common.value, 'commonjs');
      assert.equal(literal, 'await nextLoad(url, context)');
      assert.equal(loaderThread === 0, ${synchronous} && typeof module.registerHooks === 'function');
    `);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ['--import', register, entry],
      { env, encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
}

test('fixture conversion preserves nested async functions and refuses unrelated hook awaits', () => {
  const source = `
    export async function resolve
      (specifier, context, nextResolve) {
      async function nested() { await Promise.resolve(); }
      return await nextResolve(specifier, context);
    }
    export async function load(url, context, nextLoad) {
      return await nextLoad(url, context);
    }
  `;
  const converted = synchronousFixtureHooks(source);
  assert.match(converted, /async function nested\(\) \{ await Promise.resolve\(\); \}/);
  assert.match(converted, /export function resolve/);
  assert.match(converted, /return nextLoad\(url, context\)/);
  assert.throws(() => synchronousFixtureHooks(source.replace('return await nextLoad(url, context);',
    'await Promise.resolve(); return nextLoad(url, context);')), /asynchronous operation/);
});

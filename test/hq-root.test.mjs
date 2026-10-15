import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveHqRoot } from '../src/hq-root.mjs';

test('HQ root preserves precedence, empty fallbacks and the production default', () => {
  assert.equal(resolveHqRoot({ HQ_ROOT: '/fixture/primary', AGENT_OS_HQ_ROOT: '/fixture/secondary' }), '/fixture/primary');
  assert.equal(resolveHqRoot({ HQ_ROOT: '', AGENT_OS_HQ_ROOT: '/fixture/secondary' }), '/fixture/secondary');
  assert.equal(resolveHqRoot({ HQ_ROOT: '', AGENT_OS_HQ_ROOT: '' }), join(homedir(), 'agent-os-hq'));
  assert.equal(resolveHqRoot({}), join(homedir(), 'agent-os-hq'));
});

test('HQ root observes the environment at call time', (t) => {
  const previous = process.env.HQ_ROOT;
  t.after(() => {
    if (previous === undefined) delete process.env.HQ_ROOT;
    else process.env.HQ_ROOT = previous;
  });
  process.env.HQ_ROOT = '/fixture/first';
  assert.equal(resolveHqRoot(), '/fixture/first');
  assert.equal(resolveHqRoot(null), '/fixture/first');
  process.env.HQ_ROOT = '/fixture/second';
  assert.equal(resolveHqRoot(), '/fixture/second');
});

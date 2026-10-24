import test from 'node:test';
import assert from 'node:assert/strict';
import { replayRouteAllowed, parseReplayReview } from '../src/osg-reviewer-replay.mjs';

test('OSG-11 replay refuses same-family and unknown builders using canonical routing', () => {
  assert.equal(replayRouteAllowed('codex', { harness: 'codex', model: 'gpt-6.1-sol' }), false);
  assert.equal(replayRouteAllowed('clio-agent', { harness: 'codex', model: 'gpt-6-luna' }), false);
  assert.equal(replayRouteAllowed('gemini', { harness: 'gemini', model: 'gemini-test' }), false);
  assert.equal(replayRouteAllowed('unknown', { harness: 'codex', model: 'gpt-6.1-sol' }), false);
  assert.equal(replayRouteAllowed('claude-code', { harness: 'codex', model: 'gpt-6.1-sol' }), true);
  assert.equal(replayRouteAllowed('codex', { harness: 'pi', model: 'deepseek/model' }, { diagnostic: true }), true);
  assert.equal(replayRouteAllowed('codex', { harness: 'pi', model: 'deepseek/model' }), false);
  assert.equal(replayRouteAllowed('codex', { harness: 'pi', model: 'openai/gpt-6.1-sol' }, { diagnostic: true }), false);
});

test('OSG-11 parses shadow findings without writer or attestation effects', () => {
  const forbidden = () => assert.fail('publication effect reached');
  const result = parseReplayReview('## Blocking Issues\n- **Bound**\n  - **File:** x.py\n  - **Lines:** 2-3\n  - **Problem:** Missing bound.\n\n## Non-blocking Notes\n- None.\n', { githubWriter: forbidden, attest: forbidden });
  assert.equal(result.length, 1);
  assert.equal(result[0].blocking, true);
  assert.deepEqual(result[0].line_ranges, [{ start: 2, end: 3 }]);
  assert.throws(() => parseReplayReview('malformed'));
});

test('OSG-11 shadow fixture runs with publication and process effects forbidden', async () => {
  const { spawnSync } = await import('node:child_process');
  const target = new URL('../src/osg-reviewer-replay.mjs', import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import http from 'node:http';
    import https from 'node:https';
    import cp from 'node:child_process';
    import { syncBuiltinESMExports, registerHooks } from 'node:module';
    const forbid = () => { throw Error('publication effect reached'); };
    for (const key of ['writeFileSync','appendFileSync','renameSync','mkdirSync']) fs[key] = forbid;
    for (const mod of [http, https]) { mod.request = forbid; mod.get = forbid; }
    for (const key of ['spawn','spawnSync','execFile','execFileSync','exec','execSync']) cp[key] = forbid;
    globalThis.fetch = forbid;
    syncBuiltinESMExports();
    registerHooks({ resolve(specifier, context, next) {
      if (/attest|github-writer|reviewer\\.mjs$/.test(specifier)) forbid();
      return next(specifier, context);
    }});
    const replay = await import(${JSON.stringify(target)});
    if (!replay.replayRouteAllowed('claude-code', {harness:'codex',model:'gpt-6.1-sol'})) throw Error('route');
    replay.parseReplayReview('## Blocking Issues\\n- None.');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

test('OSG-11 parses shadow findings with canonical headings and line ranges', () => {
  const result = parseReplayReview('## Blocking Issues\n- **Bound**\n  - **File:** x.py\n  - **Lines:** 2-3\n  - **Problem:** Missing bound.\n\n## Non-blocking Issues\n- None.\n');
  assert.equal(result.length, 1);
  assert.equal(result[0].blocking, true);
  assert.deepEqual(result[0].line_ranges, [{ start: 2, end: 3 }]);
  assert.throws(() => parseReplayReview('malformed'));
});

test('OSG-11 requires both review sections to be known, including placeholder validation', () => {
  const clean = '- None.\n';
  const placeholder = '- **<Title>**\n  - **File:** <path>\n  - **Problem:** <one paragraph>\n';
  assert.deepEqual(parseReplayReview(`## Blocking Issues\n${clean}\n## Non-blocking Issues\n${clean}`), []);
  for (const [section, other] of [['Blocking Issues', 'Non-blocking Issues'], ['Non-blocking Issues', 'Blocking Issues']]) {
    assert.throws(() => parseReplayReview(`## ${other}\n${clean}`), /missing review section/);
    assert.throws(() => parseReplayReview(`## ${other}\n${clean}\n## ${section}\n${placeholder}`), /missing review section/);
  }
  assert.throws(() => parseReplayReview(`## Blocking Issues\n${clean}\n## Non-blocking Notes\n${clean}`), /missing review section/);
  const findings = parseReplayReview(`## Blocking Issues\n${clean}\n## Non-blocking Issues\n- **Note**\n  - **File:** x.py\n  - **Lines:** 4\n  - **Problem:** Missing comment.\n`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].blocking, false);
  assert.equal(findings[0].title, 'Note');
  assert.deepEqual(findings[0].line_ranges, [{ start: 4, end: 4 }]);
});

test('OSG-11 null routing options use the ordinary non-diagnostic defaults', () => {
  assert.equal(replayRouteAllowed('claude-code', { harness: 'codex', model: 'gpt-6.1-sol' }, null), true);
  assert.equal(replayRouteAllowed('codex', { harness: 'codex', model: 'gpt-6.1-sol' }, null), false);
  assert.equal(replayRouteAllowed('codex', { harness: 'pi', model: 'deepseek/model' }, null), false);
});

const bridge = new URL('../bin/osg-reviewer-replay.mjs', import.meta.url);
function runBridge(value) {
  return spawnSync(process.execPath, [bridge.pathname], { input: JSON.stringify(value), encoding: 'utf8', timeout: 5000 });
}

test('OSG-11 stdin bridge accepts null options and emits newline-delimited JSON', () => {
  const result = runBridge({ operation: 'route', builder_class: 'claude-code', arm: { harness: 'codex', model: 'gpt-6.1-sol' }, options: null });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'true\n');
});

test('OSG-11 stdin bridge preserves UTF-8 sequences split between chunks', () => {
  const body = '## Blocking Issues\n- **Café 🌍**\n  - **File:** café.py\n  - **Lines:** 2\n  - **Problem:** Missing bound.\n\n## Non-blocking Issues\n- None.\n';
  const input = Buffer.from(JSON.stringify({ operation: 'parse', body_md: body }));
  const script = `
    import { Readable } from 'node:stream';
    const bytes = ${JSON.stringify([...input])};
    Object.defineProperty(process, 'stdin', { value: Readable.from(bytes.map(byte => Buffer.from([byte]))) });
    await import(${JSON.stringify(bridge.href)});
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(parseReplayReview(body))}\n`);
});

test('OSG-11 stdin bridge rejects malformed reviews and oversized UTF-8 input without stdout', () => {
  for (const value of [
    { operation: 'parse', body_md: '## Blocking Issues\n- None.\n' },
    { operation: 'ranges', lines: '2', file: 'é'.repeat(65536) },
  ]) {
    const result = runBridge(value);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Replay input unavailable or invalid.\n');
  }
});

test('OSG-11 shadow fixture runs with publication and process effects forbidden', async () => {
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
    replay.parseReplayReview('## Blocking Issues\\n- None.\\n\\n## Non-blocking Issues\\n- None.');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

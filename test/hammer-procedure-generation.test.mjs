import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderHammerProcedure, HAMMER_PHASES, splitHammerPrompt } from '../src/hammer-procedure.mjs';

test('copied procedures identify their source generation without changing the executable header', () => {
  for (const phase of HAMMER_PHASES) {
    const source = readFileSync(new URL(`../bin/${phase}.sh`, import.meta.url));
    const expected = createHash('sha256').update(source).digest('hex');
    const values = Object.fromEntries([...source.toString().matchAll(/<<([A-Z_]+)>>/g)].map(([, key]) => [key, 'fixture']));
    const rendered = renderHammerProcedure(phase, values);
    assert.ok(rendered.startsWith(`#!/usr/bin/env bash\n# hammer-procedure-source-sha256: ${expected}\n`));
    assert.equal(rendered, renderHammerProcedure(phase, values));
    assert.equal(rendered.match(/hammer-procedure-source-sha256:/g).length, 1);
  }
});

test('rendered phase receipts are emitted by phase outcomes without changing merge fences', () => {
  for (const phase of HAMMER_PHASES) {
    const source = readFileSync(new URL(`../bin/${phase}.sh`, import.meta.url), 'utf8');
    const values = Object.fromEntries([...source.matchAll(/<<([A-Z_]+)>>/g)].map(([, key]) => [key, 'fixture']));
    const rendered = renderHammerProcedure(phase, values);
    // A no-merge merge outcome can be retried in-run, so phases never record terminal-stop.
    assert.doesNotMatch(rendered, /terminal-stop/);
    if (phase !== 'hammer-merge') assert.ok(rendered.includes('/bin/hammer-progress.mjs'));
    if (phase === 'hammer-verify-head') {
      assert.match(rendered, /HAM_PHASE_OUTCOME=verified\n.*verify-head/);
      assert.match(rendered, /export HAM_PUSHED_FROM_HEAD HAM_PUSHED_HEAD\n.*remediation-pushed/);
    }
    if (phase === 'hammer-publish') assert.match(rendered, /remediation-pushed/);
    if (phase === 'hammer-merge') {
      assert.doesNotMatch(rendered, /\/bin\/hammer-progress\.mjs/);
      assert.match(rendered, /--match-head-commit "\$POST_REMEDIATION_SHA"/);
    }
  }
});

test('phase receipt failures warn once and preserve execution under errexit', () => {
  for (const phase of HAMMER_PHASES) {
    const source = readFileSync(new URL(`../bin/${phase}.sh`, import.meta.url), 'utf8');
    const values = Object.fromEntries([...source.matchAll(/<<([A-Z_]+)>>/g)].map(([, key]) => [key, 'fixture']));
    values.ROOT_DIR = fileURLToPath(new URL('../', import.meta.url));
    const rendered = renderHammerProcedure(phase, values);
    const calls = rendered.split('\n').filter(line => line.includes('/bin/hammer-progress.mjs'));
    assert.ok(phase === 'hammer-merge' || calls.length > 0);
    for (const call of calls) {
      const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-euc', `${call}\nprintf 'continued'`], {
        env: { ...process.env, HAM_NODE_BIN: process.execPath, ham_audit_reason: 'checks-red',
          HQ_WORKER_RUN_ID: 'invalid-run' },
        encoding: 'utf8', timeout: 5000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'continued');
      assert.equal(result.stderr, 'HAM progress receipt unavailable\n');
    }
  }
});

test('reference extraction preserves complete appendix content and refuses broken markers', () => {
  const content = 'Mandatory rule.\n\n```bash\nsource "$INPUTS"\n```';
  const template = `Core rule.\n<!-- hammer-reference:B1 -->\n${content}\n<!-- /hammer-reference:B1 -->\nTail rule.`;
  const result = splitHammerPrompt(template);
  assert.match(result.prompt, /Core rule/);
  assert.match(result.prompt, /Read \*\*Appendix B1\*\*.*<<RUN_DIR>>\/hammer-reference.md/);
  assert.match(result.prompt, /Tail rule/);
  assert.ok(result.reference.includes(content));
  assert.throws(() => splitHammerPrompt(template.replace('/hammer-reference:B1', '/hammer-reference:E1')), /malformed/);
  assert.deepEqual(splitHammerPrompt('Unchanged fixture'), { prompt: 'Unchanged fixture', reference: '' });
});

test('HAMPROMPT-01: rendered outcome routing names an action without changing phase status', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-outcome-routing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, 'phase.sh');
  for (const [phase, status, publicationOnly, next] of [
    ['hammer-verify-head', 0, 0, /Appendix C revalidation/],
    ['hammer-verify-head', 20, 0, /stop with fixture-refusal/],
    ['hammer-verify-head', 21, 0, /Appendix D.*re-enter verify-head/],
    ['hammer-verify-head', 1, 0, /stop with fixture-refusal/],
    ['hammer-publish', 0, 1, /unset HAM_COMMIT_PUBLICATION_ONLY.*run verify-head/],
    ['hammer-publish', 0, 0, /Appendix E exact-head predicate/],
    ['hammer-publish', 0, 'true', /Appendix E exact-head predicate/],
    ['hammer-publish', 0, 'yes', /Appendix E exact-head predicate/],
    ['hammer-publish', 0, '', /Appendix E exact-head predicate/],
    ['hammer-publish', 1, 0, /stop with fixture-refusal/],
    ['hammer-merge', 0, 0, /confirmed-merge closing audit/],
    ['hammer-merge', 21, 0, /Appendix D.*re-enter verify-head/],
    ['hammer-merge', 75, 0, /stop with fixture-refusal/],
  ]) {
    const source = readFileSync(new URL(`../bin/${phase}.sh`, import.meta.url), 'utf8');
    const values = Object.fromEntries([...source.matchAll(/<<([A-Z_]+)>>/g)].map(([, key]) => [key, 'fixture']));
    // Stub only the phase's execution; run the production renderer's complete
    // return/audit/routing wrapper without credentials, network or live state.
    const rendered = renderHammerProcedure(phase, values)
      .replace('ham_run_rendered_phase "$@"', `HAM_PHASE_OUTCOME=fixture-refusal\n(exit ${status})`);
    // Node may use a socket for piped stdin on Linux; /dev/stdin cannot reopen
    // that socket. Source a real file, as the dispatched closer does.
    writeFileSync(script, rendered);
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', 'source "$1"', 'bash', script], {
      encoding: 'utf8', timeout: 5000,
      env: { PATH: process.env.PATH, HAM_NODE_BIN: '/usr/bin/true',
        HAM_COMMIT_PUBLICATION_ONLY: String(publicationOnly) },
    });
    assert.ifError(result.error);
    assert.equal(result.status, status, result.stderr);
    assert.match(result.stderr, next);
    assert.doesNotMatch(result.stderr, /sed -n|rg |grep |integer expression expected/);
  }
});

test('publication dispatch treats non-numeric flags as ordinary audit publication without shell errors', () => {
  const source = readFileSync(new URL('../bin/hammer-publish.sh', import.meta.url), 'utf8');
  const dispatch = source.slice(source.indexOf('# Called before the hammer'));
  assert.ok(dispatch.length < source.length, 'exercise the production publication dispatch');
  for (const flag of ['true', 'yes', '', '0']) {
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-uc', `
ham_publish_phase() { echo audit-publication; }
publish() {
${dispatch.replaceAll(/<<[A-Z_]+>>/g, 'fixture')}
}
publish
`], {
      encoding: 'utf8', timeout: 5000,
      env: { PATH: process.env.PATH, HAM_COMMIT_PUBLICATION_ONLY: flag },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'audit-publication\n');
    assert.equal(result.stderr, '');
  }
});

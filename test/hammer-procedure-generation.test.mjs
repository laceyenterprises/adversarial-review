import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { renderHammerProcedure, HAMMER_PHASES } from '../src/hammer-procedure.mjs';

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
    assert.ok(rendered.includes('/bin/hammer-progress.mjs'));
    if (phase === 'hammer-verify-head') assert.match(rendered, /HAM_PHASE_OUTCOME=verified\n.*verify-head/);
    if (phase === 'hammer-publish') assert.match(rendered, /remediation-pushed/);
    if (phase === 'hammer-merge') {
      assert.match(rendered, /terminal-stop/);
      assert.match(rendered, /--match-head-commit "\$POST_REMEDIATION_SHA"/);
    }
  }
});

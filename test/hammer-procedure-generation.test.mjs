import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
    if (phase === 'hammer-verify-head') {
      assert.match(rendered, /HAM_PHASE_OUTCOME=verified\n.*verify-head/);
      assert.match(rendered, /export HAM_PUSHED_FROM_HEAD HAM_PUSHED_HEAD\n.*remediation-pushed/);
    }
    if (phase === 'hammer-publish') assert.match(rendered, /remediation-pushed/);
    if (phase === 'hammer-merge') {
      assert.match(rendered, /terminal-stop/);
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
    assert.ok(calls.length > 0);
    for (const call of calls) {
      const result = spawnSync('/bin/bash', ['-euc', `${call}\nprintf 'continued'`], {
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

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

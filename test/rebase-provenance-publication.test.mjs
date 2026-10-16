import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hammerAttestationChain } from '../src/ama/hammer-head-validation.mjs';

const source = readFileSync(new URL('../bin/hammer-publish.sh', import.meta.url), 'utf8');
const block = source.slice(source.indexOf('ham_resolve_audit_base_head()'), source.indexOf('HAM_AUDIT_BASE_HEAD='));
const reviewed = 'a'.repeat(40), rebased = 'b'.repeat(40), current = 'c'.repeat(40);
for (const kind of ['rebase', 'ordinary', 'malformed']) {
  test(`REBASEPROV-01 ${kind} proof binds the durable audit to the proven base`, t => {
    const root = mkdtempSync(join(tmpdir(), 'rebase-audit-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, 'range.json'), JSON.stringify(kind === 'ordinary' ? { verified: true } : {
      verified: true, proof: 'reviewed-rebase-patch-equivalence', reviewedHead: reviewed,
      rebaseCoverage: { reviewedHead: kind === 'malformed' ? rebased : reviewed },
    }));
    const script = `HAM_BASE_HEAD=${rebased}\nham_is_full_sha() { [[ "$1" =~ ^[a-f0-9]{40}$ ]]; }\n${block.replaceAll('<<RUN_DIR>>', root)}\nham_resolve_audit_base_head`;
    const run = () => execFileSync('bash', ['-c', script], { encoding: 'utf8', stdio: 'pipe' });
    if (kind === 'malformed') { assert.throws(run); return; }
    const base = run();
    assert.equal(base, kind === 'rebase' ? reviewed : rebased);
    const chain = hammerAttestationChain([{ author: 'hammer-worker', body: `HAM-Base-Head: ${base}\nHAM-Validated-Head: ${current}` }], reviewed, current);
    assert.deepEqual(chain, kind === 'rebase' ? [current] : null);
    assert.ok(source.includes('  "$HAM_AUDIT_BASE_HEAD" \\\n  "$POST_REMEDIATION_SHA"'));
  });
}

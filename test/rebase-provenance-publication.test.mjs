import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderHammerProcedure } from '../src/hammer-procedure.mjs';
import { hammerAttestationChain } from '../src/ama/hammer-head-validation.mjs';

const source = readFileSync(new URL('../bin/hammer-publish.sh', import.meta.url), 'utf8');
const reviewed = 'a'.repeat(40), rebased = 'b'.repeat(40), current = 'c'.repeat(40);
for (const kind of ['rebase', 'ordinary', 'malformed']) {
  test(`REBASEPROV-01 ${kind} proof binds the durable audit to the proven base`, t => {
    const root = mkdtempSync(join(tmpdir(), 'rebase-audit-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, 'range.json'), JSON.stringify(kind === 'ordinary' ? { verified: true } : {
      verified: true, proof: 'reviewed-rebase-patch-equivalence', reviewedHead: reviewed,
      rebaseCoverage: { reviewedHead: kind === 'malformed' ? rebased : reviewed },
    }));
    const rendered = renderHammerProcedure('hammer-publish', { RUN_DIR: root, ROOT_DIR: root, HQ_ROOT: root,
      REPO: 'fixture/repo', PR_NUMBER: '42', PR_URL: 'https://github.com/fixture/repo/pull/42', REVIEWED_SHA: reviewed });
    assert.doesNotMatch(rendered, /<<[A-Z_]+>>/);
    // Exercise the source resolver directly with the runtime directory.
    const block = source.slice(source.indexOf('ham_resolve_audit_base_head()'), source.indexOf('HAM_AUDIT_BASE_HEAD='));
    const script = `HAM_BASE_HEAD=${rebased}\nham_is_full_sha() { [[ "$1" =~ ^[a-f0-9]{40}$ ]]; }\n${block}\nham_resolve_audit_base_head`;
    const run = () => execFileSync('bash', ['-c', script], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, HAM_RUN_DIR: root } });
    if (kind === 'malformed') { assert.throws(run); return; }
    const base = run();
    assert.equal(base, kind === 'rebase' ? reviewed : rebased);
    const chain = hammerAttestationChain([{ author: 'hammer-worker', body: `HAM-Base-Head: ${base}\nHAM-Validated-Head: ${current}` }], reviewed, current);
    assert.deepEqual(chain, kind === 'rebase' ? [current] : null);
    assert.ok(source.includes('  "$HAM_AUDIT_BASE_HEAD" \\\n  "$POST_REMEDIATION_SHA"'));
  });
}

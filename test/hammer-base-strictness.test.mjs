import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = readFileSync(new URL('../bin/hammer-verify-head.sh', import.meta.url), 'utf8');
const resolver = source.match(/^ham_resolve_base_strictness\(\) \{\n[\s\S]*?^\}/m)?.[0];
const branch = { name: 'release/test', protected: false, commit: { sha: 'a'.repeat(40) } };

for (const [name, protection, metadata, expected] of [
  ['explicit non-strict', { strict: false }, null, 0],
  ['explicit strict', { strict: true }, branch, 1],
  ['string false is unreadable', { strict: 'false' }, branch, 1],
  ['missing strict is unreadable', {}, branch, 1],
  ['403 plus unprotected branch', null, branch, 0],
  ['404 plus unprotected branch', null, branch, 0],
  ['404 required checks disabled plus protected branch', null, { ...branch, protected: true }, 1],
  ['404 plus protected branch', null, { ...branch, protected: true }, 1],
  ['403 plus protected branch', null, { ...branch, protected: true }, 1],
  ['403 plus missing protected', null, { name: branch.name, commit: branch.commit }, 1],
  ['403 plus wrong branch', null, { ...branch, name: 'other' }, 1],
  ['403 plus string false', null, { ...branch, protected: 'false' }, 1],
  ['403 plus missing head', null, { ...branch, commit: {} }, 1],
  ['403 plus failed branch read', null, null, 1],
]) {
  test(`LAC-2097 strictness: ${name}`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'base-strictness-'));
    t.after(() => rmSync(dir, { force: true, recursive: true }));
    assert.ok(resolver);
    const result = spawnSync('/bin/bash', ['-uc', `
${resolver.replaceAll('<<RUN_DIR>>', dir).replaceAll('<<REPO>>', 'fixture/repo')}
BASE_BRANCH=release/test
ham_gh() {
  if [[ "$2" == */required_status_checks ]]; then
    if [ "$PROTECTION" = null ]; then echo "$ERROR" >&2; return 1; fi
    printf '%s' "$PROTECTION"
  else
    [ "$2" = repos/fixture/repo/branches/release%2Ftest ] || return 90
    [ "$METADATA" != null ] || return 1
    printf '%s' "$METADATA"
  fi
}
ham_resolve_base_strictness
echo "$HAM_REQUIRES_UP_TO_DATE"
`], { encoding: 'utf8', timeout: 5000, env: { ...process.env,
      PROTECTION: JSON.stringify(protection), METADATA: JSON.stringify(metadata),
      ERROR: name.startsWith('404 required') ? 'Required status checks not enabled (HTTP 404)' : name.startsWith('404') ? 'Branch not protected (HTTP 404)' : 'Resource not accessible by integration (HTTP 403)',
    } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim(), String(expected));
    if (!protection) assert.match(readFileSync(join(dir, 'required-status-checks.stderr'), 'utf8'), /HTTP 40[34]/);
  });
}

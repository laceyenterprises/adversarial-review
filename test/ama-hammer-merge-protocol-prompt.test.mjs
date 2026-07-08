import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const HAMMER_PROMPT = readFileSync(join(REPO_ROOT, 'templates', 'hammer-prompt.md'), 'utf8');

test('hammer prompt enforces the PSH-05 lease guarded local and remote CI merge protocol', () => {
  assert.match(HAMMER_PROMPT, /final rebase→local-CI→remote-CI→merge window/);
  assert.match(HAMMER_PROMPT, /HAM_MERGE_LEASE_WAIT_SECONDS="\$\{HAM_MERGE_LEASE_WAIT_SECONDS:-900\}"/);
  assert.match(HAMMER_PROMPT, /trap ham_release_merge_lease EXIT/);
  assert.match(HAMMER_PROMPT, /ham_run_pph_ci_mirror_with_timeout\(\)/);
  assert.match(HAMMER_PROMPT, /PPH pre-push CI mirror/);
  assert.match(HAMMER_PROMPT, /HAM_REMOTE_CI_WAIT_SECONDS="\$\{HAM_REMOTE_CI_WAIT_SECONDS:-900\}"/);
  assert.match(HAMMER_PROMPT, /github-gate-red/);
  assert.match(HAMMER_PROMPT, /github-gate-timeout/);
  assert.match(HAMMER_PROMPT, /--match-head-commit "\$POST_REMEDIATION_SHA"/);
  assert.match(HAMMER_PROMPT, /rebasedOntoBase: \$rebasedOntoBase/);
  assert.match(HAMMER_PROMPT, /localCiStatus: \$localCiStatus/);
  assert.match(HAMMER_PROMPT, /remoteCiStatus: \$remoteCiStatus/);
  assert.match(HAMMER_PROMPT, /Closed-By: hammer \(adversarial-pipe-mode\)/);
});

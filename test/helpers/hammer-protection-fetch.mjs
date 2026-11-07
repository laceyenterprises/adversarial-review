// Runs the hammer's branch-protection fetch (bin/hammer-predicate-inputs.mjs)
// against a stub that answers with the given stdout, stderr and exit code.
// HAMBG-02: the fetch has to turn GitHub's real answers into a protection file
// that ama-check can decide on.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectPredicateInputs } from '../../src/ama/predicate-inputs.mjs';

export const GITHUB_PLAN_UNAVAILABLE_STDERR =
  'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)';
export const BRANCH_NOT_PROTECTED_STDERR = 'gh: Branch not protected (HTTP 404)';
export const BRANCH_NOT_PROTECTED_STDOUT =
  '{"message":"Branch not protected","documentation_url":"https://docs.github.com/rest/branches/branch-protection#get-branch-protection","status":"404"}';

export const FIXTURE_HEAD = 'a'.repeat(40);

// CLOSERGATES-01: the fetch moved from transcribed prompt shell into
// bin/hammer-predicate-inputs.mjs. Drive its real collector against a stub
// protection answer, a branch read that finds the base, and a fake clock.
export function runHammerProtectionFetch({ stdout = '', stderr = '', exitCode = 1 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ham-protection-fetch-'));
  try {
    let at = 0;
    const clock = { now: () => at, sleep: ms => { at += ms; } };
    const result = collectPredicateInputs({
      repo: 'laceyenterprises/example', prNumber: 42, headSha: FIXTURE_HEAD, runDir: dir, clock,
      readPr: args => args.includes('reviews') ? '{"reviews":[]}'
        : JSON.stringify({ number: 42, headRefOid: FIXTURE_HEAD, baseRefName: 'main' }),
      readApi: ([path]) => {
        if (path.endsWith('/protection')) {
          if (exitCode === 0) return stdout;
          throw new Error(stderr);
        }
        if (path.endsWith('/branches/main')) return '{"name":"main","protected":true}';
        return path.includes('/timeline') ? '[]' : '{}';
      },
    });
    const protectionPath = join(dir, 'protection.json');
    const protectionBody = existsSync(protectionPath) ? readFileSync(protectionPath, 'utf8') : null;
    return { status: result.ok ? 0 : 1, stderr: result.ok ? '' : `${result.reason}\n${result.detail || ''}`,
      reason: result.reason, protectionBody };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

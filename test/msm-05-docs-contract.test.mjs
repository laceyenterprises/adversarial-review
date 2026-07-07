import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Only run this cross-repo docs contract against an EXPLICITLY provided agent-os
// checkout (AGENT_OS_ROOT). Auto-resolving a sibling `../agent-os` is unreliable:
// in the submodule layout it points at a non-existent `tools/agent-os`, and in a
// multi-worktree dev box it can latch onto a stale, unrelated checkout and
// produce a false failure. Standalone CI (no AGENT_OS_ROOT) skips cleanly.
const AGENT_OS_ROOT = process.env.AGENT_OS_ROOT || null;

function readAgentOsDoc(relativePath) {
  return readFileSync(resolve(AGENT_OS_ROOT, relativePath), 'utf8');
}

test('MSM-05 docs no longer describe an agent spawned solely to click merge', (t) => {
  if (!AGENT_OS_ROOT || !existsSync(resolve(AGENT_OS_ROOT, 'CLAUDE.md'))) {
    t.skip('Set AGENT_OS_ROOT to a current agent-os checkout to run the cross-repo docs contract');
    return;
  }

  const claude = readAgentOsDoc('CLAUDE.md');
  const autoRemediationSpec = readAgentOsDoc('docs/SPEC-adversarial-review-auto-remediation.md');
  const amaSpec = readAgentOsDoc('projects/adversarial-merge-authority/SPEC.md');

  assert.match(claude, /merges under its own lease/i);
  assert.match(claude, /no agent spawned solely to click merge/i);
  assert.doesNotMatch(claude, /dispatch(?:es)? a closer worker/i);

  assert.match(autoRemediationSpec, /two-path\s+merge model/i);
  assert.match(autoRemediationSpec, /no\s+agent spawned solely to click merge/i);
  assert.doesNotMatch(autoRemediationSpec, /dispatch(?:es)? a closer worker/i);

  assert.match(amaSpec, /Status:\*\* Superseded/i);
  assert.match(amaSpec, /agent-spawn closer described in this document is no longer/i);
});

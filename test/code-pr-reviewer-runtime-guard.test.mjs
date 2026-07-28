import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const codePrDomainPath = join(__dirname, '..', 'domains', 'code-pr.json');

// RPR-01 guard — the missing smoke gate.
//
// On 2026-07-26..28 a build pack (PRD-01 #687 "Drive code-pr via AgentRuntime
// port") silently flipped the live code-pr `reviewerRuntime` from `cli-direct`
// to `agent-runtime` with NO end-to-end settle smoke. The agent-runtime path
// produced "artifactless dead dispatch" reviews (see #699/#703 hotfixes) whose
// verdicts never settled, so the adversarial gate stayed `review-queued`
// forever and ~15 landed packs were stranded. RC-1 (#706) reverted it, but a
// later pack (PXT-02 #707) re-flipped it back to agent-runtime — again with no
// gate to stop the silent flip.
//
// This test IS that gate: the live code-pr pipeline may only run on a
// settle-proven reviewer runtime. `agent-runtime` (and any other unproven
// runtime) stays quarantined until it has a passing end-to-end settle smoke.
// Opting back in is deliberately made a visible, reviewed decision: set
// `agentRuntimeSettleSmokeVerified: true` in domains/code-pr.json in the SAME PR
// that lands the smoke evidence. A pack can no longer casually flip the reviewer
// runtime without this test failing at PR time.
const SETTLE_PROVEN_REVIEWER_RUNTIMES = new Set(['cli-direct']);

test('code-pr reviewerRuntime is settle-proven (RPR-01 guard)', () => {
  const domain = JSON.parse(readFileSync(codePrDomainPath, 'utf8'));
  const runtime = domain.reviewerRuntime || 'cli-direct';

  if (SETTLE_PROVEN_REVIEWER_RUNTIMES.has(runtime)) {
    return;
  }

  assert.equal(
    domain.agentRuntimeSettleSmokeVerified,
    true,
    [
      `code-pr reviewerRuntime='${runtime}' is NOT settle-proven.`,
      `Only [${[...SETTLE_PROVEN_REVIEWER_RUNTIMES].join(', ')}] may run the live`,
      `code-pr pipeline without proof. To use '${runtime}', land a passing`,
      `end-to-end settle smoke and set "agentRuntimeSettleSmokeVerified": true in`,
      `domains/code-pr.json in the same PR. See RPR-01 (reviewer pipeline outage:`,
      `agent-runtime produced artifactless reviews that never settled).`,
    ].join(' '),
  );
});

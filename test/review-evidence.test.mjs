import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadStagePrompt } from '../src/kernel/prompt-stage.mjs';
import { buildPromptForReviewerModel } from '../src/reviewer-prompt.mjs';
import { groundArgusReviewEvidence, loadArgusReviewPromptTemplate, parseArgusReviewOutput } from '../src/argus-security-review.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('REVIEWEVIDENCE-01: every reviewer family and stage requires exact-head failing behaviour evidence', () => {
  const prompts = [loadArgusReviewPromptTemplate()];
  for (const stage of ['first', 'middle', 'last']) {
    for (const promptSet of ['code-pr', 'code-pr-security', 'research-finding']) {
      prompts.push(loadStagePrompt({ rootDir: ROOT, promptSet, actor: 'reviewer', stage }));
    }
    for (const [model, runtime] of [['codex', null], ['claude', null], ['gemini', 'antigravity']]) {
      prompts.push(buildPromptForReviewerModel(model, '', '', { promptStage: stage, runtime }));
    }
  }
  for (const prompt of prompts) {
    assert.match(prompt, /blocking only when.*`path:line`/);
    assert.match(prompt, /Input or state:[\s\S]*Wrong outcome:/);
    assert.match(prompt, /PR head/);
    assert.match(prompt, /record it as non-blocking/);
  }
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groundBlockingFindingsAtHead } from '../src/review-head-grounding.mjs';
import { parseReviewFindings } from '../src/kernel/review-findings.mjs';
import { beginReviewerPass } from '../src/reviewer-pass-tokens.mjs';
import { updateReviewerPassBodyCapture } from '../src/review-body-capture.mjs';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';

const card = (title, file = 'input.mjs', lines = '1', problem = 'Input or state: input is empty; Wrong outcome: the call throws instead of returning zero.') =>
  `- **${title}**\n  - **File:** \`${file}\`\n  - **Lines:** ${lines}\n  - **Problem:** ${problem}`;
const review = cards => `## Blocking issues\n${cards}\n\n## Non-blocking issues\n- None.\n\n## Verdict\nRequest changes`;
function gitFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'synthetic-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(join(root, 'input.mjs'), 'export const count = input => input?.length ?? 0;\n');
  git('add', 'input.mjs');
  git('-c', 'user.name=Synthetic Builder', '-c', 'user.email=builder@example.invalid', 'commit', '-qm', 'Synthetic input');
  return { root, git, head: git('rev-parse', 'HEAD') };
}

test('REVIEWEVIDENCE-01: unresolvable citations and absent behaviour are persisted as non-blocking with reasons', async t => {
  const { root, head } = gitFixture(t);
  const body = review([card('Valid'), card('Missing file', 'absent.mjs'), card('Past head', 'input.mjs', '1-9'),
    card('No lines', 'input.mjs', ''), card('No behaviour', 'input.mjs', '1', 'This could be simpler.')].join('\n'));
  const result = await groundBlockingFindingsAtHead(body, { repo: 'synthetic/project', headSha: head,
    checkoutDir: root, requireEvidence: true, log: { warn() {} } });
  assert.equal(parseReviewFindings(result.reviewText).blocking.count, 1);
  assert.deepEqual(result.grounding.demoted.map(f => f.reason),
    ['missing-at-head', 'lines-beyond-head', 'missing-location', 'missing-behaviour']);
  const argus = parseArgusReviewOutput('<argus-review-json>'+JSON.stringify({ verdict: 'block', findings: [
    { category: 'install_time_execution', severity: 'high', title: 'No evidence', path: 'input.mjs:1', detail: 'A concern.' },
  ] })+'</argus-review-json>');
  await groundArgusReviewEvidence(argus, { repo: 'synthetic/project', headSha: head, checkoutDir: root });
  assert.equal(argus.findings[0].severity, 'medium');
  assert.equal(argus.findings[0].evidenceDowngradeReason, 'missing-behaviour');
  const key = { repo: 'synthetic/project', prNumber: 7, attemptNumber: 1, passKind: 'first-pass' };
  beginReviewerPass(root, { ...key, reviewerClass: 'codex', headSha: head });
  updateReviewerPassBodyCapture(root, { ...key, bodyMd: result.reviewText, verdict: 'request-changes' });
  const db = openReviewStateDb(root); ensureReviewStateSchema(db); t.after(() => db.close());
  const rows = db.prepare('SELECT blocking, finding_json FROM review_findings ORDER BY ordinal').all();
  assert.deepEqual(rows.map(r => r.blocking), [1, 0, 0, 0, 0]);
  assert.ok(rows.slice(1).every(r => /Evidence downgrade:/.test(JSON.parse(r.finding_json).problem)));
});

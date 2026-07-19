import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ARC-18 acceptance gates. These enforce that the watcher monolith stays
// decomposed into a thin scheduler (watcher.mjs) plus leaf phase/orchestration
// modules, and that the inline GitHub subject-mechanics ARC-18 pulled out — the
// fast-merge diff-shape evaluation, live PR label / head-SHA reads, and timeline
// scraping — live behind the github-pr subject adapter and never creep back into
// the scheduler or a leaf phase module.
//
// Scope note: this lint enforces ARC-18's stated deliverable ("move the inline
// GitHub mechanics ... behind the subject/comms adapters"). The broader
// invariant of routing *all* GitHub access (the github-api.mjs / gh-cli.mjs
// low-level integration layer) exclusively through adapters is a larger
// layering effort tracked with the ARv2 five-layer boundary work (ARC-19), not
// this ticket.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'src');
const read = (p) => readFileSync(join(SRC, p), 'utf8');

function allSrcMjs(dir = SRC, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) allSrcMjs(p, acc);
    else if (name.endsWith('.mjs')) acc.push(p);
  }
  return acc;
}

// Hard ceiling that ratchets DOWN, never up. ARC-18 reduced watcher.mjs from
// 10,462 lines to a thin scheduler by moving the per-PR processing body to
// pollonce-phases.mjs and the orchestration/state clusters to leaf modules.
// Raising this means the monolith is regrowing — move code out instead.
const WATCHER_LINE_CEILING = 2000;

test(`ARC-18 gate: watcher.mjs stays under ${WATCHER_LINE_CEILING} lines`, () => {
  const lines = read('watcher.mjs').split('\n').length;
  assert.ok(
    lines < WATCHER_LINE_CEILING,
    `watcher.mjs has ${lines} lines, at/over the ${WATCHER_LINE_CEILING}-line ratchet. `
      + 'Move phase/orchestration code to pollonce-phases.mjs or a leaf module rather than raising this ceiling.',
  );
});

// The inline GitHub subject-mechanics ARC-18 moved behind the github-pr subject
// adapter. Each must be defined exactly once, in that adapter.
const SUBJECT_MECHANICS = [
  'fetchLivePRLabels',
  'fetchLivePRHeadSha',
  'fetchFastMergeAuthorizationFromTimeline',
  'fetchFastMergeChangedFiles',
  'evaluateFastMergeDiffShape',
];
const FAST_MERGE_ADAPTER = 'adapters/subject/github-pr/fast-merge.mjs';

test('ARC-18 gate: fast-merge subject-mechanics are defined exactly once, in the github-pr subject adapter', () => {
  const adapter = read(FAST_MERGE_ADAPTER);
  for (const fn of SUBJECT_MECHANICS) {
    assert.ok(
      new RegExp(`^export (async )?function ${fn}\\b`, 'm').test(adapter),
      `${fn} must be defined and exported in ${FAST_MERGE_ADAPTER}.`,
    );
  }
  const adapterAbs = join(SRC, FAST_MERGE_ADAPTER);
  for (const file of allSrcMjs()) {
    if (file === adapterAbs) continue;
    const src = readFileSync(file, 'utf8');
    for (const fn of SUBJECT_MECHANICS) {
      assert.ok(
        !new RegExp(`^(export )?(async )?function ${fn}\\b`, 'm').test(src),
        `${fn} must not be redefined in ${file} — it lives behind the github-pr subject adapter.`,
      );
    }
  }
});

// The raw octokit REST mechanics for PR labels / timeline / changed-files — the
// ones ARC-18 pulled out of the watcher — must only appear behind the adapter
// layer, never directly in the scheduler or a leaf phase module.
const RAW_SUBJECT_REST_CALLS = [
  'octokit.rest.issues.listLabelsOnIssue',
  'octokit.rest.issues.listEventsForTimeline',
  'octokit.rest.pulls.listFiles',
];

test('ARC-18 gate: raw PR label/timeline/changed-files REST calls live only under src/adapters/', () => {
  for (const file of allSrcMjs()) {
    if (file.includes(`${join(SRC, 'adapters')}`)) continue;
    const src = readFileSync(file, 'utf8');
    for (const call of RAW_SUBJECT_REST_CALLS) {
      assert.ok(
        !src.includes(call),
        `${file} must not call ${call} directly — the github-pr subject adapter owns that mechanic.`,
      );
    }
  }
});

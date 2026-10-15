import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGuardForbiddenPaths, guardOnlyRemedy, filterGuardForbiddenFindings } from '../src/guard-forbidden-paths.mjs';
import { parseBlockingFindingsSection, parseNonBlockingFindingsSection } from '../src/kernel/review-findings.mjs';

export const GUARDS = [{ check: 'Reject generated catalog edits', path: 'docs/CATALOG.md' }];
export const CARD = '- **Missing generated catalog**\n  - **File:** `docs/CATALOG.md`\n  - **Problem:** The added document is absent from the generated catalog.\n  - **Recommended fix:** Commit the regenerated `docs/CATALOG.md`.';
export const REVIEW = `## Summary\nDocumentation addition.\n\n## Blocking issues\n- None.\n\n## Non-blocking issues\n${CARD}\n\n## Verdict\nComment only\n`;

const workflow = 'jobs:\n  guards:\n    steps:\n      - name: Reject generated catalog edits\n        run: |\n          python3 scripts/check-generated-index-pr-diff.py --base BASE --head HEAD\n';

test('guard configuration comes from the repository base, with the workflow check name', async () => {
  const calls = [];
  const guards = await loadGuardForbiddenPaths({ repo: 'example/manual', baseRef: 'trusted-base',
    fetchFileImpl: async (repo, path, ref) => {
      calls.push({ repo, path, ref });
      return path.endsWith('.yml') ? workflow : 'GENERATED_PATHS = ("docs/CATALOG.md",)\n';
    } });
  assert.deepEqual(guards, GUARDS);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.repo === 'example/manual' && call.ref === 'trusted-base'));
});

test('unknown, computed, advisory or unreadable guards cannot suppress findings', async () => {
  for (const script of ['GENERATED_PATHS = compute_paths()', 'GENERATED_PATHS = ("../outside.md",)', 'GENERATED_PATHS = ("docs/CATALOG.md",) + EXTRA']) {
    assert.deepEqual(await loadGuardForbiddenPaths({ repo: 'example/manual', baseRef: 'base',
      fetchFileImpl: async (repo, path) => path.endsWith('.yml') ? workflow : script }), []);
  }
  assert.deepEqual(await loadGuardForbiddenPaths({ repo: 'example/manual', baseRef: 'base',
    fetchFileImpl: async () => { throw new Error('HTTP 404'); } }), []);
  assert.deepEqual(await loadGuardForbiddenPaths({ repo: 'example/manual', baseRef: 'base',
    fetchFileImpl: async () => workflow.replace('        run:', '        continue-on-error: true\n        run:') }), []);
  const warnings = [];
  assert.deepEqual(await loadGuardForbiddenPaths({ repo: 'example/manual', baseRef: 'base',
    fetchFileImpl: async () => { throw new Error('unavailable'); }, log: { warn: message => warnings.push(message) } }), []);
  assert.equal(warnings.length, 1);
});

test('only a complete guard-path edit remedy matches; unrelated and mixed fixes remain', () => {
  assert.deepEqual(guardOnlyRemedy({ recommendedFix: 'Commit the regenerated `docs/CATALOG.md`.' }, GUARDS), GUARDS);
  for (const recommendedFix of [
    'Update `docs/guide.md`.', 'Update the generator.', 'Do not commit `docs/CATALOG.md`.',
    'Commit `docs/CATALOG.md` and fix the generator.', 'Commit `docs/CATALOG.md` or update `docs/guide.md`.',
    'Update `docs/CATALOG.md.backup`.', 'Disable the guard for `docs/CATALOG.md`.',
    'Update `docs/CATALOG.md` and add tests.', '',
  ]) assert.equal(guardOnlyRemedy({ file: 'docs/CATALOG.md', recommendedFix }, GUARDS), null, recommendedFix);
});

test('filter drops solely forbidden findings once and retains normal remediation', () => {
  const logs = [];
  const mixed = REVIEW.replace(CARD, CARD + '\n' + CARD.replaceAll('Missing generated catalog', 'Broken link').replaceAll('docs/CATALOG.md', 'docs/guide.md'));
  const filtered = filterGuardForbiddenFindings(mixed, GUARDS, { log: { info: message => logs.push(message) } });
  assert.deepEqual(parseNonBlockingFindingsSection(filtered).map(finding => finding.title), ['Broken link']);
  assert.equal(logs.length, 1);
  assert.equal(filterGuardForbiddenFindings(filtered, GUARDS, { log: { info: message => logs.push(message) } }), filtered);
  assert.equal(logs.length, 1);
  assert.equal(filterGuardForbiddenFindings(REVIEW, [], { log: {} }), REVIEW);
});

test('filter repairs empty sections and verdicts, retains malformed and mixed-remedy cards', () => {
  const blocking = REVIEW.replace('## Blocking issues\n- None.', `## Blocking issues\n${CARD}`)
    .replace(`## Non-blocking issues\n${CARD}`, '## Non-blocking issues\n- None.').replace('Comment only', 'Request changes');
  const filtered = filterGuardForbiddenFindings(blocking, GUARDS, { log: {} });
  assert.deepEqual(parseBlockingFindingsSection(filtered), []);
  assert.match(filtered, /Comment only/);
  for (const body of [REVIEW.replace('Commit the regenerated `docs/CATALOG.md`.', 'Commit `docs/CATALOG.md` and fix the generator.'),
    REVIEW.replace('  - **Recommended fix:** Commit the regenerated `docs/CATALOG.md`.', '')]) {
    assert.equal(filterGuardForbiddenFindings(body, GUARDS, { log: {} }), body);
  }
});

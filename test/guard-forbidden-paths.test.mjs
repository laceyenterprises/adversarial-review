import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGuardForbiddenPaths, guardOnlyRemedy, filterGuardForbiddenFindings } from '../src/guard-forbidden-paths.mjs';
import { parseBlockingFindingsSection, parseNonBlockingFindingsSection } from '../src/kernel/review-findings.mjs';

const GUARDS = [{ check: 'Reject generated catalog edits', path: 'docs/CATALOG.md' }];
const CARD = '- **Missing generated catalog**\n  - **File:** `docs/CATALOG.md`\n  - **Problem:** The added document is absent from the generated catalog.\n  - **Recommended fix:** Commit the regenerated `docs/CATALOG.md`.';
const REVIEW = `## Summary\nDocumentation addition.\n\n## Blocking issues\n- None.\n\n## Non-blocking issues\n${CARD}\n\n## Verdict\nComment only\n`;

const workflow = 'jobs:\n  guards:\n    steps:\n      - name: Reject generated catalog edits\n        run: |\n          python3 scripts/check-generated-index-pr-diff.py --base BASE --head HEAD\n';

test('guard configuration comes from the repository base, with the workflow check name', async () => {
  const calls = [];
  const guards = await loadGuardForbiddenPaths({ repo: 'example/manual', baseRef: 'b'.repeat(40),
    fetchFileImpl: async (repo, path, ref) => {
      calls.push({ repo, path, ref });
      return path.endsWith('.yml') ? workflow : 'GENERATED_PATHS = ("docs/CATALOG.md",)\n';
    } });
  assert.deepEqual(guards, GUARDS);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.repo === 'example/manual' && call.ref === 'b'.repeat(40)));
});

test('unknown, computed, advisory or unreadable guards cannot suppress findings', async () => {
  for (const script of ['GENERATED_PATHS = compute_paths()', 'GENERATED_PATHS = ("../outside.md",)', 'GENERATED_PATHS = ("docs/CATALOG.md",) + EXTRA',
    'GENERATED_PATHS = ("docs/CATALOG.md")', 'GENERATED_PATHS = ("docs/CATALOG.md" "other.md")', 'GENERATED_PATHS = ("docs/CATALOG.md",]']) {
    assert.deepEqual(await loadGuardForbiddenPaths({ repo: 'example/manual', baseRef: 'b'.repeat(40),
      fetchFileImpl: async (repo, path) => path.endsWith('.yml') ? workflow : script }), []);
  }
  assert.deepEqual(await loadGuardForbiddenPaths({ repo: 'example/manual', baseRef: 'b'.repeat(40),
    fetchFileImpl: async () => { throw new Error('HTTP 404'); } }), []);
  assert.deepEqual(await loadGuardForbiddenPaths({ repo: 'example/manual', baseRef: 'b'.repeat(40),
    fetchFileImpl: async () => workflow.replace('        run:', '        continue-on-error: true\n        run:') }), []);
  const warnings = [];
  assert.deepEqual(await loadGuardForbiddenPaths({ repo: 'example/manual', baseRef: 'b'.repeat(40),
    fetchFileImpl: async () => { throw new Error('unavailable'); }, log: { warn: message => warnings.push(message) } }), []);
  assert.equal(warnings.length, 1);
});

test('base branch resolution pins both configuration reads to the same commit', async () => {
  const seen = [];
  const guards = await loadGuardForbiddenPaths({ repo: 'example/manual', baseRef: 'docs-base',
    resolveRefImpl: async (repo, ref) => { seen.push([repo, ref]); return 'c'.repeat(40); },
    fetchFileImpl: async (repo, path, ref) => {
      seen.push([repo, ref]);
      return path.endsWith('.yml') ? workflow : 'GENERATED_PATHS = ["docs/CATALOG.md"]\n';
    } });
  assert.deepEqual(guards, GUARDS);
  assert.deepEqual(seen, [['example/manual', 'docs-base'], ['example/manual', 'c'.repeat(40)], ['example/manual', 'c'.repeat(40)]]);
});

test('only a complete guard-path edit remedy matches; unrelated and mixed fixes remain', () => {
  assert.deepEqual(guardOnlyRemedy({ recommendedFix: 'Commit the regenerated `docs/CATALOG.md`.' }, GUARDS), GUARDS);
  for (const recommendedFix of [
    'Update `docs/guide.md`.', 'Update the generator.', 'Do not commit `docs/CATALOG.md`.',
    'Commit `docs/CATALOG.md` and fix the generator.', 'Commit `docs/CATALOG.md` or update `docs/guide.md`.',
    'Update `docs/CATALOG.md.backup`.', 'Disable the guard for `docs/CATALOG.md`.',
    'Update `docs/CATALOG.md` and add tests.', '',
    'Commit `docs/CATALOG.md` and update documentation.',
    'Commit `docs/CATALOG.md` with changes for the documentation.',
  ]) assert.equal(guardOnlyRemedy({ file: 'docs/CATALOG.md', recommendedFix }, GUARDS), null, recommendedFix);
});

test('plain paths, multiple guarded paths, H3 and flat-field cards are filtered', () => {
  assert.deepEqual(guardOnlyRemedy({ recommendedFix: 'Commit docs/CATALOG.md.' }, GUARDS), GUARDS);
  assert.deepEqual(guardOnlyRemedy({ recommendedFix: 'Regenerate and commit the generated `docs/CATALOG.md`.' }, GUARDS), GUARDS);
  const guards = [...GUARDS, { check: 'Reject generated catalog edits', path: 'plans/CATALOG.md' }];
  assert.equal(guardOnlyRemedy({ recommendedFix: 'Regenerate `docs/CATALOG.md` and `plans/CATALOG.md` and commit them.' }, guards).length, 2);
  for (const card of [CARD.replace('- **Missing generated catalog**', '### Missing generated catalog'),
    CARD.replaceAll('  - **', '- **')]) {
    const filtered = filterGuardForbiddenFindings(REVIEW.replace(CARD, card), GUARDS, { log: {} });
    assert.deepEqual(parseNonBlockingFindingsSection(filtered), []);
  }
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

test('quoted headings and unparsed extra remedies cannot suppress findings', () => {
  const quoted = `## Summary\n\`\`\`markdown\n${REVIEW}\`\`\`\n`;
  assert.equal(filterGuardForbiddenFindings(quoted, GUARDS, { log: {} }), quoted);
  const extra = REVIEW.replace(CARD, CARD + '\n  - Also fix the guide link.');
  assert.equal(filterGuardForbiddenFindings(extra, GUARDS, { log: {} }), extra);
  const duplicate = REVIEW.replace(CARD, CARD + '\n  - **Recommended fix:** Fix the guide link.');
  assert.equal(filterGuardForbiddenFindings(duplicate, GUARDS, { log: {} }), duplicate);
});

test('retaining an ordinary blocking finding preserves Request changes', () => {
  const blocking = REVIEW.replace('## Blocking issues\n- None.', `## Blocking issues\n${CARD}\n${CARD.replaceAll('Missing generated catalog', 'Broken guide').replaceAll('docs/CATALOG.md', 'docs/guide.md')}`)
    .replace(`## Non-blocking issues\n${CARD}`, '## Non-blocking issues\n- None.').replace('Comment only', 'Request changes');
  const filtered = filterGuardForbiddenFindings(blocking, GUARDS, { log: {} });
  assert.deepEqual(parseBlockingFindingsSection(filtered).map(finding => finding.title), ['Broken guide']);
  assert.match(filtered, /Request changes/);
});

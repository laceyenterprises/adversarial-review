/**
 * Code-pr spec-coverage rule owned by the GitHub PR subject adapter.
 *
 * @typedef {import('../../../kernel/contracts.d.ts').SubjectContent} SubjectContent
 */

const SPEC_TOUCH_RULES = [
  {
    id: 'worker-pool-python',
    label: 'public Python signature changes in worker-pool dispatch code',
    pathPattern: /^modules\/worker-pool\/lib\/python\/.+\.py$/,
    specPaths: ['projects/worker-pool/SPEC.md'],
    promptPathText: '`modules/worker-pool/lib/python/**/*.py`',
    specPathText: '`projects/worker-pool/SPEC.md`',
    kind: 'python-signature',
  },
  {
    id: 'main-catchup-python',
    label: 'public Python signature changes in main-catchup',
    pathPattern: /^modules\/main-catchup\/lib\/python\/.+\.py$/,
    specPaths: ['projects/main-catchup/SPEC.md'],
    promptPathText: '`modules/main-catchup/lib/python/**/*.py`',
    specPathText: '`projects/main-catchup/SPEC.md`',
    kind: 'python-signature',
  },
  {
    id: 'session-ledger-python',
    label: 'public Python signature changes in session-ledger',
    pathPattern: /^platform\/session-ledger\/src\/session_ledger\/.+\.py$/,
    specPaths: ['docs/SPEC-session-ledger-control-plane.md'],
    promptPathText: '`platform/session-ledger/src/session_ledger/**/*.py`',
    specPathText: '`docs/SPEC-session-ledger-control-plane.md`',
    kind: 'python-signature',
  },
  {
    id: 'session-ledger-migrations',
    label: 'session-ledger SQL migrations',
    pathPattern: /^platform\/session-ledger\/src\/session_ledger\/migrations\/.+\.sql$/,
    specPaths: ['docs/SPEC-session-ledger-control-plane.md'],
    promptPathText: '`platform/session-ledger/src/session_ledger/migrations/*.sql`',
    specPathText: '`docs/SPEC-session-ledger-control-plane.md`',
    kind: 'any-change',
  },
  {
    id: 'worker-pool-hq-cli',
    label: 'hq CLI surfaces',
    pathPattern: /^modules\/worker-pool\/(?:bin\/hq|lib\/hq-[^/]+\.sh)$/,
    specPaths: ['projects/worker-pool/SPEC.md'],
    promptPathText: '`modules/worker-pool/bin/hq` and `modules/worker-pool/lib/hq-*.sh`',
    specPathText: '`projects/worker-pool/SPEC.md`',
    kind: 'hq-cli-surface',
  },
];

function parseChangedFiles(diffText) {
  const files = [];
  let current = null;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (match) {
        current = { oldPath: match[1], path: match[2], lines: [] };
        files.push(current);
      } else {
        current = null;
      }
      continue;
    }
    if (current) current.lines.push(line);
  }
  return files;
}

function isPublicPythonSignatureChange(lines) {
  let sawRemoval = false;
  for (const line of lines) {
    if (!line || line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) continue;
    if (line.startsWith('-def ') && !line.startsWith('-def _')) {
      sawRemoval = true;
      continue;
    }
    if (line.startsWith('+def ') && !line.startsWith('+def _') && sawRemoval) {
      return true;
    }
  }
  return false;
}

function isHqCliSurfaceChange(lines) {
  return lines.some((line) => {
    if (!line.startsWith('+') || line.startsWith('+++')) return false;
    return /(^\+\s*--[a-z0-9-]+)|(^\+\s*[a-z0-9_-]+\))|(\badd_parser\()/.test(line);
  });
}

function touchedSpecPaths(files) {
  return new Set(files.map((file) => file.path).filter((path) => /(^|\/)SPEC.*\.md$/.test(path)));
}

function evaluateSpecTouch(diffText) {
  const files = parseChangedFiles(diffText);
  const touchedSpecs = touchedSpecPaths(files);
  const findings = [];

  for (const file of files) {
    for (const rule of SPEC_TOUCH_RULES) {
      if (!rule.pathPattern.test(file.path)) continue;

      const contractChanged = rule.kind === 'any-change'
        ? file.lines.some((line) => (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---'))
        : rule.kind === 'python-signature'
          ? isPublicPythonSignatureChange(file.lines)
          : isHqCliSurfaceChange(file.lines);

      if (!contractChanged) continue;

      const covered = rule.specPaths.some((specPath) => touchedSpecs.has(specPath));
      findings.push({
        ruleId: rule.id,
        path: file.path,
        label: rule.label,
        specPaths: rule.specPaths,
        covered,
      });
    }
  }

  return findings;
}

function buildSpecTouchPromptSection() {
  const mappingLines = SPEC_TOUCH_RULES
    .map((rule) => `  - ${rule.promptPathText} -> ${rule.specPathText}`)
    .join('\n');

  return [
    'Spec coverage check:',
    '- Treat silent spec drift as a blocking issue.',
    '- On the final-round lenient pass, keep this rule blocking when it finds a real public-contract change without its governing SPEC touch; that is broken external-contract drift, not a documentation nit.',
    '- If the PR diff includes any of the following public-contract changes and the diff does NOT touch the mapped governing SPEC, file a blocking issue:',
    mappingLines,
    '- Trigger only on public contract changes:',
    '  - public Python function or method signature changes in the mapped Python ownership paths above (parameter lists or return types only; ignore private `_helpers` and cosmetic docstring edits)',
    '  - new or altered SQL migrations in `platform/session-ledger/src/session_ledger/migrations/*.sql`',
    '  - new or altered `hq` CLI subcommands or flags in `modules/worker-pool/bin/hq` or `modules/worker-pool/lib/hq-*.sh`',
    '- Use this blocking-issue message template when the rule triggers:',
    '  - `Contract changed without spec update. The diff modifies {thing} in {path}, but {specPath} was not touched. Either update the governing spec to match, or revert the contract change. Spec-as-source-of-truth is load-bearing; silent drift is the dominant maintenance risk from the 2026-05-04 operator retrospective.`',
    '- Do NOT trigger this rule for private or internal implementation changes that do not alter a public contract.',
    '- Do NOT trigger this rule when the mapped governing SPEC is touched in the same PR.',
  ].join('\n');
}

export {
  SPEC_TOUCH_RULES,
  buildSpecTouchPromptSection,
  evaluateSpecTouch,
};

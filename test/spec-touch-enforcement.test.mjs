import test from 'node:test';
import assert from 'node:assert/strict';

import { ADVERSARIAL_PROMPT } from '../src/reviewer.mjs';

function renderPromptWithDiff(diff) {
  return `${ADVERSARIAL_PROMPT}\n\n---\n\nHere is the PR diff to review:\n\n\`\`\`diff\n${diff}\n\`\`\``;
}

test('mock PR with public function signature change and no SPEC touch is covered by the blocking spec-touch rule', () => {
  const prompt = renderPromptWithDiff(`
diff --git a/modules/example/lib/python/example/service.py b/modules/example/lib/python/example/service.py
@@
-def fetch_widget(widget_id: str) -> Widget:
+def fetch_widget(widget_id: str, include_deleted: bool = False) -> Widget:
`);

  assert.match(prompt, /Treat silent spec drift as a blocking issue\./);
  assert.match(prompt, /Public function or method signature changes in `modules\/\*\/lib\/python\/\*\*\/\*\.py`/);
  assert.match(prompt, /Contract changed without spec update\./);
});

test('mock PR with the same public contract change plus SPEC touch is explicitly exempted from the blocking spec-touch rule', () => {
  const prompt = renderPromptWithDiff(`
diff --git a/modules/example/lib/python/example/service.py b/modules/example/lib/python/example/service.py
@@
-def fetch_widget(widget_id: str) -> Widget:
+def fetch_widget(widget_id: str, include_deleted: bool = False) -> Widget:
diff --git a/projects/example/SPEC.md b/projects/example/SPEC.md
@@
+- Document fetch_widget include_deleted semantics.
`);

  assert.match(prompt, /Do NOT trigger this rule when the relevant `projects\/<project>\/SPEC\.md` is touched in the same PR\./);
});

test('mock PR with private or internal function change and no SPEC touch is explicitly excluded', () => {
  const prompt = renderPromptWithDiff(`
diff --git a/modules/example/lib/python/example/service.py b/modules/example/lib/python/example/service.py
@@
-def _normalize_widget(raw: dict[str, object]) -> Widget:
+def _normalize_widget(raw: dict[str, object], cache: Cache | None = None) -> Widget:
`);

  assert.match(prompt, /Do NOT trigger this rule for private or internal implementation changes that do not alter a public contract\./);
});

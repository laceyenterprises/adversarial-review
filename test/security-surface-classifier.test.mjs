import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SECURITY_TRIGGER,
  classifySecuritySurface,
  manifestEcosystemForPath,
  sensitiveCategoriesForPath,
} from '../src/security-surface-classifier.mjs';
import { isUnroutableBotAuthor } from '../src/pollonce-phases.mjs';

// ASR-02. The security-surface classifier answers one question — does this PR
// need a security review, and why — from PR metadata alone. Three independent
// triggers, unioned, each reported as its own reason so ASR-05 can specialise
// the review on it.
//
// Background (SPEC.md): `adversarial-review#909` and `#910` sat unreviewed for
// 14 hours because a bot-authored PR carries no worker-class title prefix and so
// classified terminal-unroutable. `#909` was a major bump of the native SQLite
// driver behind reviews.db.

const triggerOf = (result, trigger) => result.reasons.find((r) => r.trigger === trigger);
const triggers = (result) => result.reasons.map((r) => r.trigger);

// ---------------------------------------------------------------------------
// Trigger 1 — bot / dependency author
// ---------------------------------------------------------------------------

test('a known dependency bot triggers on author alone', () => {
  for (const author of [
    'dependabot[bot]',
    'Dependabot[bot]',
    'dependabot-preview[bot]',
    'renovate[bot]',
    'github-actions[bot]',
  ]) {
    const result = classifySecuritySurface({ author, changedFiles: [] });
    assert.equal(result.needsReview, true, `${author} must route`);
    assert.deepEqual(triggers(result), [SECURITY_TRIGGER.BOT_AUTHOR]);
  }
});

test('the app/<name> rendering triggers too', () => {
  // `gh pr view --json author` renders a GitHub App author this way.
  const result = classifySecuritySurface({ author: 'app/dependabot', changedFiles: [] });
  assert.equal(result.needsReview, true);
  assert.deepEqual(triggerOf(result, SECURITY_TRIGGER.BOT_AUTHOR), {
    trigger: 'bot-author',
    author: 'app/dependabot',
  });
});

test('a bare `dependabot` is an ordinary account and does NOT trigger', () => {
  // The `[bot]` suffix is synthesised ONLY for the `app/` prefixed form. An
  // earlier version of this logic matched any author and was caught by its own
  // test; this is that guard, restated at the classifier boundary.
  const result = classifySecuritySurface({ author: 'dependabot', changedFiles: ['README.md'] });
  assert.equal(result.needsReview, false);
  assert.deepEqual(result.reasons, []);
});

test('lookalike and human authors do NOT trigger', () => {
  for (const author of [
    'not-dependabot[bot]',
    'renovate',
    'VirtualPaul',
    'lacey-claude-agent',
    'app/lacey-claude-agent',
    '',
    null,
    undefined,
  ]) {
    const result = classifySecuritySurface({ author, changedFiles: ['README.md'] });
    assert.equal(result.needsReview, false, `${author} must not route on author`);
  }
});

test('the author predicate is the one pollonce-phases uses, not a copy', () => {
  // The classifier must not carry its own bot list: a login added to one and not
  // the other is a PR that routes nowhere. Both surfaces resolve to the same
  // `bot-author.mjs` definition, so they agree by construction.
  for (const author of ['dependabot[bot]', 'app/renovate', 'dependabot', 'VirtualPaul', '']) {
    assert.equal(
      classifySecuritySurface({ author }).needsReview,
      isUnroutableBotAuthor(author),
      `disagreement on ${author}`,
    );
  }
});

test('the author is read from an object login too', () => {
  // `gh pr view --json author` returns `{ login, is_bot }`.
  const result = classifySecuritySurface({ author: { login: 'app/dependabot' } });
  assert.equal(result.needsReview, true);
  assert.equal(triggerOf(result, SECURITY_TRIGGER.BOT_AUTHOR).author, 'app/dependabot');
});

test('a docs-only bot PR still triggers on author', () => {
  // The author IS the routing signal (SPEC.md, "Why the author is enough to
  // route"). Nothing about the diff can cancel it.
  const result = classifySecuritySurface({
    author: 'dependabot[bot]',
    changedFiles: ['README.md', 'docs/CHANGELOG.md'],
  });
  assert.equal(result.needsReview, true);
  assert.deepEqual(triggers(result), [SECURITY_TRIGGER.BOT_AUTHOR]);
});

// ---------------------------------------------------------------------------
// Trigger 2 — security-sensitive paths
// ---------------------------------------------------------------------------

test('sensitive paths are categorised', () => {
  const cases = [
    ['src/agy-reviewer-auth.mjs', 'auth'],
    ['src/codex-oauth-responses.mjs', 'auth'],
    ['frontend/server/src/routes/login.mjs', 'auth'],
    ['config/permissions.yaml', 'auth'],
    ['deploy/rbac.yaml', 'auth'],
    ['frontend/server/src/broker/secrets.mjs', 'secrets'],
    ['src/credentials-provider.mjs', 'secrets'],
    ['frontend/server/src/broker/token-broker.mjs', 'secrets'],
    ['config/keychain-probe.sh', 'secrets'],
    ['deploy/tls/server.pem', 'secrets'],
    ['deploy/tls/server.key', 'secrets'],
    ['.keystore', 'secrets'],
    ['.env', 'secrets'],
    ['.env.production', 'secrets'],
    ['ops/.npmrc', 'secrets'],
    ['home/.ssh/config', 'secrets'],
    ['home/.ssh/authorized_keys', 'auth'],
    ['sandbox/worker.sb', 'sandbox-profile'],
    ['profiles/reviewer-sandbox.sb', 'sandbox-profile'],
    ['app/Runner.entitlements', 'entitlements'],
    ['src/hq-worker-classes.mjs', 'worker-class'],
    ['modules/worker-pool/worker_class.yaml', 'worker-class'],
    ['etc/sudoers', 'sudoers'],
    ['etc/sudoers.d/agent-os', 'sudoers'],
    ['launchd/ai.laceyenterprises.adversarial-watcher.airlock.plist', 'launchd'],
  ];
  for (const [path, expected] of cases) {
    const categories = sensitiveCategoriesForPath(path);
    assert.ok(
      categories.includes(expected),
      `${path} should be ${expected}, got [${categories}]`,
    );
    const result = classifySecuritySurface({ author: 'VirtualPaul', changedFiles: [path] });
    assert.equal(result.needsReview, true, `${path} must route`);
    assert.deepEqual(triggers(result), [SECURITY_TRIGGER.SENSITIVE_PATH]);
  }
});

test('"author" and "authority" are not "auth"', () => {
  // The single highest-value false-positive guard in this module. A substring
  // match on `auth` fires on four live paths in this repo, none of which has
  // anything to do with authentication — and a trigger that fires on the word
  // "author" in an author-tagging, merge-authority codebase is a trigger
  // operators learn to ignore.
  for (const path of [
    'AUTHOR_TAGGING.md',
    'src/pr-author.mjs',
    'src/ama/rebase-authority.mjs',
    'src/ama/reviewer-authority.mjs',
    'bin/ama-rebase-authority.mjs',
    'docs/SPEC-merge-authority-v2.md',
    'src/authored-commits.mjs',
  ]) {
    assert.deepEqual(sensitiveCategoriesForPath(path), [], `${path} must not be sensitive`);
  }
});

test('ordinary paths are not sensitive', () => {
  for (const path of [
    'README.md',
    'src/watcher.mjs',
    'src/reviewer-session-registry.mjs',
    'src/session-ledger-read-adapter.mjs',
    'test/watcher-claim-loop.test.mjs',
    'src/kernel/verdict.mjs',
    'frontend/src/components/Dashboard.tsx',
    'src/env-setup.mjs',
    'docs/RUNBOOK-ama-closure.md',
  ]) {
    assert.deepEqual(sensitiveCategoriesForPath(path), [], `${path} must not be sensitive`);
  }
});

test('a path sensitive more than one way reports every category', () => {
  // ASR-05 reads a plist differently from an auth module; a file that is both
  // must not lose one of them to first-match-wins.
  assert.deepEqual(
    sensitiveCategoriesForPath('launchd/ai.laceyenterprises.agy-auth.plist'),
    ['auth', 'launchd'],
  );
});

test('the sensitive-path reason carries per-file categories and a rollup', () => {
  const result = classifySecuritySurface({
    author: 'VirtualPaul',
    changedFiles: ['src/agy-reviewer-auth.mjs', 'sandbox/worker.sb', 'README.md'],
  });
  assert.deepEqual(triggerOf(result, SECURITY_TRIGGER.SENSITIVE_PATH), {
    trigger: 'sensitive-path',
    categories: ['auth', 'sandbox-profile'],
    matches: [
      { path: 'src/agy-reviewer-auth.mjs', categories: ['auth'] },
      { path: 'sandbox/worker.sb', categories: ['sandbox-profile'] },
    ],
  });
});

test('sensitive paths trigger regardless of author', () => {
  for (const author of ['VirtualPaul', 'lacey-claude-agent', 'dependabot', '']) {
    const result = classifySecuritySurface({ author, changedFiles: ['etc/sudoers'] });
    assert.equal(result.needsReview, true, `sudoers must route for ${author}`);
  }
});

// ---------------------------------------------------------------------------
// Trigger 3 — dependency manifests and lockfiles
// ---------------------------------------------------------------------------

test('every ecosystem in the SPEC manifest table is recognised', () => {
  const cases = [
    ['package.json', 'npm'],
    ['package-lock.json', 'npm'],
    ['npm-shrinkwrap.json', 'npm'],
    ['yarn.lock', 'npm'],
    ['pnpm-lock.yaml', 'npm'],
    ['requirements.txt', 'python'],
    ['requirements-dev.txt', 'python'],
    ['requirements/base.txt', 'python'],
    ['requirements/prod.txt', 'python'],
    ['constraints.txt', 'python'],
    ['constraints-prod.txt', 'python'],
    ['pyproject.toml', 'python'],
    ['poetry.lock', 'python'],
    ['Pipfile', 'python'],
    ['Pipfile.lock', 'python'],
    ['setup.py', 'python'],
    ['setup.cfg', 'python'],
    ['go.mod', 'go'],
    ['go.sum', 'go'],
    ['Cargo.toml', 'rust'],
    ['Cargo.lock', 'rust'],
    ['Dockerfile', 'container'],
    ['Dockerfile.prod', 'container'],
    ['docker-compose.yml', 'container'],
    ['docker-compose.override.yaml', 'container'],
    ['dev/compose.yml', 'container'],
    ['.github/workflows/test.yml', 'ci'],
    ['.gitmodules', 'repo'],
  ];
  for (const [path, ecosystem] of cases) {
    assert.equal(manifestEcosystemForPath(path), ecosystem, `${path} should be ${ecosystem}`);
  }
});

test('manifests are recognised at any depth', () => {
  // A vendored `frontend/server/package.json` is as much a dependency edit as
  // the root one.
  assert.equal(manifestEcosystemForPath('frontend/server/package.json'), 'npm');
  assert.equal(manifestEcosystemForPath('tools/adversarial-review/go.sum'), 'go');
  assert.equal(manifestEcosystemForPath('services/api/Dockerfile'), 'container');
});

test('a workflow written .yaml is a manifest too', () => {
  // GitHub honours both extensions. Matching only the `.yml` that SPEC.md
  // happens to write would leave a real hole — a `.yaml` workflow pinning a
  // third-party action at a mutable ref would route as ordinary code.
  assert.equal(manifestEcosystemForPath('.github/workflows/deploy.yaml'), 'ci');
});

test('only the live repo-root workflow directory counts as CI', () => {
  // GitHub runs `.github/workflows/` at the repo root and nowhere else, so a
  // nested copy is an inert fixture, not a supply-chain surface.
  assert.equal(manifestEcosystemForPath('test/fixtures/.github/workflows/test.yml'), null);
  assert.equal(manifestEcosystemForPath('.github/workflows/nested/test.yml'), null);
  assert.equal(manifestEcosystemForPath('.github/ISSUE_TEMPLATE/bug.yml'), null);
});

test('non-manifest lookalikes are not manifests', () => {
  for (const path of [
    'src/package-lock-parser.mjs',
    'docs/package.json.md',
    'test/fixtures/go.mod.txt',
    'config.yaml',
    'requirements.md',
    'src/setup.mjs',
  ]) {
    assert.equal(manifestEcosystemForPath(path), null, `${path} must not be a manifest`);
  }
});

test('a manifest change by a human triggers', () => {
  // The trigger is author-independent, and that is its whole point: the
  // dependency arrives with the same privileges whether dependabot or a person
  // introduced it.
  const result = classifySecuritySurface({
    author: 'VirtualPaul',
    changedFiles: ['package.json', 'package-lock.json', 'src/watcher.mjs'],
  });
  assert.equal(result.needsReview, true);
  assert.deepEqual(triggerOf(result, SECURITY_TRIGGER.MANIFEST_CHANGE), {
    trigger: 'manifest-change',
    ecosystems: ['npm'],
    matches: [
      { path: 'package.json', ecosystem: 'npm' },
      { path: 'package-lock.json', ecosystem: 'npm' },
    ],
  });
});

test('a multi-ecosystem manifest change reports every ecosystem, sorted', () => {
  const result = classifySecuritySurface({
    author: 'VirtualPaul',
    changedFiles: ['go.mod', 'package.json', '.gitmodules', 'Cargo.lock'],
  });
  assert.deepEqual(
    triggerOf(result, SECURITY_TRIGGER.MANIFEST_CHANGE).ecosystems,
    ['go', 'npm', 'repo', 'rust'],
  );
});

// ---------------------------------------------------------------------------
// Union, ordering, and shape
// ---------------------------------------------------------------------------

test('the triggers union — all three at once, each reported separately', () => {
  // `bot-author` and `manifest-change` must stay distinguishable: ASR-05 reads a
  // lockfile diff differently from an auth change, and collapsing them to a
  // boolean would erase the specialisation.
  const result = classifySecuritySurface({
    author: 'app/dependabot',
    changedFiles: ['package-lock.json', 'src/agy-reviewer-auth.mjs'],
  });
  assert.equal(result.needsReview, true);
  assert.deepEqual(triggers(result), [
    SECURITY_TRIGGER.BOT_AUTHOR,
    SECURITY_TRIGGER.SENSITIVE_PATH,
    SECURITY_TRIGGER.MANIFEST_CHANGE,
  ]);
});

test('reason order is stable regardless of changed-file order', () => {
  const a = classifySecuritySurface({
    author: 'app/renovate',
    changedFiles: ['src/agy-reviewer-auth.mjs', 'go.mod'],
  });
  const b = classifySecuritySurface({
    author: 'app/renovate',
    changedFiles: ['go.mod', 'src/agy-reviewer-auth.mjs'],
  });
  assert.deepEqual(triggers(a), triggers(b));
});

test('one file can raise two different triggers', () => {
  // `.github/workflows/auth-check.yml` is both a CI manifest and an auth path.
  const result = classifySecuritySurface({
    author: 'VirtualPaul',
    changedFiles: ['.github/workflows/auth-check.yml'],
  });
  assert.deepEqual(triggers(result), [
    SECURITY_TRIGGER.SENSITIVE_PATH,
    SECURITY_TRIGGER.MANIFEST_CHANGE,
  ]);
});

test('the classifier returns triggers, never verdicts', () => {
  // Severity belongs to ASR-05 and the blocking threshold to ASR-06. A router
  // that pre-judges is a router that suppresses, so no reason may carry a
  // severity, a verdict, or a blocking decision.
  const result = classifySecuritySurface({
    author: 'app/dependabot',
    changedFiles: ['package-lock.json', 'etc/sudoers'],
  });
  const forbidden = ['severity', 'verdict', 'blocking', 'blocks', 'risk', 'score'];
  for (const reason of result.reasons) {
    for (const field of forbidden) {
      assert.equal(field in reason, false, `reason ${reason.trigger} must not carry ${field}`);
    }
  }
});

test('a clean human PR needs no security review', () => {
  const result = classifySecuritySurface({
    author: 'lacey-claude-agent',
    changedFiles: ['src/watcher.mjs', 'test/watcher-claim-loop.test.mjs', 'README.md'],
  });
  assert.deepEqual(result, { needsReview: false, reasons: [] });
});

// ---------------------------------------------------------------------------
// Input tolerance — the classifier is pure, so bad input must not throw
// ---------------------------------------------------------------------------

test('changed-file entries may be strings or GitHub file objects', () => {
  // REST returns `{ filename }`; `gh pr view --json files` returns `{ path }`.
  const expected = [{ path: 'package.json', ecosystem: 'npm' }];
  for (const changedFiles of [
    ['package.json'],
    [{ filename: 'package.json' }],
    [{ path: 'package.json' }],
  ]) {
    const result = classifySecuritySurface({ author: 'VirtualPaul', changedFiles });
    assert.deepEqual(triggerOf(result, SECURITY_TRIGGER.MANIFEST_CHANGE).matches, expected);
  }
});

test('paths are normalised before matching', () => {
  for (const path of ['./package.json', '/package.json', '  package.json  ']) {
    assert.equal(manifestEcosystemForPath(path), 'npm', `${path} should normalise`);
  }
});

test('duplicate changed-file entries are reported once', () => {
  const result = classifySecuritySurface({
    author: 'VirtualPaul',
    changedFiles: ['package.json', './package.json', { path: 'package.json' }],
  });
  assert.deepEqual(triggerOf(result, SECURITY_TRIGGER.MANIFEST_CHANGE).matches, [
    { path: 'package.json', ecosystem: 'npm' },
  ]);
});

test('missing, empty, and malformed input yields no review rather than a throw', () => {
  assert.deepEqual(classifySecuritySurface(), { needsReview: false, reasons: [] });
  assert.deepEqual(classifySecuritySurface({}), { needsReview: false, reasons: [] });
  assert.deepEqual(
    classifySecuritySurface({ author: null, changedFiles: null }),
    { needsReview: false, reasons: [] },
  );
  assert.deepEqual(
    classifySecuritySurface({ author: 42, changedFiles: [null, undefined, '', '   ', {}, 7] }),
    { needsReview: false, reasons: [] },
  );
  assert.deepEqual(sensitiveCategoriesForPath(undefined), []);
  assert.equal(manifestEcosystemForPath(undefined), null);
});

test('the classifier does no I/O', async () => {
  // The hard constraint: importing it must not open reviews.db, read config, or
  // touch the network. `pollonce-phases.mjs` does all three transitively, which
  // is why the shared bot-author predicate lives in its own leaf module.
  const source = await import('node:fs').then(({ readFileSync }) =>
    readFileSync(new URL('../src/security-surface-classifier.mjs', import.meta.url), 'utf8'));
  const imports = [...source.matchAll(/^import\s.*?from\s+'([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['./bot-author.mjs']);
  for (const banned of ['node:fs', 'node:child_process', 'node:http', 'better-sqlite3', 'Date.now']) {
    assert.equal(source.includes(banned), false, `classifier must not reference ${banned}`);
  }
});

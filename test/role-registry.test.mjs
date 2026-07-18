import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentOSConfigError, loadConfig } from '../src/config-loader.mjs';
import {
  ROLE_TASK_KINDS,
  ROLE_COMPLETION_SHAPES,
  validateRoleDefinition,
  validateRoleRegistry,
  loadRoleRegistry,
  validateStartupRoleRegistry,
} from '../src/role-registry.mjs';
import {
  resolvePublishedWorkerClasses,
  publishedWorkerClassSet,
  WorkerClassRosterError,
  __testing as hqTesting,
} from '../src/hq-worker-classes.mjs';

const HQ_CLASSES = ['claude-code', 'codex', 'gemini', 'clio-agent', 'merge-agent'];
const ROSTER = new Set(HQ_CLASSES);

function tmp() {
  return mkdtempSync(join(tmpdir(), 'arc12-registry-'));
}

function writeCascade({ top = 'version: 1\n', module: moduleBody } = {}) {
  const dir = tmp();
  const topPath = join(dir, 'config.yaml');
  const modulePath = join(dir, 'module.yaml');
  writeFileSync(topPath, top, 'utf8');
  writeFileSync(modulePath, moduleBody ?? '', 'utf8');
  return { dir, topPath, modulePath };
}

const GOOD_ROLE = {
  promptSet: 'code-pr',
  workerClass: 'codex',
  taskKind: 'review',
  completionShape: 'decision-only',
};

// ---------------------------------------------------------------------------
// validateRoleDefinition
// ---------------------------------------------------------------------------

test('validateRoleDefinition accepts a well-formed worker-class role', () => {
  const def = validateRoleDefinition('r', GOOD_ROLE, { workerClassSet: ROSTER });
  assert.deepEqual(def, {
    id: 'r',
    promptSet: 'code-pr',
    workerClass: 'codex',
    taskKind: 'review',
    completionShape: 'decision-only',
  });
});

test('validateRoleDefinition accepts a persona role without consulting the roster', () => {
  const def = validateRoleDefinition('r', {
    promptSet: 'code-pr',
    persona: 'security-persona',
    taskKind: 'review',
    completionShape: 'decision-only',
  }, { workerClassSet: null });
  assert.equal(def.persona, 'security-persona');
  assert.equal(def.workerClass, undefined);
});

test('validateRoleDefinition rejects a missing promptSet', () => {
  assert.throws(
    () => validateRoleDefinition('r', { ...GOOD_ROLE, promptSet: '' }, { workerClassSet: ROSTER }),
    (err) => err instanceof AgentOSConfigError && /promptSet is required/.test(err.message),
  );
});

test('validateRoleDefinition rejects declaring both workerClass and persona', () => {
  assert.throws(
    () => validateRoleDefinition('r', { ...GOOD_ROLE, persona: 'p' }, { workerClassSet: ROSTER }),
    /exactly one of workerClass \/ persona, not both/,
  );
});

test('validateRoleDefinition rejects declaring neither workerClass nor persona', () => {
  assert.throws(
    () => validateRoleDefinition('r', { promptSet: 'x', taskKind: 'review', completionShape: 'decision-only' }, { workerClassSet: ROSTER }),
    /must declare exactly one of workerClass \/ persona/,
  );
});

test('validateRoleDefinition enforces the taskKind and completionShape enums', () => {
  assert.throws(
    () => validateRoleDefinition('r', { ...GOOD_ROLE, taskKind: 'audit' }, { workerClassSet: ROSTER }),
    (err) => new RegExp(`taskKind must be one of: ${ROLE_TASK_KINDS.join(', ')}`).test(err.message),
  );
  assert.throws(
    () => validateRoleDefinition('r', { ...GOOD_ROLE, completionShape: 'pr-comment' }, { workerClassSet: ROSTER }),
    (err) => new RegExp(`completionShape must be one of: ${ROLE_COMPLETION_SHAPES.join(', ')}`).test(err.message),
  );
});

// This is the ticket's mandatory test: an unknown worker class fails at load.
test('validateRoleDefinition rejects a worker class not in the hq-published roster', () => {
  assert.throws(
    () => validateRoleDefinition('r', { ...GOOD_ROLE, workerClass: 'not-a-real-class' }, { workerClassSet: ROSTER }),
    (err) =>
      err instanceof AgentOSConfigError &&
      /not in the hq-published/.test(err.message) &&
      err.key === 'roles.registry.r.workerClass',
  );
});

test('validateRoleDefinition refuses to validate a worker class when the roster is unavailable', () => {
  // A null roster must never silently pass an unvalidated class (the hardcoded-
  // list anti-pattern the ticket forbids).
  assert.throws(
    () => validateRoleDefinition('r', GOOD_ROLE, { workerClassSet: null }),
    /roster is unavailable/,
  );
});

// ---------------------------------------------------------------------------
// validateRoleRegistry
// ---------------------------------------------------------------------------

test('validateRoleRegistry validates every entry and normalizes routing', () => {
  const registry = validateRoleRegistry(
    {
      'code-quality-reviewer': { promptSet: 'code-pr', workerClass: 'gemini', taskKind: 'review', completionShape: 'decision-only' },
      remediator: { promptSet: 'code-pr', workerClass: 'codex', taskKind: 'remediation', completionShape: 'branch-push' },
    },
    { workerClassSet: ROSTER, neverReviewOwnBuilderClass: false },
  );
  assert.deepEqual(Object.keys(registry.roles), ['code-quality-reviewer', 'remediator']);
  assert.equal(registry.routing.neverReviewOwnBuilderClass, false);
});

test('validateRoleRegistry accepts an empty registry without a roster', () => {
  const registry = validateRoleRegistry({}, { workerClassSet: null });
  assert.deepEqual(registry.roles, {});
  assert.equal(registry.routing.neverReviewOwnBuilderClass, true);
});

test('validateRoleRegistry lazily resolves the roster only when a workerClass role exists', () => {
  let resolved = 0;
  const resolveWorkerClassSet = () => {
    resolved += 1;
    return ROSTER;
  };
  // Persona-only registry: roster never resolved.
  validateRoleRegistry(
    { sec: { promptSet: 'x', persona: 'p', taskKind: 'review', completionShape: 'decision-only' } },
    { resolveWorkerClassSet },
  );
  assert.equal(resolved, 0);
  // Worker-class registry: roster resolved exactly once.
  validateRoleRegistry({ r: GOOD_ROLE }, { resolveWorkerClassSet });
  assert.equal(resolved, 1);
});

// ---------------------------------------------------------------------------
// Config-loader schema tolerance + loadRoleRegistry cascade
// ---------------------------------------------------------------------------

test('the config loader accepts the roles.registry subtree and routing flag', () => {
  const { topPath, modulePath } = writeCascade({
    module: [
      'roles:',
      '  registry:',
      '    security-reviewer:',
      '      promptSet: code-pr-security',
      '      workerClass: claude-code',
      '      taskKind: review',
      '      completionShape: decision-only',
      '  routing:',
      '    never-review-own-builder-class: false',
      '',
    ].join('\n'),
  });
  const cfg = loadConfig({ topPath, modulePaths: [modulePath], env: {} });
  const entry = cfg.get('roles.registry')['security-reviewer'];
  assert.equal(entry.workerClass, 'claude-code');
  assert.equal(cfg.get('roles.routing.never-review-own-builder-class'), false);
});

test('the config loader rejects an unknown key inside a role entry (typo protection)', () => {
  const { topPath, modulePath } = writeCascade({
    module: [
      'roles:',
      '  registry:',
      '    r:',
      '      promptSet: code-pr',
      '      workerclass: codex', // wrong case → unknown key
      '      taskKind: review',
      '      completionShape: decision-only',
      '',
    ].join('\n'),
  });
  assert.throws(
    () => loadConfig({ topPath, modulePaths: [modulePath], env: {} }),
    /unknown key/,
  );
});

test('loadRoleRegistry validates through the cascade with an injected roster', () => {
  const { topPath, modulePath } = writeCascade({
    module: [
      'roles:',
      '  registry:',
      '    code-quality-reviewer:',
      '      promptSet: code-pr',
      '      workerClass: gemini',
      '      taskKind: review',
      '      completionShape: decision-only',
      '',
    ].join('\n'),
  });
  const registry = loadRoleRegistry({
    env: {},
    topPath,
    modulePaths: [modulePath],
    workerClasses: HQ_CLASSES,
  });
  assert.equal(registry.roles['code-quality-reviewer'].workerClass, 'gemini');
});

test('validateStartupRoleRegistry surfaces an unknown worker class from config', () => {
  const { topPath, modulePath } = writeCascade({
    module: [
      'roles:',
      '  registry:',
      '    r:',
      '      promptSet: code-pr',
      '      workerClass: bogus-worker',
      '      taskKind: review',
      '      completionShape: decision-only',
      '',
    ].join('\n'),
  });
  assert.throws(
    () => validateStartupRoleRegistry({ env: {}, topPath, modulePaths: [modulePath], workerClasses: HQ_CLASSES }),
    (err) => err instanceof AgentOSConfigError && /not in the hq-published/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// hq-worker-classes — published read + snapshot fallback
// ---------------------------------------------------------------------------

function seedRoster(repoRoot, classes) {
  const rosterPath = join(repoRoot, hqTesting.WORKER_CLASSES_REL_PATH);
  mkdirSync(dirname(rosterPath), { recursive: true });
  const doc = Object.fromEntries(classes.map((c) => [c, {}]));
  writeFileSync(rosterPath, JSON.stringify(doc), 'utf8');
  return rosterPath;
}

test('resolvePublishedWorkerClasses reads the published roster and refreshes the snapshot', () => {
  const rootDir = tmp();
  const repoRoot = tmp();
  seedRoster(repoRoot, ['codex', 'claude-code', 'gemini']);

  const result = resolvePublishedWorkerClasses({
    env: { AGENT_OS_REPO_ROOT: repoRoot },
    rootDir,
    moduleRoot: tmp(), // isolate the upward walk so only AGENT_OS_REPO_ROOT resolves
  });
  assert.equal(result.source, 'published');
  assert.deepEqual([...result.classes].sort(), ['claude-code', 'codex', 'gemini']);

  // A subsequent run with no reachable checkout degrades to the snapshot just
  // written under rootDir/data.
  const degraded = resolvePublishedWorkerClasses({
    env: {},
    rootDir,
    moduleRoot: tmp(),
  });
  assert.equal(degraded.source, 'snapshot');
  assert.deepEqual([...degraded.classes].sort(), ['claude-code', 'codex', 'gemini']);
});

test('resolvePublishedWorkerClasses read-only consumers do not refresh the shared snapshot', () => {
  const repoRoot = tmp();
  seedRoster(repoRoot, ['codex', 'claude-code']);
  let writes = 0;

  const result = resolvePublishedWorkerClasses({
    env: { AGENT_OS_REPO_ROOT: repoRoot },
    rootDir: tmp(),
    moduleRoot: tmp(),
    readOnly: true,
    writeSnapshotImpl: () => { writes += 1; },
  });

  assert.equal(result.source, 'published');
  assert.equal(writes, 0);
});

test('resolvePublishedWorkerClasses throws when neither roster nor snapshot exists', () => {
  assert.throws(
    () => resolvePublishedWorkerClasses({ env: {}, rootDir: tmp(), moduleRoot: tmp() }),
    (err) => err instanceof WorkerClassRosterError,
  );
});

test('a malformed published roster degrades to the snapshot when one exists', () => {
  const rootDir = tmp();
  const repoRoot = tmp();
  seedRoster(repoRoot, ['codex', 'gemini']);
  // Seed the snapshot from a good read.
  resolvePublishedWorkerClasses({ env: { AGENT_OS_REPO_ROOT: repoRoot }, rootDir, moduleRoot: tmp() });
  // Corrupt the published roster.
  writeFileSync(join(repoRoot, hqTesting.WORKER_CLASSES_REL_PATH), '{ not json', 'utf8');
  const result = resolvePublishedWorkerClasses({ env: { AGENT_OS_REPO_ROOT: repoRoot }, rootDir, moduleRoot: tmp() });
  assert.equal(result.source, 'snapshot');
  assert.deepEqual([...result.classes].sort(), ['codex', 'gemini']);
});

test('publishedWorkerClassSet returns a Set for membership checks', () => {
  const repoRoot = tmp();
  seedRoster(repoRoot, ['codex', 'gemini']);
  const set = publishedWorkerClassSet({ env: { AGENT_OS_REPO_ROOT: repoRoot }, rootDir: tmp(), moduleRoot: tmp() });
  assert.ok(set.has('codex'));
  assert.ok(!set.has('nope'));
});

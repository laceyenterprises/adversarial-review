import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CATALOG_PATH, CATALOG_REPO, proveCatalogFieldMove } from '../src/ama/catalog-field-move.mjs';
import { createHistoryReader } from '../src/ama/history-reader.mjs';
import { GH_LOOKUP_MAX_BUFFER } from '../src/gh-cli.mjs';
import { checkPrimaryChange, fetchPrimaryChange } from '../src/ama/primary-change.mjs';

const field = 'terminalCheckoutRecoveryContract';
const fragment = `docs/data-model/catalog.d/fields/${field}.json`;
const order = 'docs/data-model/catalog.d/legacy-order.json';
const value = 'Preserve the reviewed checkout recovery contract.';
const original = { first: 'legacy first', second: 'legacy second', third: 'legacy third',
  domains: [{ name: 'checkout', holdMemo: 'base memo', history: ['first', 'second'] }], zTail: 'newer identity' };
const orderFields = { first: -1, second: 0, third: 1, domains: 2 };
const render = object => `${JSON.stringify(object, null, 2)}\n`;

function fixture(t, { repo = CATALOG_REPO, rewriteFinal = text => text, primaryNeighbor = {},
  catalogValue = value, finalKey = field, finalValue = catalogValue, primaryFragment = render({ [field]: catalogValue }),
  finalFragment = render({ [field]: catalogValue }), baseFragment, finalOrder = orderFields,
  finalMemo = 'author memo', primaryHistory = ['first', 'second'], finalHistory = ['first', 'second'],
  generatedManifest = false,
  executableFragment = false, readerFailure = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'catalog-field-move-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: GH_LOOKUP_MAX_BUFFER,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture Builder', GIT_AUTHOR_EMAIL: 'builder@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture Builder', GIT_COMMITTER_EMAIL: 'builder@example.invalid' },
  }).trimEnd();
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
    git('add', '--', path);
  };
  const commit = message => {
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  write(CATALOG_PATH, render(original));
  write(order, render({ fields: orderFields }));
  if (baseFragment !== undefined) write(fragment, baseFragment);
  const mergeBase = commit('Base catalog');
  const domains = [{ ...original.domains[0], holdMemo: 'author memo', history: primaryHistory }];
  write(CATALOG_PATH, render({ [field]: catalogValue, ...primaryNeighbor, ...original, domains }));
  if (primaryFragment !== null) write(fragment, primaryFragment);
  const primaryHead = commit('Builder inserts the field on line two and edits a domain');
  const { zTail, ...legacy } = original;
  const appended = finalKey ? { [finalKey]: finalValue } : {};
  write(CATALOG_PATH, rewriteFinal(render({ ...legacy,
    domains: [{ ...domains[0], holdMemo: finalMemo, history: finalHistory }], ...appended, zTail })));
  write(order, render({ fields: finalOrder }));
  if (generatedManifest) write('package.json', render({ generatedArtifacts: [{
    path: CATALOG_PATH, start: '{', end: '}', cwd: '.', command: ['node', 'render.mjs'],
  }] }));
  if (finalFragment !== null) write(fragment, finalFragment);
  else if (primaryFragment !== null) git('rm', '--', fragment);
  if (executableFragment) git('add', '--chmod=+x', '--', fragment);
  const headSha = commit('Repair generated ordering\n\nWorker-Class: hammer');
  const files = to => git('diff', '--name-only', mergeBase, to).split('\n').filter(Boolean).map(filename => {
    const [code] = git('diff', '--name-status', mergeBase, to, '--', filename).split('\t');
    const diff = git('diff', '--no-ext-diff', mergeBase, to, '--', filename).split('\n');
    const patch = diff.slice(diff.findIndex(line => line.startsWith('@@ '))).join('\n');
    return { filename, status: { A: 'added', M: 'modified', D: 'removed' }[code], patch,
      additions: patch.split('\n').filter(line => line.startsWith('+')).length,
      deletions: patch.split('\n').filter(line => line.startsWith('-')).length };
  });
  const history = { headSha, mergeBase, primaryHead, hasHammerCommits: true,
    ciCost: { headSha, ok: true }, primaryFiles: files(primaryHead), finalFiles: files(headSha) };
  const get = async path => {
    if (path === `repos/${repo}/pulls/1`) return { head: { sha: headSha }, base: { sha: mergeBase } };
    if (path.endsWith(`${mergeBase}...${headSha}`)) return {
      files: history.finalFiles, merge_base_commit: { sha: mergeBase }, total_commits: 2, commits: [
        { sha: primaryHead, commit: { message: 'Builder' } },
        { sha: headSha, parents: [{ sha: primaryHead }], commit: { message: 'Repair\n\nWorker-Class: hammer' } },
      ],
    };
    if (path.endsWith(`${mergeBase}...${primaryHead}`)) return {
      files: history.primaryFiles, merge_base_commit: { sha: mergeBase },
    };
    if (path.includes('/reviews') || path.includes('/comments')) return [];
    if (path.endsWith(`/commits/${headSha}`)) return { sha: headSha, files: history.finalFiles };
    throw new Error(`Unexpected offline fixture read: ${path}`);
  };
  const reader = createHistoryReader({ execGhWithRetryImpl: async ({ args: [, path] }) => {
    const [, kind, ref] = /\/git\/(trees|blobs)\/([0-9a-f]{40})$/.exec(path);
    if (kind === 'trees') {
      const tree = git('ls-tree', ref).split('\n').map(line => {
        const [, mode, type, sha, path] = /^(\d+) (\w+) (\w+)\t(.+)$/.exec(line);
        return { mode, type, sha, path };
      });
      return { stdout: JSON.stringify({ tree, truncated: readerFailure === 'truncated-tree' }) };
    }
    const text = git('cat-file', 'blob', ref) + '\n';
    const bytes = Buffer.from(readerFailure === 'corrupt-blob' ? text.replace('legacy first', 'legacy spoof') : text);
    return { stdout: JSON.stringify({ encoding: 'base64', size: bytes.length, content: bytes.toString('base64') }) };
  } });
  get.regularDataFile = reader.regularDataFile;
  return { history, git, args: { repo, prNumber: 1, headSha, get } };
}

async function collect(f, options = {}) {
  return fetchPrimaryChange(f.args, {
    fetchCiCostImpl: async ({ headSha }) => ({ headSha, ok: true }),
    proveGeneratedBlocksImpl: async () => [],
    ...options,
  });
}

const check = evidence => checkPrimaryChange(evidence, evidence.headSha, { strictNonBlockingRemediation: true });

test('LAC-2229: native collection proves preservation of the isolated catalog field move', async t => {
  const warnings = t.mock.method(console, 'warn', () => {});
  const f = fixture(t);
  assert.equal(check(f.history).reason, 'primary-change-reverted');
  assert.deepEqual(check(f.history).missingEvidence.regions, [{ start: 2, end: 2 }]);
  const evidence = await collect(f, { proveGeneratedBlocksImpl: () => assert.fail('catalog proof needs no manifest') });
  assert.equal(check(evidence).ok, true);
  assert.equal(warnings.mock.callCount(), 0);
  assert.deepEqual(evidence.generatedBlockProofs, [{
    path: CATALOG_PATH, start: 2, end: 2, insertionLine: `  "${field}": "${value}",`,
    headSha: f.history.headSha, mergeBase: f.history.mergeBase, primaryHead: f.history.primaryHead,
  }]);
  for (const key of ['headSha', 'mergeBase', 'primaryHead', 'insertionLine']) {
    const stale = structuredClone(evidence);
    stale.generatedBlockProofs[0][key] = '0'.repeat(40);
    assert.equal(check(stale).reason, 'primary-change-reverted', key);
  }
});

test('a proven move cannot cover a separately reverted domain edit', async t => {
  const evidence = await collect(fixture(t, { finalMemo: 'base memo' }));
  assert.equal(evidence.generatedBlockProofs.length, 1);
  assert.equal(check(evidence).reason, 'primary-change-reverted');
  assert.equal(check(evidence).path, CATALOG_PATH);
  assert.ok(check(evidence).missingEvidence.regions.every(region => region.start > 2));
});

test('a proven move cannot cover a separately reverted array entry', async t => {
  const evidence = await collect(fixture(t, { primaryHistory: ['first', 'second', 'author entry'] }));
  assert.equal(evidence.generatedBlockProofs.length, 1);
  assert.equal(check(evidence).reason, 'primary-change-reverted');
  assert.equal(check(evidence).path, CATALOG_PATH);
});

test('the production history reader proves the move without a local checkout and validates blob identity', async t => {
  for (const failure of [null, 'corrupt-blob', 'truncated-tree']) {
    const f = fixture(t, { readerFailure: failure });
    const evidence = await collect(f);
    assert.equal(check(evidence).ok, failure === null);
    if (failure) assert.equal(evidence.historyReadFailed, true);
  }
});

test('catalogs larger than the removed local reader cap use the production reader', async t => {
  const evidence = await collect(fixture(t, { catalogValue: 'x'.repeat(2 * 1024 * 1024) }));
  assert.equal(check(evidence).ok, true);
});

test('catalog read failures propagate instead of falling back to a reversal refusal', async t => {
  const warnings = t.mock.method(console, 'warn', () => {});
  const f = fixture(t);
  for (const properties of [
    { primaryChangeReadFailed: true }, { authOutage: true }, { code: 'ECONNRESET' },
    { code: 'HISTORY_READ_INVALID' }, { name: 'AbortError' },
  ]) {
    f.args.get.regularDataFile = async () => { throw Object.assign(new Error('private upstream detail'), properties); };
    const evidence = await collect(f, { proveGeneratedBlocksImpl: () => assert.fail('read failure must not fall back') });
    assert.equal(evidence.historyReadFailed, true);
    assert.equal(JSON.parse(warnings.mock.calls.at(-1).arguments[0].split('proof skipped: ')[1]).reason, 'read-failed');
  }
  assert.equal(warnings.mock.callCount(), 5);
  assert.ok(warnings.mock.calls.every(call => !call.arguments[0].includes('private upstream detail')));
});

test('a sibling read failure takes precedence over a semantic proof rejection', async t => {
  const f = fixture(t);
  const show = f.args.get.regularDataFile;
  f.args.get.regularDataFile = async (repo, ref, path, options) => {
    if (ref === f.history.mergeBase && path === CATALOG_PATH) throw new Error('semantic rejection');
    if (ref === f.history.headSha && path === fragment) throw Object.assign(new Error('read failed'),
      { primaryChangeReadFailed: true });
    return show(repo, ref, path, options);
  };
  assert.equal((await collect(f)).historyReadFailed, true);
});

test('skip diagnostics are bounded and sanitised, without raw failure details', async t => {
  const warnings = t.mock.method(console, 'warn', () => {});
  const result = await proveCatalogFieldMove({ repo: `untrusted\n${'x'.repeat(1000)}`, prNumber: 'bad' },
    { headSha: 'untrusted\nhead' }, { lines: [`+  "${field}": "${value}",`] });
  assert.equal(result, null);
  assert.equal(warnings.mock.callCount(), 1);
  const diagnostic = JSON.parse(warnings.mock.calls[0].arguments[0].split('proof skipped: ')[1]);
  assert.equal(diagnostic.reason, 'unsupported-insertion');
  assert.equal(diagnostic.repo.length, 200);
  assert.ok(!diagnostic.repo.includes('\n'));
  assert.equal(diagnostic.prNumber, null);
  assert.equal(diagnostic.headSha, null);
});

test('a final-head-only manifest cannot authorize a changed catalog value', async t => {
  const evidence = await collect(fixture(t, { generatedManifest: true, finalValue: 'Different value' }),
    { proveGeneratedBlocksImpl: undefined });
  assert.equal(evidence.generatedBlockProofs, undefined);
  assert.equal(check(evidence).reason, 'primary-change-reverted');
});

for (const [name, options] of Object.entries({
  'changed value in both final locations': {
    finalValue: 'Different value', finalFragment: render({ [field]: 'Different value' }),
  },
  'changed projection value': { finalValue: 'Different value' },
  'missing projection identity': { finalKey: null },
  'renamed projection identity': { finalKey: 'terminalCheckoutRecoveryRenamed' },
  'missing final fragment': { finalFragment: null },
  'missing protected fragment': { primaryFragment: null },
  'pre-existing fragment': { baseFragment: render({ [field]: value }) },
  'fragment with a duplicate key': { finalFragment: `{\n  "${field}": "changed",\n  "${field}": "${value}"\n}\n` },
  'projection with a duplicate top-level key': {
    rewriteFinal: text => text.replace(`  "${field}":`, `  "${field}": "changed",\n  "${field}":`),
  },
  'projection with a duplicate nested key': {
    rewriteFinal: text => text.replace('      "holdMemo":', '      "holdMemo": "changed",\n      "holdMemo":'),
  },
  'a noncanonical append position': {
    rewriteFinal: text => text.replace(`  "${field}": "${value}",\n  "zTail": "newer identity"`,
      `  "zTail": "newer identity",\n  "${field}": "${value}"`),
  },
  'legacy-order manipulation': { finalOrder: { ...orderFields, [field]: 3 } },
  'two additions at the protected anchor': { primaryNeighbor: { adjacent: 'also primary' } },
  'an executable fragment': { executableFragment: true },
  'an unsupported repository': { repo: 'fixture/elsewhere' },
})) {
  test(`${name} supplies no catalog field proof`, async t => {
    const warnings = t.mock.method(console, 'warn', () => {});
    const evidence = await collect(fixture(t, options));
    assert.equal(evidence.generatedBlockProofs, undefined);
    assert.equal(check(evidence).reason, 'primary-change-reverted');
    const expectedReason = {
      'pre-existing fragment': 'fragment-mismatch',
      'projection with a duplicate top-level key': 'noncanonical-json',
      'a noncanonical append position': 'not-identity-order',
      'legacy-order manipulation': 'order-changed',
    }[name];
    if (expectedReason) {
      assert.equal(warnings.mock.callCount(), 1);
      assert.equal(JSON.parse(warnings.mock.calls[0].arguments[0].split('proof skipped: ')[1]).reason, expectedReason);
    }
  });
}

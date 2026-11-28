import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { CATALOG_PATH, CATALOG_REPO } from '../src/ama/catalog-field-move.mjs';
import { proveCatalogProjection } from '../src/ama/catalog-projection-preservation.mjs';
import { createHistoryReader } from '../src/ama/history-reader.mjs';
import { checkPrimaryChange, fetchPrimaryChange } from '../src/ama/primary-change.mjs';

const generator = 'scripts/generate-data-model-catalog.mjs';
const orderPath = 'docs/data-model/catalog.d/legacy-order.json';
const fragment = 'docs/data-model/catalog.d/domains/receipt-records.json';
const sibling = 'docs/data-model/catalog.d/domains/worker-records.json';
const source = 'src/receipts.mjs';
const reviewedRecipe = readFileSync(new URL('./fixtures/catalog-projection-reviewed-recipe.txt', import.meta.url));
const render = value => `${JSON.stringify(value, null, 2)}\n`;
const baseDomain = { slug: 'receipt-records', recordContracts: { original: { path: 'old' } }, tables: [{ name: 'sample' }] };
const baseSibling = { slug: 'worker-records', tables: [], description: 'older reference' };
const record = { source: 'src/receipts.mjs', documentation: 'docs/receipts.md', path: 'receipt' };
const sourceWithAddition = {
  divergence: record,
  ...baseDomain,
};
const candidateDomain = {
  divergence: { ...record, path: 'escaped-receipt' },
  ...baseDomain,
};
const catalog = (domain, description = baseSibling.description) => render({
  databases: [], domains: [
    { slug: domain.slug, tableCount: 1, recordContracts: domain.recordContracts, tables: domain.tables,
      ...(domain.divergence ? { divergence: domain.divergence } : {}) },
    { ...baseSibling, description, tableCount: 0 },
  ], tableCount: 1, domainCount: 2, crossDomainReferences: [],
});

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'catalog-projection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const raw = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env, timeout: 5000 });
  const git = (...args) => raw(...args).toString('utf8').trimEnd();
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
    git('add', '--', path);
  };
  const commit = message => {
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  write(generator, options.ancestorRecipe || reviewedRecipe);
  write(orderPath, render({ domainFields: { 'receipt-records': { slug: 0, tableCount: 1, recordContracts: 2, tables: 3 } } }));
  write(fragment, render(baseDomain));
  write(sibling, render(baseSibling));
  write(CATALOG_PATH, catalog(baseDomain));
  write(source, 'export const value = "base";\n');
  const mergeBase = commit('Catalog on main');
  write(generator, options.authorRecipe || reviewedRecipe);
  const authorDomain = options.authorDomain || sourceWithAddition;
  write(fragment, options.authorSourceText || render(authorDomain));
  write(sibling, render({ ...baseSibling, description: 'authored reference' }));
  write(CATALOG_PATH, options.authorCatalog || catalog(authorDomain, options.authorProjectionSibling));
  write(source, 'export const value = "protected";\n');
  const primaryHead = commit('Author updates authoritative fragments and mirrors one record');
  const finalDomain = options.finalDomain || candidateDomain;
  write(fragment, options.finalSourceText || render(finalDomain));
  if (options.removeCatalog) git('rm', '--', CATALOG_PATH);
  else write(CATALOG_PATH, options.finalCatalog || catalog(baseDomain));
  if (options.sourceReversal) write(source, 'export const value = "base";\n');
  if (options.siblingReversal) write(sibling, render(baseSibling));
  for (const path of [options.finalMode && CATALOG_PATH, options.fragmentMode && fragment].filter(Boolean)) {
    chmodSync(join(root, path), 0o755);
    git('add', '--chmod=+x', '--', path);
  }
  if (options.headRecipe) write(generator, options.headRecipe);
  if (options.headOrder) write(orderPath, options.headOrder);
  const headSha = commit('Repair source and defer catalog rebuild\n\nWorker-Class: hammer');
  git('checkout', '-q', '--detach', mergeBase);
  write(generator, options.liveRecipe || reviewedRecipe);
  write('main-only', 'independent base advance\n');
  const baseSha = commit('Advance trusted base');

  const repo = options.repository || CATALOG_REPO;
  const files = to => git('diff', '--no-renames', '--name-status', mergeBase, to).split('\n').map(row => {
    const [code, filename] = row.split('\t');
    const diff = git('diff', '--no-ext-diff', mergeBase, to, '--', filename);
    const hunk = diff.indexOf('\n@@ ');
    const patch = hunk === -1 ? undefined : diff.slice(hunk + 1);
    const sha = git('rev-parse', `${code === 'D' ? mergeBase : to}:${filename}`);
    return { filename, status: { A: 'added', M: 'modified', D: 'removed' }[code], sha, patch,
      additions: patch?.split('\n').filter(line => line.startsWith('+')).length || 0,
      deletions: patch?.split('\n').filter(line => line.startsWith('-')).length || 0 };
  });
  const primaryFiles = files(primaryHead), finalFiles = files(headSha);
  if (options.corruptDiffBlob) primaryFiles.find(file => file.filename === CATALOG_PATH).sha = '0'.repeat(40);
  if (options.hideProjectionDiff) finalFiles.splice(finalFiles.findIndex(file => file.filename === CATALOG_PATH), 1);
  const reads = [];
  const get = async path => {
    if (path === `repos/${repo}/pulls/1`) {
      return { head: { sha: headSha }, base: {
        sha: baseSha,
        ref: options.baseRef || 'main', repo: { full_name: options.baseRepo || repo },
      } };
    }
    const comparison = { merge_base_commit: { sha: mergeBase }, filesComplete: !options.incomplete };
    if (path.endsWith(`${baseSha}...${headSha}`)) return { ...comparison, files: finalFiles, total_commits: 2, commits: [
      { sha: primaryHead, commit: { message: 'Author' } },
      { sha: headSha, parents: [{ sha: primaryHead }], commit: { message: 'Repair\n\nWorker-Class: hammer' } },
    ] };
    if (path.endsWith(`${baseSha}...${primaryHead}`)) return { ...comparison, files: primaryFiles };
    if (path.includes('/protection/required_status_checks')) return { checks: [] };
    if (path.includes('/reviews') || path.includes('/comments')) return [];
    if (path.endsWith(`/commits/${headSha}`)) return { sha: headSha, files: finalFiles };
    throw new Error(`Unexpected offline fixture read: ${path}`);
  };
  get.metadata = async path => {
    const [from] = path.split('/compare/')[1].split('...');
    return { status: options.noAncestry && from === primaryHead ? 'diverged' : 'ahead', merge_base_commit: { sha: from } };
  };
  const reader = createHistoryReader({ execGhWithRetryImpl: async ({ args: [, path] }) => {
    const [, kind, ref] = /\/git\/(trees|blobs)\/([0-9a-f]{40})$/.exec(path);
    if (kind === 'trees') {
      const tree = git('ls-tree', ref).split('\n').map(line => {
        const [, mode, type, sha, path] = /^(\d+) (\w+) (\w+)\t(.+)$/.exec(line);
        return { mode, type, sha, path };
      });
      return { stdout: JSON.stringify({ tree, truncated: options.truncatedTree === true }) };
    }
    let bytes = raw('cat-file', 'blob', ref);
    if (options.corruptRawBlob && ref === primaryFiles.find(file => file.filename === CATALOG_PATH).sha) {
      bytes = Buffer.concat([bytes, Buffer.from(' ')]);
    }
    return { stdout: JSON.stringify({ encoding: 'base64', size: bytes.length, content: bytes.toString('base64') }) };
  } });
  get.regularDataFile = async (repository, ref, path, readOptions) => {
    reads.push([repository, ref, path]);
    return reader.regularDataFile(repository, ref, path, readOptions);
  };
  return { args: { repo, prNumber: 1, headSha, get }, reads, baseSha, mergeBase, primaryHead, headSha };
}

const collect = ({ args }) => fetchPrimaryChange(args, {
  fetchCiCostImpl: async ({ headSha }) => ({ headSha, ok: true }),
  proveGeneratedBlocksImpl: async () => [],
  fetchDeadCodeSourcesImpl: async () => [],
});

test('replays one authored record against an independently read main recipe and exact output blobs', async t => {
  const warnings = t.mock.method(console, 'warn', () => {});
  const f = fixture(t);
  const evidence = await collect(f);
  const result = checkPrimaryChange(evidence, f.headSha);
  assert.equal(result.ok, true);
  assert.deepEqual(f.reads[0], [CATALOG_REPO, f.baseSha, generator]);
  assert.deepEqual(result.catalogProjectionPreservation, evidence.catalogProjectionProof);
  assert.equal(result.catalogProjectionPreservation.fragment, fragment);
  assert.equal(result.catalogProjectionPreservation.headBlob, result.catalogProjectionPreservation.baseBlob);
  assert.notEqual(result.catalogProjectionPreservation.primaryBlob, result.catalogProjectionPreservation.baseBlob);
  assert.notEqual(result.catalogProjectionPreservation.primaryFragment, result.catalogProjectionPreservation.headFragment);
  for (const key of ['baseSha', 'mergeBase', 'headSha', 'primaryHead', 'primaryBlob', 'headBlob', 'primaryFragment', 'headFragment', 'recipe', 'path']) {
    const stale = structuredClone(evidence);
    stale.catalogProjectionProof[key] = 'unbound';
    assert.equal(checkPrimaryChange(stale, f.headSha).reason, 'primary-change-reverted', key);
  }
  assert.equal(checkPrimaryChange(evidence, f.primaryHead).reason, 'primary-change-read-failed');
  assert.equal(f.reads.length, 14);
  assert.equal(warnings.mock.callCount(), 0);
});

test('a catalog proof supplies no preservation for sibling fragments or code', async t => {
  for (const [option, path] of [['sourceReversal', source], ['siblingReversal', sibling]]) {
    const f = fixture(t, { [option]: true });
    const evidence = await collect(f);
    assert.equal(Boolean(evidence.catalogProjectionProof), option === 'sourceReversal');
    assert.equal(checkPrimaryChange(evidence, f.headSha).path, path);
  }
});

for (const [name, options] of Object.entries({
  'foreign repository': { repository: 'fixture/elsewhere' },
  'foreign base repository': { baseRepo: 'fixture/fork' },
  'foreign base branch': { baseRef: 'release' },
  'untrusted main recipe with the approved recipe supplied by the PR': { liveRecipe: 'wrong recipe\n' },
  'author-introduced recipe': { ancestorRecipe: 'unknown recipe\n' },
  'candidate recipe substitution': { headRecipe: 'unknown recipe\n' },
  'candidate ordering change': { headOrder: '{}\n' },
  'missing ancestry': { noAncestry: true },
  'incomplete comparisons': { incomplete: true },
  'candidate reversal of the authored record': { finalDomain: { ...baseDomain, fake: {} } },
  'candidate keeps the key but removes the record': { finalDomain: { ...baseDomain, divergence: {} } },
  'candidate changes the record source identity': { finalDomain: {
    ...candidateDomain, divergence: { ...record, source: 'src/unrelated.mjs' },
  } },
  'an extra protected edit in the catalog': { authorProjectionSibling: 'unbacked projection edit' },
  'protected replacement of an existing record': { authorDomain: { ...sourceWithAddition, recordContracts: {
    ...sourceWithAddition.recordContracts, original: { path: 'changed' },
  } } },
  'ambiguous authoritative input': { authorSourceText: render(sourceWithAddition).replace('"path": "receipt"', '"path": "hidden", "path": "receipt"') },
  'valid noncanonical number in authoritative input': {
    authorDomain: { ...sourceWithAddition, divergence: { ...record, attempts: 1 } },
    finalDomain: { ...candidateDomain, divergence: { ...record, attempts: 1 } },
    authorSourceText: render({ ...sourceWithAddition, divergence: { ...record, attempts: 1 } })
      .replace('"attempts": 1', '"attempts": 1.0'),
    finalSourceText: render({ ...candidateDomain, divergence: { ...candidateDomain.divergence, attempts: 1 } })
      .replace('"attempts": 1', '"attempts": 1.0'),
  },
  'valid integer-like key reordered by JavaScript': {
    authorDomain: { ...sourceWithAddition, divergence: { ...record, 2024: 'receipt' } },
    finalDomain: { ...candidateDomain, divergence: { ...record, 2024: 'receipt' } },
    authorSourceText: render(sourceWithAddition).replace('"path": "receipt"', '"path": "receipt", "2024": "receipt"'),
    finalSourceText: render(candidateDomain).replace('"path": "escaped-receipt"', '"path": "escaped-receipt", "2024": "receipt"'),
  },
  'removed output missing from the inventory': { removeCatalog: true, hideProjectionDiff: true },
  'mode-only output change missing from the inventory': { finalMode: true, hideProjectionDiff: true },
  'executable candidate source': { fragmentMode: true },
  'candidate output differs by one byte despite missing diff row': { finalCatalog: `${catalog(baseDomain)}\n`, hideProjectionDiff: true },
  'wrong comparison blob': { corruptDiffBlob: true },
  'corrupt raw Git blob': { corruptRawBlob: true },
  'truncated immutable tree': { truncatedTree: true },
})) {
  test(`refuses ${name}`, async t => {
    const warnings = t.mock.method(console, 'warn', () => {});
    const f = fixture(t, options);
    const evidence = await collect(f);
    assert.equal(evidence.catalogProjectionProof, undefined);
    assert.equal(checkPrimaryChange(evidence, f.headSha).ok, false);
    if (name.startsWith('valid ')) {
      assert.equal(warnings.mock.callCount(), 1, 'reached the conservative parser');
      assert.equal(JSON.parse(warnings.mock.calls[0].arguments[0].split('proof skipped: ')[1]).reason, 'invalid-fragment');
    }
  });
}

test('refuses live head or base movement at the proof fences', async t => {
  const f = fixture(t);
  const evidence = await collect(f);
  delete evidence.catalogProjectionProof;
  const refusal = checkPrimaryChange(evidence, f.headSha);
  assert.equal(refusal.path, CATALOG_PATH);
  for (const [field, fence] of [['head', 1], ['head', 2], ['base', 1], ['base', 2]]) {
    // Only count reads made by this proof invocation, independently of
    // collection. Blob reads demonstrate that the second fence follows replay.
    let fencesReached = 0;
    const startReads = f.reads.length;
    const get = Object.assign(async path => {
      assert.equal(path, `repos/${CATALOG_REPO}/pulls/1`);
      ++fencesReached;
      assert.equal(f.reads.length - startReads, fencesReached === 1 ? 0 : 14);
      const live = await f.args.get(path);
      if (fencesReached === fence) live[field].sha = f.mergeBase;
      return live;
    }, f.args.get);
    const result = await proveCatalogProjection({ ...f.args, get }, evidence, refusal);
    assert.equal(fencesReached, fence, `${field} fence ${fence} was reached`);
    assert.equal(result?.proof, undefined);
    if (field === 'head') assert.deepEqual(result, { headMismatch: true });
    else assert.equal(result, null);
  }
});

test('untagged metadata read failures reach the shared history failure path', async t => {
  const warnings = t.mock.method(console, 'warn', () => {});
  for (const properties of [
    { code: 'ETIMEDOUT' }, { code: 'HISTORY_READ_INVALID' }, { code: 'ABORT_ERR' },
    { name: 'AbortError' }, { authOutage: true }, { primaryChangeReadFailed: true },
  ]) {
    const f = fixture(t);
    const error = Object.assign(new Error('private upstream detail'), properties);
    f.args.get.metadata = async () => { throw error; };
    const evidence = await collect(f);
    assert.ok(f.reads.length > 0, 'reached proof metadata after reading its recipe');
    assert.equal(evidence.catalogProjectionProof, undefined);
    assert.equal(evidence.historyReadFailed, true);
    assert.equal(checkPrimaryChange(evidence, f.headSha).reason, 'history-read-failed');
    assert.equal(JSON.parse(warnings.mock.calls.at(-1).arguments[0].split('proof skipped: ')[1]).reason, 'read-failed');
  }
  assert.equal(warnings.mock.callCount(), 6);
  assert.ok(warnings.mock.calls.every(call => !call.arguments[0].includes('private upstream detail')));
});

test('skipped proofs emit one fixed diagnostic without catalog content', async t => {
  const warnings = t.mock.method(console, 'warn', () => {});
  for (const [options, reason] of [
    [{ liveRecipe: 'private recipe\n' }, 'recipe-drift'],
    [{ headOrder: '{}\n' }, 'order-drift'],
    [{ authorDomain: { ...sourceWithAddition, second: record },
      finalDomain: { ...candidateDomain, second: record } }, 'not-single-record'],
    [{ authorCatalog: catalog(sourceWithAddition).replace('"domainCount": 2', '"domainCount": 3') }, 'replay-mismatch'],
    [{ authorSourceText: render(sourceWithAddition).replace('"path": "receipt"', '"path": "hidden", "path": "receipt"') }, 'invalid-fragment'],
  ]) {
    warnings.mock.resetCalls();
    const f = fixture(t, options);
    const evidence = await collect(f);
    assert.equal(evidence.catalogProjectionProof, undefined);
    assert.equal(checkPrimaryChange(evidence, f.headSha).reason, 'primary-change-reverted');
    assert.equal(warnings.mock.callCount(), 1, reason);
    assert.deepEqual(JSON.parse(warnings.mock.calls[0].arguments[0].split('proof skipped: ')[1]), {
      repo: CATALOG_REPO, prNumber: 1, headSha: f.headSha, path: CATALOG_PATH, reason,
    });
  }
});

test('no network reads without a modified fragment in both comparisons', async t => {
  const f = fixture(t);
  const original = await collect(f);
  delete original.catalogProjectionProof;
  const refusal = checkPrimaryChange(original, f.headSha);
  const get = Object.assign(async () => { assert.fail('ineligible proof made a live read'); }, {
    metadata: async () => { assert.fail('ineligible proof made a metadata read'); },
    regularDataFile: async () => { assert.fail('ineligible proof made a blob read'); },
  });
  for (const list of ['primaryFiles', 'finalFiles']) {
    for (const status of ['missing', 'added', 'removed', 'renamed']) {
      const evidence = structuredClone(original);
      evidence[list] = evidence[list].filter(file => file.filename !== fragment && file.filename !== sibling);
      if (status !== 'missing') evidence[list].push({ ...original[list].find(file => file.filename === fragment), status });
      assert.equal(await proveCatalogProjection({ ...f.args, get }, evidence, refusal), null);
    }
  }
});

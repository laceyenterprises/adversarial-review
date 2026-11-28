import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { CATALOG_PATH, CATALOG_REPO } from '../src/ama/catalog-field-move.mjs';
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
  write(CATALOG_PATH, catalog(authorDomain, options.authorProjectionSibling));
  write(source, 'export const value = "protected";\n');
  const primaryHead = commit('Author updates authoritative fragments and mirrors one record');
  const finalDomain = options.finalDomain || candidateDomain;
  write(fragment, render(finalDomain));
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
  let prReads = 0;
  const get = async path => {
    if (path === `repos/${repo}/pulls/1`) {
      ++prReads;
      return { head: { sha: options.headMovesAt === prReads ? primaryHead : headSha }, base: {
        sha: options.baseMovesAt === prReads ? mergeBase : baseSha,
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
  'moved base': { baseMovesAt: 4 },
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
  'removed output missing from the inventory': { removeCatalog: true, hideProjectionDiff: true },
  'mode-only output change missing from the inventory': { finalMode: true, hideProjectionDiff: true },
  'executable candidate source': { fragmentMode: true },
  'candidate output differs by one byte despite missing diff row': { finalCatalog: `${catalog(baseDomain)}\n`, hideProjectionDiff: true },
  'wrong comparison blob': { corruptDiffBlob: true },
  'corrupt raw Git blob': { corruptRawBlob: true },
  'truncated immutable tree': { truncatedTree: true },
})) {
  test(`refuses ${name}`, async t => {
    const f = fixture(t, options);
    const evidence = await collect(f);
    assert.equal(evidence.catalogProjectionProof, undefined);
    assert.equal(checkPrimaryChange(evidence, f.headSha).ok, false);
  });
}

test('refuses a live head move at either proof fence', async t => {
  for (const headMovesAt of [3, 4]) {
    const f = fixture(t, { headMovesAt });
    const evidence = await collect(f);
    assert.equal(evidence.catalogProjectionProof, undefined);
    assert.equal(evidence.headMismatch, true);
    assert.equal(checkPrimaryChange(evidence, f.headSha).reason, 'primary-change-read-failed');
  }
});

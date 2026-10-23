import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkPrimaryChange, fetchPrimaryChange } from '../src/ama/primary-change.mjs';
import { declaredGeneratedBlocks, proveGeneratedBlocks, runDerivedGenerator, withDerivedCheckout } from '../src/ama/derived-artifacts.mjs';

const start = '<!-- smv:state-machines:start -->';
const end = '<!-- smv:state-machines:end -->';
const declaration = { path: 'docs/*.md', start, end, cwd: '.', command: [process.execPath, 'render.mjs'] };

function fixture(t, { handEdit = false, outside = false, failure = false, noop = false, duplicate = false,
  headDeclaration = false, reorderDeclaration = false, markerEdit = false, finalShift = false,
  authorShift = 0, repairedInventory = false, generatorCwd = '.', emptyBase = false, noDeclarations = false, authorMarkerEdit = false,
  additionalDeclarations = [], declarationLast = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'derived-block-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture Builder', GIT_AUTHOR_EMAIL: 'builder@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture Builder', GIT_COMMITTER_EMAIL: 'builder@example.invalid' } }).trimEnd();
  const document = (rows, prose = 'Base prose') => `${prose}\n${start}\n${rows ? rows + '\n' : ''}${end}\nTail\n`;
  const baseProse = authorShift < 0 ? 'Base prose\nBase second line\nBase third line' : 'Base prose';
  const authorProse = authorShift > 0 ? 'Base prose\nAuthor introduction\nAuthor details'
    : authorShift < 0 ? 'Base prose' : outside ? 'Author prose' : 'Base prose';
  const entry = { ...declaration, cwd: generatorCwd,
    command: [process.execPath, generatorCwd === '.' ? 'render.mjs' : '../render.mjs'] };
  git('init', '-q');
  mkdirSync(join(root, 'docs'));
  const entries = declarationLast ? [...additionalDeclarations, entry] : [entry, ...additionalDeclarations];
  writeFileSync(join(root, 'package.json'), JSON.stringify(noDeclarations ? {} : { generatedArtifacts: entries }));
  writeFileSync(join(root, 'inventory.txt'), emptyBase ? '' : 'Base row\n');
  writeFileSync(join(root, 'render.mjs'), failure ? 'process.exit(1);' : noop ? '' : `
import fs from 'node:fs';
const path = ${JSON.stringify(generatorCwd === '.' ? 'docs/guide.md' : 'guide.md')};
const text = fs.readFileSync(path, 'utf8');
fs.writeFileSync(path, text.slice(0, text.indexOf(${JSON.stringify(start)}) + ${start.length}) + '\\n'
  + fs.readFileSync(${JSON.stringify(generatorCwd === '.' ? 'inventory.txt' : '../inventory.txt')}, 'utf8') + text.slice(text.indexOf(${JSON.stringify(end)})));
`);
  writeFileSync(join(root, 'docs/guide.md'), document(emptyBase ? '' : 'Base row', baseProse));
  git('add', 'package.json', 'inventory.txt', 'render.mjs', 'docs/guide.md');
  git('commit', '-qm', 'Fixture base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'docs/guide.md'), document('Author row\nAuthor second row', authorProse)
    .replace(end, authorMarkerEdit ? '<!-- author:end -->' : end));
  git('add', 'docs/guide.md');
  git('commit', '-qm', 'Fixture author change');
  const builder = git('rev-parse', 'HEAD');
  // Keep the inventory input unchanged in this fixture so the documentation is
  // the sole primary change and its final compare entry can disappear entirely.
  let finalText = document(handEdit ? 'Base row\nHand edited row' : emptyBase ? '' : 'Base row', outside ? baseProse : authorProse);
  if (repairedInventory) {
    writeFileSync(join(root, 'inventory.txt'), 'Base row\nDerived row\n');
    finalText = document('Base row\nDerived row');
  }
  if (finalShift) finalText = `Preface\n${finalText}`;
  if (markerEdit) finalText = finalText.replace(start, '<!-- another:start -->');
  if (duplicate) finalText += `${start}\nDuplicate\n${end}\n`;
  if (headDeclaration) writeFileSync(join(root, 'package.json'), JSON.stringify({ generatedArtifacts: [{ ...declaration, cwd: 'docs' }] }));
  if (reorderDeclaration) writeFileSync(join(root, 'package.json'), JSON.stringify({ generatedArtifacts: [
    Object.fromEntries(Object.entries(entry).reverse()),
  ] }));
  writeFileSync(join(root, 'docs/guide.md'), finalText);
  git('add', 'docs/guide.md', 'package.json', 'inventory.txt');
  git('commit', '-qm', 'Fixture repair\n\nWorker-Class: hammer');
  const headSha = git('rev-parse', 'HEAD');
  const files = to => {
    return git('diff', '--name-only', base, to).split('\n').filter(Boolean).map(filename => {
      const patch = git('diff', '--no-ext-diff', '--unified=3', base, to, '--', filename).split('\n');
      const body = patch.slice(patch.findIndex(line => line.startsWith('@@ ')));
      return { filename, status: 'modified', additions: body.filter(line => line.startsWith('+')).length,
        deletions: body.filter(line => line.startsWith('-')).length, patch: body.join('\n') };
    });
  };
  const evidence = { headSha, mergeBase: base, primaryHead: builder, hasHammerCommits: true,
    ciCost: { headSha, ok: true }, primaryFiles: files(builder), finalFiles: files(headSha) };
  const get = async path => {
    if (path.endsWith('/pulls/1')) return { head: { sha: headSha }, base: { sha: base } };
    if (path.endsWith(`${base}...${headSha}`)) return { files: evidence.finalFiles,
      merge_base_commit: { sha: base }, total_commits: 2, commits: [
        { sha: builder, commit: { message: 'Fixture author change' } },
        { sha: headSha, parents: [{ sha: builder }], commit: { message: 'Fixture repair\n\nWorker-Class: hammer' } },
      ] };
    if (path.endsWith(`${base}...${builder}`)) return { files: evidence.primaryFiles, merge_base_commit: { sha: base } };
    if (path.includes('/reviews') || path.includes('/comments')) return [];
    if (path.endsWith(`/commits/${headSha}`)) return { sha: headSha, files: evidence.finalFiles };
    throw new Error(`Unexpected offline fixture read: ${path}`);
  };
  const args = { repo: 'fixture/repository', prNumber: 1, headSha, get, localRepository: root };
  return { root, args, evidence };
}

// Always exercise comparison/checkout on offline hosts without OS sandbox
// tooling. The separate sandbox test below uses the real platform backend.
const offlineGenerator = async ({ scratch, cwd, command }) => {
  execFileSync(command[0], command.slice(1), { cwd: join(scratch, cwd), timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: scratch } });
};
async function prove(f, options = {}) {
  const refusal = checkPrimaryChange(f.evidence, f.args.headSha);
  assert.equal(refusal.reason, 'primary-change-reverted');
  const generatedBlockProofs = await proveGeneratedBlocks(f.args, f.evidence, refusal, {
    runGeneratorImpl: offlineGenerator, ...options,
  });
  return { ...f.evidence, generatedBlockProofs };
}

test('regenerated author rows are preserved, including a file absent from the final diff', async t => {
  const f = fixture(t);
  assert.equal(f.evidence.finalFiles.length, 0);
  const result = await prove(f);
  assert.equal(result.generatedBlockProofs.length, 1);
  assert.equal(checkPrimaryChange(result, f.args.headSha).ok, true);
  assert.equal(readFileSync(join(f.root, 'docs/guide.md'), 'utf8').includes('Base row'), true);
});

test('shared globs skip missing or ambiguous markers before and after valid declarations', async t => {
  t.mock.method(console, 'warn', () => {});
  for (const markers of [
    { start: '<!-- other:start -->', end: '<!-- other:end -->' },
    { start: end, end: start },
  ]) {
    for (const declarationLast of [false, true]) {
      const f = fixture(t, { declarationLast, additionalDeclarations: [{ ...declaration, ...markers }] });
      const result = await prove(f);
      assert.equal(result.generatedBlockProofs.length, 1);
      assert.equal(checkPrimaryChange(result, f.args.headSha).ok, true);
    }
  }
});

test('missing and non-directory generator cwd report actionable errors without starting a process', async t => {
  const scratch = mkdtempSync(join(tmpdir(), 'derived-cwd-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  writeFileSync(join(scratch, 'file'), 'not a directory');
  for (const cwd of ['missing', 'file']) {
    await assert.rejects(runDerivedGenerator({ scratch, cwd, command: ['unused-generator'] }),
      error => error.message.includes(`generator cwd unavailable: ${cwd}:`)
        && (cwd === 'missing' ? error.cause.code === 'ENOENT' : /not a directory/.test(error.message)));
  }
});

test('cwd failures retain refusal and diagnostics while later declarations start from a fresh head', async t => {
  const diagnostics = [];
  t.mock.method(console, 'warn', message => diagnostics.push(message));
  const f = fixture(t, { declarationLast: true,
    additionalDeclarations: [{ ...declaration, cwd: 'missing' }] });
  const result = await prove(f, { runGeneratorImpl: args => args.cwd.endsWith('/missing')
    ? runDerivedGenerator(args) : offlineGenerator(args) });
  assert.equal(result.generatedBlockProofs.length, 1);
  assert.equal(checkPrimaryChange(result, f.args.headSha).ok, true);
  assert.ok(diagnostics.some(message => message.includes('docs/guide.md')
    && message.includes('generator cwd unavailable:') && message.includes('missing') && message.includes('ENOENT')));
  const missing = fixture(t, { generatorCwd: 'missing' });
  const refused = await prove(missing, { runGeneratorImpl: runDerivedGenerator });
  assert.deepEqual(refused.generatedBlockProofs, []);
  assert.equal(checkPrimaryChange(refused, missing.args.headSha).reason, 'primary-change-reverted');
});

test('empty merge-base interiors accept insertion units and protect adjacent marker/prose edits', async t => {
  const f = fixture(t, { emptyBase: true });
  const refusal = checkPrimaryChange(f.evidence, f.args.headSha);
  assert.deepEqual(refusal.missingEvidence.regions.map(({ start, end }) => [start, end]), [[3, 3]]);
  const result = await prove(f);
  assert.equal(result.generatedBlockProofs.length, 1);
  assert.equal(result.generatedBlockProofs[0].start, 3);
  assert.equal(result.generatedBlockProofs[0].end, 3);
  assert.equal(checkPrimaryChange(result, f.args.headSha).ok, true);
  for (const options of [{ outside: true }, { authorMarkerEdit: true }]) {
    const rejected = fixture(t, { emptyBase: true, ...options });
    const proof = await prove(rejected);
    assert.equal(proof.generatedBlockProofs.length, options.outside ? 1 : 0);
    assert.equal(checkPrimaryChange(proof, rejected.args.headSha).reason, 'primary-change-reverted');
  }
});

test('empty base block populated by repaired inputs reproduces at the insertion boundary', async t => {
  const f = fixture(t, { emptyBase: true, repairedInventory: true });
  // Exercise proof generation explicitly: an in-place populated final block
  // already preserves the author insertion without needing optional proof.
  const result = await proveGeneratedBlocks(f.args, f.evidence, {
    path: 'docs/guide.md', missingEvidence: { evidence: 'reversal-authorization', regions: [{ start: 3, end: 3 }] },
  }, { runGeneratorImpl: offlineGenerator });
  assert.equal(result.length, 1);
  assert.deepEqual([result[0].start, result[0].end], [3, 3]);
  assert.equal(checkPrimaryChange({ ...f.evidence, generatedBlockProofs: result }, f.args.headSha).ok, true);
});

test('a repair changing generator inputs proves output at shifted final-head coordinates and declared cwd', async t => {
  const f = fixture(t, { repairedInventory: true, finalShift: true, generatorCwd: 'docs' });
  const result = await prove(f);
  assert.equal(result.generatedBlockProofs.length, 1);
  assert.equal(checkPrimaryChange(result, f.args.headSha).ok, true);
});

test('shared collection accepts reproduced blocks without a finding on the generated file', async t => {
  const f = fixture(t);
  const result = await fetchPrimaryChange(f.args, {
    fetchCiCostImpl: async () => f.evidence.ciCost,
    proveGeneratedBlocksImpl: (args, evidence, refusal) => proveGeneratedBlocks(args, evidence, refusal, { runGeneratorImpl: offlineGenerator }),
  });
  assert.equal(result.generatedBlockProofs.length, 1);
  assert.equal(checkPrimaryChange(result, f.args.headSha).ok, true);
});

test('shared collection retains opaque artifact proofs while collecting generated block proofs', async t => {
  const f = fixture(t);
  const path = 'sdk/output.tgz';
  const primaryBlob = 'a'.repeat(40), blob = 'b'.repeat(40);
  f.evidence.primaryFiles.unshift({ filename: path, status: 'added', sha: primaryBlob });
  f.evidence.finalFiles.unshift({ filename: path, status: 'added', sha: blob });
  const artifactProof = { path, primaryBlob, blob, headSha: f.args.headSha,
    primaryHead: f.evidence.primaryHead, comparison: 'git-blob-sha1' };
  assert.equal(checkPrimaryChange(f.evidence, f.args.headSha).reason, 'primary-change-unknown');
  const result = await fetchPrimaryChange(f.args, {
    fetchCiCostImpl: async () => f.evidence.ciCost,
    proveDerivedArtifactsImpl: async () => [artifactProof],
    proveGeneratedBlocksImpl: (args, evidence, refusal) => {
      assert.deepEqual(evidence.derivedArtifacts, [artifactProof]);
      return proveGeneratedBlocks(args, evidence, refusal, { runGeneratorImpl: offlineGenerator });
    },
  });
  assert.deepEqual(result.derivedArtifacts, [artifactProof]);
  assert.equal(result.generatedBlockProofs.length, 1);
  assert.equal(checkPrimaryChange(result, f.args.headSha).ok, true);
  assert.equal(checkPrimaryChange({ ...result, derivedArtifacts: [] }, f.args.headSha).reason, 'primary-change-unknown');
  assert.equal(checkPrimaryChange({ ...result, generatedBlockProofs: [] }, f.args.headSha).reason, 'primary-change-reverted');
});

test('cached refused history retries reproduction without invalidation or fresh history reads', async t => {
  const f = fixture(t);
  const originalGet = f.args.get;
  let historyReads = 0, manifestReads = 0, proofAttempts = 0, available = false;
  f.args.rootDir = f.root;
  f.args.get = Object.assign(async path => {
    if (path.includes('/compare/')) historyReads++;
    if (path.includes('/contents/')) manifestReads++;
    return originalGet(path);
  }, { persistPrimaryChange: true, metadata: async () => ({ merge_base_commit: { sha: f.evidence.mergeBase } }) });
  const options = {
    fetchCiCostImpl: async () => f.evidence.ciCost,
    proveGeneratedBlocksImpl: async (args, evidence, refusal) => {
      proofAttempts++;
      return available ? proveGeneratedBlocks(args, evidence, refusal, { runGeneratorImpl: offlineGenerator }) : [];
    },
  };
  assert.equal(checkPrimaryChange(await fetchPrimaryChange(f.args, options), f.args.headSha).reason, 'primary-change-reverted');
  const reads = historyReads;
  assert.ok(reads > 0);
  const store = join(f.root, 'data', 'primary-change-history');
  const names = readdirSync(store);
  assert.equal(names.length, 1);
  const cached = readFileSync(join(store, names[0]), 'utf8');
  available = true;
  const recovered = await fetchPrimaryChange(f.args, options);
  assert.equal(recovered.generatedBlockProofs.length, 1);
  assert.equal(checkPrimaryChange(recovered, f.args.headSha).ok, true);
  assert.equal(historyReads, reads, 'second collection must reuse the cached history');
  assert.equal(proofAttempts, 2);
  assert.equal(manifestReads, 0, 'optional proof retries use local immutable manifests');
  assert.equal(readFileSync(join(store, names[0]), 'utf8'), cached, 'proof recovery must not rewrite the history cache');
});

test('repeated refusals without declarations never request a live manifest or run a generator', async t => {
  const f = fixture(t, { noDeclarations: true });
  let liveReads = 0, generatorRuns = 0;
  f.args.get = () => { liveReads++; throw new Error('unexpected live read'); };
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await prove(f, { runGeneratorImpl: () => { generatorRuns++; } });
    assert.deepEqual(result.generatedBlockProofs, []);
    assert.equal(checkPrimaryChange(result, f.args.headSha).reason, 'primary-change-reverted');
  }
  assert.equal(liveReads, 0);
  assert.equal(generatorRuns, 0);
});

for (const authorShift of [-2, 2]) {
  test(`author line shift ${authorShift} above the block preserves base-coordinate proof and outside intent`, async t => {
    const f = fixture(t, { authorShift });
    const result = await prove(f);
    assert.equal(result.generatedBlockProofs.length, 1);
    assert.equal(result.generatedBlockProofs[0].start, authorShift < 0 ? 5 : 3);
    assert.equal(checkPrimaryChange(result, f.args.headSha).ok, true);
    // Reverting the introduction/deletion above the block must still refuse,
    // even where author-head block coordinates would overlap those base units.
    const reverted = fixture(t, { authorShift, outside: true });
    const refused = await prove(reverted);
    assert.equal(refused.generatedBlockProofs.length, 1);
    const verdict = checkPrimaryChange(refused, reverted.args.headSha);
    assert.equal(verdict.reason, 'primary-change-reverted');
    assert.ok(verdict.missingEvidence.regions.some(region => region.start < refused.generatedBlockProofs[0].start));
  });
}

test('manifest declaration key order does not change generated authority', async t => {
  const f = fixture(t, { reorderDeclaration: true });
  const result = await prove(f);
  assert.equal(result.generatedBlockProofs.length, 1);
  assert.equal(checkPrimaryChange(result, f.args.headSha).ok, true);
});

test('missing or incomplete local clone references fail closed without a network fallback', async t => {
  const f = fixture(t);
  const identity = { ...f.args, mergeBase: f.evidence.mergeBase, rootDir: undefined };
  await assert.rejects(withDerivedCheckout({ ...identity, localRepository: undefined },
    () => assert.fail('missing source must not run operation')), /requires a local clone reference/);
  await assert.rejects(withDerivedCheckout({ ...identity, headSha: 'f'.repeat(40) },
    () => assert.fail('missing commit must not run operation')), error => {
    assert.ok(!error.message.includes('https://github.com/'));
    assert.ok(error.message.includes(f.root));
    return true;
  });
  assert.deepEqual((await prove(f, { checkoutImpl: (args, operation) =>
    withDerivedCheckout({ ...args, rootDir: undefined, localRepository: undefined }, operation) })).generatedBlockProofs, []);
});

for (const [name, options] of Object.entries({
  'hand edit': { handEdit: true }, 'generator failure': { failure: true }, 'no-op generator': { noop: true },
  'changed declaration': { headDeclaration: true }, 'marker edit': { markerEdit: true },
  'duplicate markers': { duplicate: true },
})) {
  test(`${name} keeps the existing refusal`, async t => {
    const f = fixture(t, options);
    const result = await prove(f);
    assert.deepEqual(result.generatedBlockProofs, []);
    assert.equal(checkPrimaryChange(result, f.args.headSha).reason, 'primary-change-reverted');
  });
}

test('a reverted region outside the declared block remains refused in the same file', async t => {
  const f = fixture(t, { outside: true });
  const result = await prove(f);
  assert.equal(result.generatedBlockProofs.length, 1);
  const refusal = checkPrimaryChange(result, f.args.headSha);
  assert.equal(refusal.reason, 'primary-change-reverted');
  assert.ok(refusal.missingEvidence.regions.some(region => region.start === 1));
});

test('proofs are bound to the exact head and merge base', async t => {
  const f = fixture(t);
  const result = await prove(f);
  for (const field of ['headSha', 'mergeBase']) {
    const stale = structuredClone(result);
    stale.generatedBlockProofs[0][field] = 'f'.repeat(40);
    assert.equal(checkPrimaryChange(stale, f.args.headSha).ok, false);
  }
});

test('exact block comparison includes marker line endings', async t => {
  const f = fixture(t);
  const result = await prove(f, { runGeneratorImpl: async args => {
    await offlineGenerator(args);
    const path = join(args.scratch, args.cwd, 'docs/guide.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace(`${start}\n`, `${start}\r\n`));
  } });
  assert.deepEqual(result.generatedBlockProofs, []);
  assert.equal(checkPrimaryChange(result, f.args.headSha).reason, 'primary-change-reverted');
});

test('shared collection consumes the proof and continues to other primary files', async t => {
  const f = fixture(t);
  // A second author file still reverted must keep the PR refused.
  f.evidence.primaryFiles.push({ filename: 'settings.txt', status: 'modified', additions: 1,
    deletions: 1, patch: '@@ -1 +1 @@\n-base\n+author' });
  const result = await fetchPrimaryChange(f.args, {
    fetchCiCostImpl: async () => f.evidence.ciCost,
    proveGeneratedBlocksImpl: (args, evidence, refusal) => proveGeneratedBlocks(args, evidence, refusal, { runGeneratorImpl: offlineGenerator }),
  });
  assert.equal(result.generatedBlockProofs.length, 1);
  assert.equal(checkPrimaryChange(result, f.args.headSha).path, 'settings.txt');
});

test('invalid manifest entries grant no derived authority', () => {
  for (const entry of [{ ...declaration, path: '../escape.md' }, { ...declaration, cwd: '/tmp' },
    { ...declaration, command: 'node render.mjs' }, { ...declaration, end: start }]) {
    assert.deepEqual(declaredGeneratedBlocks({ generatedArtifacts: [entry] }), []);
  }
});

test('Linux sandbox creates mount parents and exposes only the loader cache from /etc', async t => {
  const scratch = mkdtempSync(join(tmpdir(), 'derived-linux-layout-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const nested = join(scratch, 'run', 'user', '123', 'tmp', 'scratch');
  mkdirSync(nested, { recursive: true });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  let invocation;
  t.mock.method(childProcess, 'spawn', (executable, args, options) => {
    invocation = { executable, args, options };
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await runDerivedGenerator({ scratch: nested, cwd: '.', command: ['node', '-e', 'process.exit(0)'] });
  assert.equal(invocation.executable, 'bwrap');
  const args = invocation.args;
  assert.ok(args.indexOf('--tmpfs') < args.indexOf('--bind'));
  assert.equal(args[args.indexOf('--tmpfs') + 1], '/tmp');
  assert.ok(args.some((arg, index) => arg === '--dir' && args[index + 1] === '/etc'));
  // Model an empty sandbox root: each --dir must have an existing parent.
  // Use the real scratch path because macOS canonicalizes /var to /private/var.
  const directories = new Set(['/', '/tmp']);
  for (let index = 0; index < args.indexOf('--bind'); index++) {
    if (args[index] !== '--dir') continue;
    const path = args[index + 1];
    assert.ok(directories.has(dirname(path)), `missing parent for ${path}`);
    directories.add(path);
  }
  assert.ok(directories.has(dirname(args[args.indexOf('--bind') + 1])));
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--ro-bind' && args[index + 1].startsWith('/etc')) {
      assert.equal(args[index + 1], '/etc/ld.so.cache');
      assert.equal(args[index + 2], '/etc/ld.so.cache');
    }
  }
  assert.ok(args.includes('--unshare-all'));
  assert.equal(invocation.options.env.GITHUB_TOKEN, undefined);
});

test('real generator sandbox denies network and outside writes; bounds hung generators', {
  skip: !['darwin', 'linux'].includes(process.platform),
}, async t => {
  const scratch = mkdtempSync(join(tmpdir(), 'derived-sandbox-'));
  const outside = mkdtempSync(join(tmpdir(), 'derived-sandbox-outside-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const command = code => [process.execPath, '-e', code];
  // Restricted hosts can forbid even the OS sandbox control invocation.
  try { await runDerivedGenerator({ scratch, cwd: '.', command: command('process.exit(0)') }); }
  catch (error) {
    if (/sandbox_apply: Operation not permitted|spawn bwrap ENOENT|No permissions to create new namespace|Creating new namespace failed: Operation not permitted/.test(error.message)) {
      const f = fixture(t);
      assert.deepEqual((await prove(f, { runGeneratorImpl: runDerivedGenerator })).generatedBlockProofs, []);
      return t.skip(`sandbox unavailable; verified fail-closed behavior: ${error.message}`);
    }
    throw error;
  }
  await assert.rejects(runDerivedGenerator({ scratch, cwd: '.',
    command: command(`require('node:fs').writeFileSync(${JSON.stringify(join(outside, 'sentinel'))}, 'denied')`) }));
  writeFileSync(join(outside, 'sentinel'), 'private host content');
  await assert.rejects(runDerivedGenerator({ scratch, cwd: '.',
    command: command(`require('node:fs').readFileSync(${JSON.stringify(join(outside, 'sentinel'))})`) }));
  // Binding a loopback socket proves network denial without live traffic.
  await assert.rejects(runDerivedGenerator({ scratch, cwd: '.',
    command: command("require('node:net').createServer().on('error', () => process.exit(1)).listen(0, '127.0.0.1')") }));
  await assert.rejects(runDerivedGenerator({ scratch, cwd: '.', timeoutMs: 100,
    command: command('setInterval(() => {}, 1000)') }), /timed out/);
  const f = fixture(t);
  let generatorFailure;
  const result = await prove(f, { runGeneratorImpl: async args => {
    // Surface a real sandbox startup/generation regression rather than letting
    // the optional proof collector swallow the useful failure diagnostic.
    try { await runDerivedGenerator(args); }
    catch (error) { generatorFailure = error; throw error; }
  } });
  assert.ifError(generatorFailure);
  assert.equal(checkPrimaryChange(result, f.args.headSha).ok, true);
});

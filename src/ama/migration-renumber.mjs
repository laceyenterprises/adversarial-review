import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';

const SHA = /^[0-9a-f]{40}$/i;
const LIMIT = 1024 * 1024;
const TIMESTAMP = /^\d{8}(?:_?\d{6}|T\d{6}Z)?_/;
const CLASS = 'mechanical-migration-renumber';
const blobSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

function migration(path) {
  if (typeof path !== 'string' || path.split('/').some(part => !part || part === '..' || part === '.')
    || /[\\\x00-\x1f]/.test(path)) return null;
  const match = /^(.*(?:^|\/)(?:migrations\/(?:versions\/)?|alembic\/versions\/))(\d+)_([a-zA-Z0-9_]+)\.py$/.exec(path);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return null;
  return { directory: match[1], number: Number(match[2]), name: match[3],
    identity: match[3].replace(TIMESTAMP, ''),
    stem: `${match[2]}_${match[3]}` };
}

// A small lexical reader, never Python execution. Strings (including triple
// quoted SQL) and comments are opaque: metadata-looking operation text cannot
// become a revision assignment or a registry entry.
function tokens(text) {
  const result = [];
  const pattern = /#[^\n]*|(?:[rRuUbBfF]{0,2})(?:"""(?:\\[\s\S]|(?!""")[^\\])*"""|'''(?:\\[\s\S]|(?!''')[^\\])*'''|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*')|[A-Za-z_]\w*|\d+|\S/g;
  for (const match of text.matchAll(pattern)) {
    if (match[0].startsWith('#')) continue;
    result.push({ value: match[0], start: match.index, end: match.index + match[0].length });
  }
  return result;
}

function literal(token) {
  const match = /^(?:(["'])([A-Za-z0-9_./-]+)\1|(\d+))$/.exec(token?.value || '');
  return match ? { value: match[2] ?? match[3], quote: match[1] || '' } : null;
}

function revisionLiteral(token, info, predecessor = false) {
  const parsed = literal(token);
  if (!parsed) return false;
  if (predecessor && info.predecessors) return parsed.quote && info.predecessors.has(parsed.value);
  const number = predecessor ? info.number - 1 : info.revisionNumber ?? info.number;
  if (parsed.quote) {
    const match = /^(\d+)(?:_([A-Za-z0-9_]+))?$/.exec(parsed.value);
    if (match && Number(match[1]) === number && (predecessor || !match[2] || match[2] === info.name || info.name.endsWith(`_${match[2]}`))) return true;
    const suffix = /^([A-Za-z0-9_]+)_(\d+)$/.exec(parsed.value);
    return !!suffix && Number(suffix[2]) === number && (predecessor || info.name === suffix[1] || info.name.endsWith(`_${suffix[1]}`));
  }
  return Number(parsed.value) === number;
}

function replace(text, edits) {
  for (const { start, end, value } of edits.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, start) + value + text.slice(end);
  }
  return text;
}

function scalarRevision(text, name) {
  const list = tokens(text), values = [];
  for (let i = 0; i < list.length - 2; i++) {
    if (['def', 'class', 'async'].includes(list[i].value)
      && (list[i].start === 0 || text[list[i].start - 1] === '\n')) break;
    if (list[i].value !== name || list[i].start > 0 && text[list[i].start - 1] !== '\n') continue;
    const offset = list[i + 1].value === ':' && list[i + 2].value === 'str' ? 3 : 1;
    const value = list[i + offset + 1], parsed = literal(value);
    if (list[i + offset]?.value !== '=' || !parsed?.quote) return null;
    const tail = text.slice(value.end, text.indexOf('\n', value.end) < 0 ? text.length : text.indexOf('\n', value.end));
    if (tail.trim().replace(/^#.*$/, '') !== '') return null;
    values.push(parsed.value);
  }
  return values.length === 1 ? values[0] : null;
}

function migrationBody(text, info, module = false) {
  const list = tokens(text), edits = [];
  let revision = 0, predecessor = 0;
  for (let index = 0; index < list.length; index++) {
    const token = list[index];
    if (['def', 'class', 'async'].includes(token.value)
      && (token.start === 0 || text[token.start - 1] === '\n')) break;
    if (!module && /^SOURCE_NAME$/i.test(token.value) && (token.start === 0 || text[token.start - 1] === '\n')
      && list[index + 1]?.value === '=' && literal(list[index + 2])?.quote) {
      const value = list[index + 2], parsed = literal(value);
      // Only a leading timestamp changes; the SQL identity and quote survive.
      const normalized = parsed.value.replace(TIMESTAMP, '<timestamp>_');
      if (normalized !== parsed.value) edits.push({ ...value, value: `${parsed.quote}${normalized}${parsed.quote}` });
    }
    if (!/^(?:revision|down_revision)$/i.test(token.value)
      || (token.start > 0 && text[token.start - 1] !== '\n')) continue;
    let next = index + 1;
    // Conventional Alembic scalar annotations only; complex expressions refuse.
    if (list[next]?.value === ':') {
      next++;
      if (!['str', 'int'].includes(list[next++]?.value)) return null;
    }
    if (list[next++]?.value !== '=') continue;
    const down = /^down_/i.test(token.value);
    const tuple = list[next]?.value === '(';
    if (tuple) next++;
    const value = list[next];
    if (!revisionLiteral(value, info, down)) return null;
    // Only the first member of a revision tuple is mechanical. Its remaining
    // members, like every operation byte, must survive exactly.
    if (tuple && list[next + 1]?.value !== ',') return null;
    if (!tuple && text.slice(value.end, text.indexOf('\n', value.end) < 0 ? text.length : text.indexOf('\n', value.end)).trim()
      .replace(/^#.*$/, '') !== '') return null;
    const parsed = literal(value);
    edits.push({ ...value, value: `${parsed.quote}<revision>${parsed.quote}` });
    if (down) predecessor++; else revision++;
  }
  if (module ? revision > 2 || predecessor !== 0 : !revision || revision > 2 || predecessor !== 1) return null;
  // Alembic's module docstring may repeat these two identifiers. Restrict this
  // allowance to the first token, never arbitrary strings in the operations.
  const doc = list[0];
  if (/^(?:"""|''')/.test(doc?.value || '')) {
    const normalized = doc.value.replace(/^([ \t]*)(Revision ID:|Revises:)([ \t]*)([A-Za-z0-9_]+)([ \t]*)$/gm,
      (line, indent, label, space, value, tail) => revisionLiteral({ value: `"${value}"` }, info, label === 'Revises:')
        ? `${indent}${label}${space}<revision>${tail}` : line);
    edits.push({ ...doc, value: normalized });
  }
  return replace(text, edits);
}

function registryBody(text, infos) {
  const list = tokens(text), edits = [];
  const matches = infos.map(() => 0);
  const rows = new Set();
  for (let index = 0; index < list.length - 2; index++) {
    const declaration = list[index];
    if (!/^_?(?:revisions|migrations|revision_registry|migration_registry)$/i.test(declaration.value)
      || declaration.start > 0 && text[declaration.start - 1] !== '\n'
      || list[index + 1].value !== '=' || !['[', '('].includes(list[index + 2].value)) continue;
    let depth = 1;
    for (let cursor = index + 3; cursor < list.length && depth > 0; cursor++) {
      if (depth === 1 && list[cursor].value === '(') rows.add(cursor);
      if (['[', '(', '{'].includes(list[cursor].value)) depth++;
      if ([']', ')', '}'].includes(list[cursor].value)) depth--;
    }
  }
  for (let index = 0; index < list.length - 4; index++) {
    const [open, number, comma, name, close] = list.slice(index, index + 5);
    const parsed = literal(name);
    if (!rows.has(index) || open.value !== '(' || comma.value !== ',' || close.value !== ')'
      || !/^\d+$/.test(number.value) || !parsed?.quote) continue;
    const candidates = infos.flatMap((info, candidate) => Number(number.value) === info.number
      && [info.name, info.stem, `${info.stem}.py`].includes(parsed.value) ? [candidate] : []);
    if (!candidates.length) continue;
    if (candidates.length !== 1) return null;
    const candidate = candidates[0];
    matches[candidate]++;
    edits.push({ ...number, value: `<revision:${candidate}>` },
      { ...name, value: `${parsed.quote}<migration:${candidate}>${parsed.quote}` });
  }
  return matches.every(count => count === 1) ? replace(text, edits) : null;
}

// Module registries are explicit literal sequences. Do not normalize imports,
// calls, comments or strings outside the named top-level sequence.
function moduleRegistry(text, name) {
  const list = tokens(text), edits = [];
  let matches = 0;
  for (let i = 0; i < list.length - 2; i++) {
    const token = list[i];
    if (!/^_?(?:module_names|revision_modules|migration_modules)$/i.test(token.value)
      || token.start > 0 && text[token.start - 1] !== '\n'
      || list[i + 1].value !== '=' || !['[', '('].includes(list[i + 2].value)) continue;
    const close = list[i + 2].value === '[' ? ']' : ')';
    let cursor = i + 3;
    for (; cursor < list.length && list[cursor].value !== close; cursor++) {
      const parsed = literal(list[cursor]);
      if (list[cursor].value === ',') continue;
      if (!parsed?.quote) return null;
      if (parsed.value === name) {
        matches++;
        edits.push({ ...list[cursor], value: `${parsed.quote}<module>${parsed.quote}` });
      }
    }
    if (cursor === list.length) return null;
  }
  return matches === 1 ? replace(text, edits) : null;
}

// SQL-backed author migrations can predate their ordinal Python module. Read
// the generated data declaration as literals only, never execute Python. Every
// operation byte is the author's SQL, and downgrade bytes stay identical across
// all observed module snapshots.
function sqlModule(text, info, sourceName, sql) {
  const list = tokens(text), edits = [];
  const prefix = ['from', '.', '_types', 'import', 'PostgresMigration', 'MIGRATION', '=', 'PostgresMigration', '('];
  if (!prefix.every((value, index) => list[index]?.value === value)) return null;
  let index = prefix.length;
  const string = () => {
    const token = list[index++];
    try {
      const value = JSON.parse(token?.value);
      return typeof value === 'string' ? { token, value } : null;
    } catch { return null; }
  };
  for (const field of ['revision', 'down_revision', 'source_name', 'raw_sql']) {
    if (list[index++]?.value !== field || list[index++]?.value !== '=') return null;
    const parsed = string();
    if (!parsed || list[index++]?.value !== ',') return null;
    if (field === 'raw_sql') { if (parsed.value !== sql) return null; }
    else if (field === 'source_name') {
      if (parsed.value !== sourceName) return null;
      edits.push({ ...parsed.token, value: JSON.stringify(parsed.value.replace(TIMESTAMP, '<timestamp>_')) });
    } else {
      if (!revisionLiteral(parsed.token, info, field === 'down_revision')) return null;
      edits.push({ ...parsed.token, value: '"<revision>"' });
    }
  }
  if (list[index++]?.value !== 'downgrade_sql' || list[index++]?.value !== '=' || list[index++]?.value !== '(') return null;
  while (index < list.length && list[index]?.value !== ')') {
    if (!string() || list[index++]?.value !== ',') return null;
  }
  if (list[index++]?.value !== ')' || list[index++]?.value !== ',' || list[index++]?.value !== ')'
    || index !== list.length) return null;
  return replace(text, edits);
}

function removeModule(text, name) {
  if (moduleRegistry(text, name) === null) return null;
  const matches = tokens(text).filter(token => literal(token)?.value === name);
  if (matches.length !== 1) return null;
  const token = matches[0], start = text.lastIndexOf('\n', token.start) + 1;
  const end = text.indexOf('\n', token.end);
  if (end < 0 || text.slice(start, token.start).trim() || text.slice(token.end, end).trim() !== ',') return null;
  return text.slice(0, start) + text.slice(end + 1);
}

async function fileAt({ repo, get }, head, path) {
  const parts = path.split('/');
  if (parts.length > 32) throw new Error('migration directory depth exceeded');
  let ref = head;
  for (const [index, part] of parts.entries()) {
    const tree = await get(`repos/${repo}/git/trees/${ref}`);
    if (tree?.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > 10000) throw new Error('incomplete migration tree');
    const entry = tree.tree.find(entry => entry.path === part && SHA.test(entry.sha || '')
      && entry.type === (index === parts.length - 1 ? 'blob' : 'tree'));
    if (!entry) return null;
    ref = entry.sha;
  }
  return ref;
}

async function sqlModuleProof(args, evidence, { source, destination, before, after }, blob) {
  const root = before.directory.slice(0, -'alembic/versions/'.length);
  if (evidence.primaryFiles.some(file => file.filename.startsWith(`${root}src/`)
    && /\/[^/]*revisions\/(?:r\d+\.py|__init__\.py)$/.test(file.filename))) return null;
  const sourceName = scalarRevision(await blob(source.sha), 'SOURCE_NAME');
  const finalName = scalarRevision(await blob(destination.sha), 'SOURCE_NAME');
  if (!sourceName || !finalName || sourceName.includes('/') || finalName.includes('/')) return null;
  const sqlSources = evidence.primaryFiles.filter(file => file.status === 'added' && SHA.test(file.sha || '')
    && file.filename.startsWith(`${root}src/`) && file.filename.endsWith(`/migrations/${sourceName}`));
  if (sqlSources.length !== 1) return null;
  const sqlSource = sqlSources[0], sqlDestination = posix.join(posix.dirname(sqlSource.filename), finalName);
  const sqlFinal = evidence.finalFiles.find(file => file.filename === sqlDestination && SHA.test(file.sha || '')
    && (file.status === 'added' || file.status === 'renamed' && file.previous_filename === sqlSource.filename));
  if (!sqlFinal || sqlDestination !== sqlSource.filename && evidence.finalFiles.some(file => file.filename === sqlSource.filename && file.status !== 'removed')) return null;
  const sql = await blob(sqlSource.sha);
  if (sql !== await blob(sqlFinal.sha)) return null;
  const modules = evidence.finalFiles.filter(file => file.status === 'added' && SHA.test(file.sha || '')
    && file.filename.startsWith(`${root}src/`) && /\/[^/]*revisions\/r\d+\.py$/.test(file.filename));
  if (modules.length > 8) return null;
  const matches = [];
  for (const module of modules) {
    const normalized = sqlModule(await blob(module.sha), after, finalName, sql);
    if (normalized !== null) matches.push({ module, normalized });
  }
  if (!modules.length && evidence.headSha !== args.proofHeadSha) return {
    path: source.filename, destination: destination.filename, primaryBlob: source.sha, blob: destination.sha,
    headSha: evidence.headSha, sqlOnly: true, sqlPath: sqlSource.filename, primarySqlBlob: sqlSource.sha,
  };
  if (matches.length !== 1) return null;
  const { module, normalized } = matches[0], registryPath = posix.join(posix.dirname(module.filename), '__init__.py');
  // This path supplies no waiver for an author-owned module or registry. Those
  // must use the original paired-module / exact registry-swap proof.
  if (evidence.primaryFiles.some(file => file.filename === registryPath
    || file.filename === posix.join(posix.dirname(module.filename), `r${before.number}.py`))) return null;
  const registry = evidence.finalFiles.find(file => file.filename === registryPath && file.status === 'modified' && SHA.test(file.sha || ''));
  if (!registry) return null;
  let mergeBase = evidence.snapshotMergeBase;
  if (!mergeBase) {
    const comparison = await args.metadata(`repos/${args.repo}/compare/${evidence.baseSha || evidence.mergeBase}...${evidence.headSha}`);
    mergeBase = comparison.merge_base_commit?.sha;
  }
  if (!SHA.test(mergeBase || '')) throw new Error('invalid snapshot merge base');
  const registryBase = await fileAt(args, mergeBase, registryPath);
  if (!registryBase || removeModule(await blob(registry.sha), posix.basename(module.filename, '.py')) !== await blob(registryBase)) return null;
  // A newly occupied slot must be absent in the snapshot's base tree.
  if (await fileAt(args, mergeBase, module.filename)) return null;
  return { classification: CLASS, path: source.filename, destination: destination.filename,
    primaryBlob: source.sha, blob: destination.sha, registryPath, primaryRegistryBlob: registryBase, registryBlob: registry.sha,
    moduleOrigin: 'author-sql', moduleDestination: module.filename, moduleBlob: module.sha,
    moduleIdentity: blobSha(Buffer.from(normalized)), snapshotMergeBase: mergeBase,
    sqlPath: sqlSource.filename, sqlDestination, primarySqlBlob: sqlSource.sha, sqlBlob: sqlFinal.sha,
    headSha: evidence.headSha, primaryHead: evidence.primaryHead, mergeBase: evidence.mergeBase };
}

async function moduleProof(evidence, { source, destination, before, after }, blob) {
  const root = before.directory.slice(0, -'alembic/versions/'.length);
  const modules = evidence.primaryFiles.filter(file => file.status === 'added'
    && file.filename.startsWith(`${root}src/`)
    && /\/[^/]*revisions\/r\d+\.py$/.test(file.filename)
    && posix.basename(file.filename) === `r${before.number}.py` && SHA.test(file.sha || ''));
  const matches = [];
  for (const module of modules) {
    if (evidence.finalFiles.some(file => file.filename === module.filename && file.status !== 'removed')) continue;
    const moduleDestination = posix.join(posix.dirname(module.filename), `r${after.number}.py`);
    const final = evidence.finalFiles.find(file => file.filename === moduleDestination && SHA.test(file.sha || '')
      && (file.status === 'added' || file.status === 'renamed' && file.previous_filename === module.filename));
    if (!final) continue;
    const original = migrationBody(await blob(module.sha), before, true);
    if (original === null || original !== migrationBody(await blob(final.sha), after, true)) continue;
    const registryPath = posix.join(posix.dirname(module.filename), '__init__.py');
    const registry = evidence.primaryFiles.find(file => file.filename === registryPath
      && ['added', 'modified'].includes(file.status) && SHA.test(file.sha || ''));
    const registryFinal = evidence.finalFiles.find(file => file.filename === registryPath
      && file.status === registry?.status && SHA.test(file.sha || ''));
    if (!registry || !registryFinal || registry.sha === registryFinal.sha) continue;
    const initial = moduleRegistry(await blob(registry.sha), `r${before.number}`);
    if (initial === null || initial !== moduleRegistry(await blob(registryFinal.sha), `r${after.number}`)) continue;
    matches.push({ classification: CLASS, path: source.filename, destination: destination.filename,
      primaryBlob: source.sha, blob: destination.sha, registryPath,
      primaryRegistryBlob: registry.sha, registryBlob: registryFinal.sha,
      modulePath: module.filename, moduleDestination, primaryModuleBlob: module.sha, moduleBlob: final.sha,
      headSha: evidence.headSha, primaryHead: evidence.primaryHead, mergeBase: evidence.mergeBase });
  }
  return matches.length === 1 ? matches[0] : null;
}

function candidates(evidence, allowRetained = false) {
  const pairs = [];
  for (const source of evidence.primaryFiles || []) {
    const before = migration(source.filename);
    // Author-added files only. Restoring a pre-existing migration is never
    // disguised as a renumber, nor is renaming across migration directories.
    if (!before || source.status !== 'added' || !SHA.test(source.sha || '')
      || !allowRetained && evidence.finalFiles?.some(file => file.filename === source.filename && file.status !== 'removed')) continue;
    const destinations = (evidence.finalFiles || []).filter(file => {
      const after = migration(file.filename);
      return after && after.directory === before.directory && after.identity === before.identity
        && (allowRetained ? after.number >= before.number : after.number > before.number) && SHA.test(file.sha || '')
        && (file.status === 'added' || file.status === 'renamed' && file.previous_filename === source.filename);
    });
    if (destinations.length === 1) pairs.push({ source, destination: destinations[0], before,
      after: migration(destinations[0].filename) });
  }
  return pairs;
}

// Prefer the existing complete small-tree response; large repositories fall
// back to walking just the migration directory. Bounds apply to that directory,
// rather than rejecting every migration in a repository with many files.
async function migrationTree({ repo, get }, head, directory) {
  const whole = await get(`repos/${repo}/git/trees/${head}?recursive=1`);
  if (whole?.truncated === false && Array.isArray(whole.tree) && whole.tree.length <= 10000) return whole.tree;
  let ref = head;
  const parts = directory.replace(/\/$/, '').split('/');
  if (parts.length > 32) throw new Error('migration directory depth exceeded');
  for (const part of parts) {
    const tree = await get(`repos/${repo}/git/trees/${ref}`);
    if (tree?.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > 10000) throw new Error('incomplete migration tree');
    const entry = tree.tree.find(entry => entry.path === part && entry.type === 'tree' && SHA.test(entry.sha || ''));
    if (!entry) throw new Error('missing migration directory');
    ref = entry.sha;
  }
  const tree = await get(`repos/${repo}/git/trees/${ref}`);
  if (tree?.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > 10000) throw new Error('incomplete migration tree');
  return tree.tree.map(entry => ({ ...entry, path: directory + entry.path }));
}

async function proveSnapshot(args, evidence) {
  const { repo, get, signal: deadline, record } = args;
  const refuse = reason => { record(reason, evidence.headSha); return []; };
  if (evidence.hasHammerCommits !== true || !SHA.test(evidence.headSha || '')
    || !SHA.test(evidence.primaryHead || '') || !SHA.test(evidence.mergeBase || '')) return refuse('invalid-evidence');
  if (!Array.isArray(evidence.primaryFiles) || !Array.isArray(evidence.finalFiles)
    || evidence.completeFileLists !== true && [evidence.primaryFiles, evidence.finalFiles].some(files => files.length >= 300)) return refuse('snapshot-files-incomplete');
  const pairs = candidates(evidence, evidence.headSha !== args.proofHeadSha);
  if (!pairs.length) return refuse('snapshot-no-candidates');
  if (pairs.length > 8) return refuse('snapshot-candidate-limit');
  const cache = new Map();
  const blob = async sha => {
    if (!cache.has(sha)) cache.set(sha, (async () => {
      deadline.throwIfAborted();
      const data = await get(`repos/${repo}/git/blobs/${sha}`);
      deadline.throwIfAborted();
      if (data.encoding !== 'base64' || typeof data.content !== 'string' || data.content.length > LIMIT * 2) throw new Error('invalid migration blob');
      const bytes = Buffer.from(data.content, 'base64');
      if (bytes.length > LIMIT || bytes.length !== data.size || blobSha(bytes) !== sha
        || !Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new Error('invalid migration blob');
      return bytes.toString('utf8');
    })());
    return cache.get(sha);
  };
  const proofs = [];
  // Only body-verified pairs may share registry normalization. A changed
  // operation in a sibling migration must never gain registry authority.
  const verified = [];
  for (const pair of pairs) {
    if (pair.before.directory.endsWith('alembic/versions/')) {
      // A changed predecessor is authority only if its exact revision exists
      // in the immutable snapshot, outside the candidate wrapper itself.
      for (const [info, head, path] of [[pair.before, evidence.primaryHead, pair.source.filename],
        [pair.after, evidence.headSha, pair.destination.filename]]) {
        const tree = await migrationTree(args, head, info.directory);
        info.predecessors = new Set();
        const wrapper = await blob(head === evidence.primaryHead ? pair.source.sha : pair.destination.sha);
        // Filename slots and declared revision numbers can temporarily differ
        // while a rebase repairs a collision. Only author-to-slot numbers are
        // mechanical, and the literal identity must still match the wrapper.
        const declared = scalarRevision(wrapper, 'revision');
        const revisionNumber = Number(/^(\d+)(?:_|$)/.exec(declared || '')?.[1] ?? /_(\d+)$/.exec(declared || '')?.[1]);
        if (head !== evidence.primaryHead && evidence.headSha !== args.proofHeadSha && Number.isSafeInteger(revisionNumber)
          && revisionNumber >= pair.before.number && revisionNumber <= (args.finalNumbers.get(pair.source.filename) ?? info.number)) info.revisionNumber = revisionNumber;
        const target = scalarRevision(wrapper, 'down_revision');
        const prefix = /^(\d+)(?:_|$)/.exec(target || ''), suffix = /_(\d+)$/.exec(target || '');
        const number = Number(prefix?.[1] ?? suffix?.[1]);
        if (!Number.isSafeInteger(number) || number >= Math.max(info.number, info.revisionNumber ?? info.number)) continue;
        const entries = tree.filter(entry => {
          const candidate = migration(entry.path);
          return entry.type === 'blob' && SHA.test(entry.sha || '') && entry.path !== path
            && candidate?.directory === info.directory && candidate.number === number;
        });
        if (entries.length > 8) throw new Error('ambiguous predecessor');
        for (const entry of entries) {
          const revision = scalarRevision(await blob(entry.sha), 'revision');
          if (revision === target && revisionLiteral({ value: `"${revision}"` }, migration(entry.path))) info.predecessors.add(revision);
        }
      }
    }
    const original = migrationBody(await blob(pair.source.sha), pair.before);
    if (original !== null && original === migrationBody(await blob(pair.destination.sha), pair.after)) verified.push(pair);
    else record('snapshot-body-mismatch', evidence.headSha, pair.source.filename);
  }
  for (const pair of verified) {
    const { source, destination, before } = pair;
    if (before.directory.endsWith('alembic/versions/')) {
      const proof = await moduleProof(evidence, pair, blob)
        || await sqlModuleProof(args, evidence, pair, blob);
      if (proof) proofs.push(proof);
      else record('snapshot-module-registry-mismatch', evidence.headSha, source.filename);
      continue;
    }
    const batch = verified.filter(pair => pair.before.directory === before.directory);
    const directory = before.directory.replace(/versions\/$/, '');
    const registries = (evidence.primaryFiles || []).filter(file =>
      posix.dirname(file.filename) + '/' === directory
      && ['__init__.py', 'registry.py', 'revisions.py'].includes(posix.basename(file.filename))
      && ['added', 'modified'].includes(file.status) && SHA.test(file.sha || ''));
    for (const registry of registries) {
      const final = evidence.finalFiles.find(file => file.filename === registry.filename && file.status === registry.status && SHA.test(file.sha || ''));
      if (!final || final.sha === registry.sha) continue;
      const initial = registryBody(await blob(registry.sha), batch.map(pair => pair.before));
      if (initial === null || initial !== registryBody(await blob(final.sha), batch.map(pair => pair.after))) continue;
      proofs.push({ classification: CLASS, path: source.filename, destination: destination.filename,
        primaryBlob: source.sha, blob: destination.sha, registryPath: registry.filename,
        primaryRegistryBlob: registry.sha, registryBlob: final.sha,
        headSha: evidence.headSha, primaryHead: evidence.primaryHead, mergeBase: evidence.mergeBase });
      break;
    }
  }
  if (!proofs.length) record('snapshot-unproven', evidence.headSha);
  return proofs;
}

// The array return remains compatible with callers. Every unsuccessful attempt
// records a structured refusal on the supplied transient evidence, outside the
// history cache, so a failed optional proof can explain the existing refusal.
export async function proveMigrationRenumbers(args, evidence) {
  const diagnostics = evidence.migrationRenumberDiagnostics = [];
  delete evidence.migrationRenumberAncestry;
  const record = (reason, headSha = evidence.headSha, path, detail) => {
    if (diagnostics.length === 128) diagnostics.shift();
    diagnostics.push({ proven: false, reason, headSha,
      ...(path ? { path } : {}), ...(detail ? { detail: String(detail).slice(0, 300) } : {}) });
  };
  const refuse = reason => { record(reason); return []; };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('migration proof deadline exceeded', 'TimeoutError')),
    loadAwareTimeoutMs(90000, { maxMs: 180000 }));
  const deadline = AbortSignal.any([...(args.signal ? [args.signal] : []), controller.signal]);
  const cache = new Map(), get = args.get;
  const read = (path, reader, key = path) => {
    if (!cache.has(key)) {
      const pending = (async () => {
        deadline.throwIfAborted();
        if (cache.size >= 512) throw new Error('migration read budget exhausted');
        return new Promise((accept, reject) => {
          const abort = () => reject(deadline.reason);
          deadline.addEventListener('abort', abort, { once: true });
          Promise.resolve().then(() => reader(path)).then(accept, reject)
            .finally(() => deadline.removeEventListener('abort', abort));
        });
      })();
      cache.set(key, pending);
    }
    return cache.get(key);
  };
  args = { ...args, signal: deadline, record, proofHeadSha: evidence.headSha,
    finalNumbers: new Map(), get: path => read(path, get),
    metadata: path => read(path, get.metadata || get, `metadata:${path}`) };
  try {
    const range = evidence.diagnosticCommitRange || [{ sha: evidence.headSha }];
    if (!Array.isArray(range) || !range.length || range.length > 64 || range.at(-1)?.sha !== evidence.headSha
      || range.some(entry => !SHA.test(entry?.sha || ''))
      || new Set(range.map(entry => entry.sha)).size !== range.length) return refuse('range-invalid');
    if (Array.isArray(evidence.primaryFiles) && Array.isArray(evidence.finalFiles)) {
      args.finalNumbers = new Map(candidates(evidence).map(pair => [pair.source.filename, pair.after.number]));
    }
    const proofs = await proveSnapshot(args, evidence);
    if (!proofs.length) return refuse('final-snapshot-unproven');
    const snapshots = [];
    for (const entry of range) {
      if (entry.sha === evidence.headSha) { snapshots.push(proofs); continue; }
      // Each rebased head has its own merge base. Compare its immutable tree
      // with the same protected author bytes, never a rewritten author head.
      const snapshot = await args.get(`repos/${args.repo}/compare/${evidence.baseSha || evidence.mergeBase}...${entry.sha}`);
      if (!SHA.test(snapshot.merge_base_commit?.sha || '')) return refuse('snapshot-merge-base-invalid');
      if (!Array.isArray(snapshot.files) || snapshot.filesComplete !== true && snapshot.files.length >= 300) return refuse('snapshot-files-incomplete');
      const batch = await proveSnapshot(args, { ...evidence, headSha: entry.sha,
        snapshotMergeBase: snapshot.merge_base_commit.sha,
        finalFiles: snapshot.files, completeFileLists: snapshot.filesComplete === true });
      for (const proof of proofs) {
        const originals = [[proof.path, proof.primaryBlob],
          ...(proof.moduleOrigin === 'author-sql' ? [[proof.sqlPath, proof.primarySqlBlob]]
            : [[proof.registryPath, proof.primaryRegistryBlob], ...(proof.modulePath ? [[proof.modulePath, proof.primaryModuleBlob]] : [])])];
        if (!(proof.moduleOrigin === 'author-sql' && snapshot.files.some(file =>
          posix.dirname(file.filename) === posix.dirname(proof.moduleDestination) && /\/r\d+\.py$/.test(file.filename) && file.status !== 'removed'))
          && originals.every(([path, sha]) => snapshot.files.some(file => file.filename === path
          && file.sha === sha && file.status === evidence.primaryFiles.find(source => source.filename === path)?.status))) {
          batch.push({ path: proof.path, destination: proof.path, blob: proof.primaryBlob, headSha: entry.sha, unchangedAuthor: true });
        }
      }
      snapshots.push(batch);
    }
    const complete = proofs.filter(proof => {
      if (snapshots.every(batch => batch.some(item => item.path === proof.path
        && (proof.moduleOrigin !== 'author-sql' || item.unchangedAuthor === true || item.sqlOnly === true || item.moduleIdentity === proof.moduleIdentity)))) return true;
      record('snapshot-proof-missing', evidence.headSha, proof.path);
      return false;
    });
    const result = [];
    for (const proof of complete) {
      let rebased = false;
      const chain = [{ headSha: evidence.primaryHead, path: proof.path, blob: proof.primaryBlob }];
      for (const batch of snapshots) {
        const item = batch.find(item => item.path === proof.path);
        if (chain.at(-1).path === item.destination && chain.at(-1).blob === item.blob) {
          if (chain.length > 1) chain.at(-1).headSha = item.headSha;
          continue;
        }
        const previous = migration(chain.at(-1).path), next = migration(item.destination);
        if (next.number <= previous.number && !rebased) {
          const ancestry = await args.metadata(`repos/${args.repo}/compare/${evidence.primaryHead}...${evidence.headSha}`);
          if (ancestry.status !== 'diverged') throw new Error('non-increasing renumber chain');
          rebased = true;
          evidence.migrationRenumberAncestry = { primaryHead: evidence.primaryHead, headSha: evidence.headSha, status: 'diverged' };
        }
        if (next.number < migration(proof.path).number) throw new Error('non-increasing renumber chain');
        chain.push({ headSha: item.headSha, path: item.destination, blob: item.blob });
      }
      result.push({ ...proof, chain, ...(rebased ? { rebased: true } : {}) });
    }
    return result;
  } catch (error) {
    const reason = deadline.aborted ? (deadline.reason?.name === 'TimeoutError' ? 'deadline-exceeded' : 'aborted')
      : error?.message === 'migration read budget exhausted' ? 'read-budget-exhausted'
        : error?.message === 'non-increasing renumber chain' ? 'chain-non-increasing'
          : error?.message === 'invalid snapshot merge base' ? 'snapshot-merge-base-invalid'
            : error?.message === 'invalid migration blob' ? 'snapshot-blob-invalid'
              : error?.message === 'incomplete migration tree' ? 'snapshot-tree-incomplete' : 'snapshot-read-failed';
    record(reason, evidence.headSha, undefined, error?.message || error);
    return [];
  } finally { clearTimeout(timer); }
}

function verifiedSqlBinding(evidence, proof) {
  return proof.moduleOrigin === 'author-sql' && SHA.test(proof.moduleIdentity || '') && SHA.test(proof.snapshotMergeBase || '')
    && SHA.test(proof.primaryRegistryBlob || '')
    && evidence.primaryFiles.some(file => file.filename === proof.sqlPath && file.status === 'added' && file.sha === proof.primarySqlBlob)
    && evidence.finalFiles.some(file => file.filename === proof.sqlDestination && file.sha === proof.sqlBlob
      && (file.status === 'added' || file.status === 'renamed' && file.previous_filename === proof.sqlPath))
    && (proof.sqlPath === proof.sqlDestination || !evidence.finalFiles.some(file => file.filename === proof.sqlPath && file.status !== 'removed'))
    && !evidence.primaryFiles.some(file => file.filename === proof.registryPath || file.filename === proof.moduleDestination)
    && evidence.finalFiles.some(file => file.filename === proof.moduleDestination && file.status === 'added' && file.sha === proof.moduleBlob)
    && evidence.finalFiles.some(file => file.filename === proof.registryPath && file.status === 'modified' && file.sha === proof.registryBlob);
}

export function verifiedMigrationRenumbers(evidence, headSha) {
  return (evidence.migrationRenumberProofs || []).filter(proof => proof.classification === CLASS
    && proof.headSha === headSha && proof.primaryHead === evidence.primaryHead && proof.mergeBase === evidence.mergeBase
    && (!migration(proof.path)?.directory.endsWith('alembic/versions/') || typeof proof.modulePath === 'string' || verifiedSqlBinding(evidence, proof))
    && Array.isArray(proof.chain) && proof.chain.length >= 2 && proof.chain.length <= 65
    && proof.chain[0].headSha === evidence.primaryHead && proof.chain[0].path === proof.path
    && proof.chain[0].blob === proof.primaryBlob && proof.chain.at(-1).path === proof.destination
    && proof.chain.at(-1).blob === proof.blob && proof.chain.at(-1).headSha === headSha
    && proof.chain.every((entry, index) => SHA.test(entry.headSha || '') && SHA.test(entry.blob || '')
      && migration(entry.path) && (!index || migration(entry.path).directory === migration(proof.path).directory
        && migration(entry.path).identity === migration(proof.path).identity
        && (proof.rebased === true ? evidence.migrationRenumberAncestry?.status === 'diverged'
          && evidence.migrationRenumberAncestry.primaryHead === proof.primaryHead
          && evidence.migrationRenumberAncestry.headSha === headSha
          && migration(entry.path).number >= migration(proof.path).number
          : migration(entry.path).number > migration(proof.chain[index - 1].path).number)))
    && candidates(evidence).some(({ source, destination }) => source.filename === proof.path
      && source.sha === proof.primaryBlob && destination.filename === proof.destination && destination.sha === proof.blob)
    && (!proof.modulePath || evidence.primaryFiles.some(file => file.filename === proof.modulePath
      && file.status === 'added' && file.sha === proof.primaryModuleBlob
      && !evidence.finalFiles.some(final => final.filename === file.filename && final.status !== 'removed')
      && evidence.finalFiles.some(final => final.filename === proof.moduleDestination && final.sha === proof.moduleBlob
        && (final.status === 'added' || final.status === 'renamed' && final.previous_filename === file.filename))))
    && (proof.moduleOrigin === 'author-sql' ? verifiedSqlBinding(evidence, proof) : evidence.primaryFiles.some(file => file.filename === proof.registryPath && file.sha === proof.primaryRegistryBlob
      && ['added', 'modified'].includes(file.status) && evidence.finalFiles.some(final =>
        final.filename === file.filename && final.status === file.status && final.sha === proof.registryBlob))));
}

import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';

const SHA = /^[0-9a-f]{40}$/i;
const LIMIT = 1024 * 1024;
const TIMESTAMP = /^\d{8}(?:_?\d{6}|T\d{6}Z)?_/;
const CLASS = 'mechanical-migration-renumber';
const blobSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const LEDGER_REPO = 'laceyenterprises/agent-os';
const LEDGER_VERSIONS = 'platform/session-ledger/alembic/versions/';
const LEDGER_SOURCE = 'platform/session-ledger/src/session_ledger';
const LEDGER_MODULES = `${LEDGER_SOURCE}/alembic_postgres_revisions`;
const LEDGER_SQL = `${LEDGER_SOURCE}/migrations`;
// The applied RSS migration has a historical declaration/slot mismatch. The
// immutable main snapshot is the authority for this one exceptional parent.
const RSS_MAIN = '283d06e47679a91f6802f729a418746608f1e180';
const RSS_PARENT = `${LEDGER_VERSIONS}340_20261119T130000Z_e5570001_successful_rss_index.py`;
const RSS_REVISION = 'successful_rss_index_339';
const integrationProofs = new WeakMap();

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

function verifiedBlobReader({ repo, get, signal }) {
  return async sha => {
    signal.throwIfAborted();
    const data = await get(`repos/${repo}/git/blobs/${sha}`);
    signal.throwIfAborted();
    if (data.encoding !== 'base64' || typeof data.content !== 'string' || data.content.length > LIMIT * 2) throw new Error('invalid migration blob');
    const bytes = Buffer.from(data.content, 'base64');
    if (bytes.length > LIMIT || bytes.length !== data.size || blobSha(bytes) !== sha
      || !Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new Error('invalid migration blob');
    return bytes.toString('utf8');
  };
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
      // JSON's escaped slash and UTF-16 surrogate escapes do not have the
      // same value in Python. Decode only their shared string escape subset.
      const escapes = token?.value.match(/\\(?:u[0-9a-fA-F]{4}|[\s\S])/g) || [];
      if (escapes.some(escape => escape === '\\/' || /^\\u[dD][89a-fA-F]/.test(escape))) return null;
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

async function ledgerTree(args, sha) {
  const data = await args.get(`repos/${args.repo}/git/trees/${sha}`);
  if (data.truncated !== false || !Array.isArray(data.tree) || data.tree.length > 10000) throw new Error('incomplete migration tree');
  const entries = new Map();
  for (const entry of data.tree) {
    if (typeof entry.path !== 'string' || !entry.path || /[/\x00]/.test(entry.path)
      || entries.has(entry.path) || !SHA.test(entry.sha || '')
      || { '040000': 'tree', '100644': 'blob', '100755': 'blob', '120000': 'blob', '160000': 'commit' }[entry.mode] !== entry.type) {
      throw new Error('incomplete migration tree');
    }
    entries.set(entry.path, entry);
  }
  const rows = [...entries.values()].map(entry => ({
    key: Buffer.from(entry.path + (entry.type === 'tree' ? '/' : '')),
    bytes: Buffer.concat([Buffer.from(`${entry.mode.replace(/^0+/, '')} ${entry.path}\0`), Buffer.from(entry.sha, 'hex')]),
  })).sort((a, b) => Buffer.compare(a.key, b.key));
  const body = Buffer.concat(rows.map(row => row.bytes));
  if (createHash('sha1').update(`tree ${body.length}\0`).update(body).digest('hex') !== sha) {
    throw new Error('incomplete migration tree');
  }
  return entries;
}

// Check all remaining entries, including object IDs and modes. This also
// excludes a second wrapper declaring the same parent under another filename.
function exactLedgerDelta(base, head, added, modified = []) {
  return head.size === base.size + added.length
    && added.every(path => !base.has(path) && head.get(path)?.mode === '100644' && head.get(path).type === 'blob')
    && [...base].every(([path, before]) => {
      const after = head.get(path);
      return after?.mode === before.mode && after.type === before.type
        && (modified.includes(path) || after.sha === before.sha);
    });
}

function registeredModuleBody(text, revision, predecessor, source, sql) {
  const list = tokens(text);
  const matches = list.flatMap((token, i) => token.value === 'MIGRATION'
    && (token.start === 0 || text[token.start - 1] === '\n') ? [i] : []);
  if (matches.length !== 1) return null;
  let i = matches[0] + 1;
  if (list[i++]?.value !== '=' || list[i++]?.value !== 'PostgresMigration' || list[i++]?.value !== '(') return null;
  const edits = [];
  for (const [key, expected] of [['revision', revision], ['down_revision', predecessor], ['source_name', source]]) {
    if (list[i++]?.value !== key || list[i++]?.value !== '=') return null;
    const token = list[i++], value = literal(token);
    if (!value?.quote || value.value !== expected || list[i++]?.value !== ',') return null;
    edits.push({ ...token, value: `${value.quote}<${key}>${value.quote}` });
  }
  if (list[i++]?.value !== 'raw_sql' || list[i++]?.value !== '=') return null;
  const raw = list[i++]?.value;
  if (!raw || list[i]?.value !== ',') return null;
  let decoded;
  if (raw.startsWith('"""') && !raw.includes('\\')) decoded = raw.slice(3, -3);
  else {
    if (/\\(?:\/|u[dD][89a-fA-F])/.test(raw)) return null;
    try { decoded = JSON.parse(raw); } catch { return null; }
  }
  return decoded === sql ? replace(text, edits) : null;
}

const ledgerDirectories = [LEDGER_VERSIONS.slice(0, -1), LEDGER_MODULES, LEDGER_SQL];
const ledgerRegistry = `${LEDGER_MODULES}/__init__.py`;
async function scopedLedger(args, head) {
  const files = new Map();
  for (const directory of ledgerDirectories) {
    let sha = head;
    for (const part of directory.split('/')) {
      const entry = (await ledgerTree(args, sha)).get(part);
      if (entry?.type !== 'tree') throw new Error('missing migration directory');
      sha = entry.sha;
    }
    for (const [name, entry] of await ledgerTree(args, sha)) files.set(`${directory}/${name}`, entry);
  }
  return files;
}

function boundIntegrationFiles(evidence, proof) {
  const has = (files, path, sha, status) => files.filter(file => file.filename === path).length === 1
    && files.some(file => file.filename === path && file.sha === sha && file.status === status);
  return evidence.completeFileLists === true
    && evidence.headSha === proof.headSha && evidence.primaryHead === proof.primaryHead && evidence.mergeBase === proof.mergeBase
    && (evidence.repository === undefined || evidence.repository === proof.repo)
    && evidence.baseRef === 'main' && evidence.baseSha === proof.mainIntegration.observedBase
    && evidence.comparisonMergeBase === proof.mainIntegration.comparisonMergeBase
    && evidence.diagnosticCommitRange?.length === proof.mainIntegration.snapshots.length
    && proof.mainIntegration.snapshots.every((commit, index) => commit.sha === evidence.diagnosticCommitRange[index]?.sha)
    && [[proof.path, proof.primaryBlob], [proof.modulePath, proof.primaryModuleBlob], [proof.sqlPath, proof.primarySqlBlob]]
      .every(([path, sha]) => has(evidence.primaryFiles, path, sha, 'added'))
    && [[proof.destination, proof.blob], [proof.moduleDestination, proof.moduleBlob], [proof.sqlDestination, proof.sqlBlob]]
      .every(([path, sha]) => has(evidence.finalFiles, path, sha, 'added'))
    && has(evidence.primaryFiles, proof.registryPath, proof.primaryRegistryBlob, 'modified')
    && has(evidence.finalFiles, proof.registryPath, proof.registryBlob, 'modified')
    && !evidence.finalFiles.some(file => [proof.path, proof.sqlPath].includes(file.filename) && file.status !== 'removed')
    && evidence.finalFiles.filter(file => file.filename === proof.modulePath)
      .every(file => file.sha === proof.mainIntegration.parent.moduleBlob && file.status === 'added');
}

async function proveMainIntegration(args, evidence, range) {
  if (args.repo !== LEDGER_REPO || args.headSha !== evidence.headSha || evidence.hasHammerCommits !== true
    || evidence.historyReadFailed || evidence.readFailed || evidence.headMismatch
    || evidence.completeFileLists !== true || evidence.baseRef !== 'main'
    || !SHA.test(evidence.baseSha || '') || !SHA.test(evidence.comparisonMergeBase || '')
    || !SHA.test(evidence.primaryHead || '') || !SHA.test(evidence.mergeBase || '') || !evidence.diagnosticCommitRange) return null;
  const pairs = candidates(evidence).filter(({ before, after }) => before.directory === LEDGER_VERSIONS
    && before.number === migration(RSS_PARENT).number && after.number === before.number + 1);
  if (pairs.length !== 1) return null;
  const { source, destination, before, after } = pairs[0];
  const blob = verifiedBlobReader(args);
  if (scalarRevision(await blob(destination.sha), 'down_revision') !== RSS_REVISION) return null;
  const readCommit = async sha => {
    const commit = await args.get(`repos/${args.repo}/git/commits/${sha}`);
    if (commit.sha !== sha || !SHA.test(commit.tree?.sha || '') || !Array.isArray(commit.parents)
      || commit.parents.some(parent => !SHA.test(parent.sha || ''))) throw new Error('invalid migration ancestry');
    return { sha, tree: commit.tree.sha, parents: commit.parents.map(parent => parent.sha) };
  };
  const snapshots = [];
  const additionalMainParents = [];
  let mainParent, previous = evidence.primaryHead;
  for (let offset = 0; offset < range.length; offset += 4) {
    const commits = await Promise.all(range.slice(offset, offset + 4).map(({ sha }) => readCommit(sha)));
    for (const commit of commits) {
      if (commit.parents[0] !== previous || commit.parents.length < 1 || commit.parents.length > 2) return [];
      if (commit.parents.length === 2) {
        const second = commit.parents[1];
        if (!mainParent) {
          if (second !== RSS_MAIN) return [];
        } else {
          // Check both edges by immutable SHA. A matching tree alone does not
          // establish that this was a forward integration of trusted main.
          if (second === mainParent) return [];
          const advance = await args.metadata(`repos/${args.repo}/compare/${mainParent}...${second}`);
          if (advance.status !== 'ahead' || advance.merge_base_commit?.sha !== mainParent) return [];
          const trusted = await args.metadata(`repos/${args.repo}/compare/${second}...${evidence.baseSha}`);
          if (trusted.status !== (second === evidence.baseSha ? 'identical' : 'ahead')
            || trusted.merge_base_commit?.sha !== second) return [];
          additionalMainParents.push(await readCommit(second));
        }
        mainParent = second;
      }
      snapshots.push({ ...commit, integrated: mainParent !== undefined });
      previous = commit.sha;
    }
  }
  if (mainParent !== evidence.comparisonMergeBase) return [];
  const comparison = await args.metadata(`repos/${args.repo}/compare/${RSS_MAIN}...${evidence.primaryHead}`);
  if (comparison.status !== 'diverged' || comparison.merge_base_commit?.sha !== evidence.mergeBase) return [];
  if (evidence.baseSha !== RSS_MAIN) {
    const base = await args.metadata(`repos/${args.repo}/compare/${RSS_MAIN}...${evidence.baseSha}`);
    if (base.status !== 'ahead' || base.merge_base_commit?.sha !== RSS_MAIN) return [];
  }
  const [author, oldBase, main] = await Promise.all([evidence.primaryHead, evidence.mergeBase, RSS_MAIN].map(readCommit));
  const final = snapshots.at(-1);
  const [oldFiles, mainFiles, authorFiles, finalFiles] = await Promise.all(
    [oldBase, main, author, final].map(commit => scopedLedger(args, commit.tree)));
  for (const parent of additionalMainParents) {
    if (!exactLedgerDelta(mainFiles, await scopedLedger(args, parent.tree), [])) return [];
  }
  const shaAt = (files, path) => files.get(path)?.mode === '100644' && files.get(path).type === 'blob' ? files.get(path).sha : null;
  const textAt = (files, path) => {
    const sha = shaAt(files, path);
    if (!sha) throw new Error('missing migration blob');
    return blob(sha);
  };
  const wrapperAndSql = async (files, path, info) => {
    const wrapper = await textAt(files, path);
    const name = `${info.name}.sql`;
    if (scalarRevision(wrapper, 'SOURCE_NAME') !== name) throw new Error('migration source name mismatch');
    const sqlPath = `${LEDGER_SQL}/${name}`;
    return { wrapper, name, sqlPath, sql: await textAt(files, sqlPath), revision: scalarRevision(wrapper, 'revision'),
      predecessor: scalarRevision(wrapper, 'down_revision') };
  };
  const [original, active, parent] = await Promise.all([
    wrapperAndSql(authorFiles, source.filename, before),
    wrapperAndSql(finalFiles, destination.filename, after),
    wrapperAndSql(mainFiles, RSS_PARENT, migration(RSS_PARENT)),
  ]);
  const modulePath = `${LEDGER_MODULES}/r${before.number}.py`, moduleDestination = `${LEDGER_MODULES}/r${after.number}.py`;
  const oldParentSlot = `r${before.number - 1}`, oldParentModulePath = `${LEDGER_MODULES}/${oldParentSlot}.py`;
  const oldParents = [...oldFiles.keys()].filter(path => migration(path)?.directory === LEDGER_VERSIONS
    && migration(path).number === before.number - 1);
  if (oldParents.length !== 1) return [];
  const oldParentPath = oldParents[0], oldInfo = migration(oldParentPath);
  const oldParent = await wrapperAndSql(oldFiles, oldParentPath, oldInfo);
  const originalPaths = [source.filename, modulePath, original.sqlPath];
  const finalPaths = [destination.filename, moduleDestination, active.sqlPath];
  const originalSuffix = `_${before.number}`;
  if (parent.revision !== RSS_REVISION || active.predecessor !== parent.revision || original.predecessor !== parent.predecessor
    || original.predecessor !== oldParent.revision || !revisionLiteral({ value: `"${oldParent.revision}"` }, oldInfo)
    || !original.revision?.endsWith(originalSuffix)
    || active.revision !== `${original.revision.slice(0, -originalSuffix.length)}_${after.number}` || active.sql !== original.sql
    || shaAt(authorFiles, source.filename) !== source.sha || shaAt(finalFiles, destination.filename) !== destination.sha
    || !exactLedgerDelta(oldFiles, authorFiles, originalPaths, [ledgerRegistry])
    || !exactLedgerDelta(oldFiles, mainFiles, [RSS_PARENT, modulePath, parent.sqlPath], [ledgerRegistry, `${LEDGER_MODULES}/_types.py`])
    || !exactLedgerDelta(mainFiles, finalFiles, finalPaths, [ledgerRegistry])) return [];
  const parentSlot = `r${before.number}`, childSlot = `r${after.number}`;
  const [oldRegistry, mainRegistry, authorRegistry, finalRegistry, parentModule, originalModule, finalModule] = await Promise.all([
    ...[oldFiles, mainFiles, authorFiles, finalFiles].map(files => textAt(files, ledgerRegistry)),
    textAt(mainFiles, modulePath), textAt(authorFiles, modulePath), textAt(finalFiles, moduleDestination),
  ]);
  if (removeModule(mainRegistry, parentSlot) !== oldRegistry || removeModule(authorRegistry, parentSlot) !== oldRegistry
    || removeModule(finalRegistry, childSlot) !== mainRegistry
    || finalRegistry.indexOf(`"${childSlot}"`) <= finalRegistry.indexOf(`"${parentSlot}"`)
    || moduleRegistry(oldRegistry, oldParentSlot) === null
    || registeredModuleBody(await textAt(oldFiles, oldParentModulePath), oldParent.revision, oldParent.predecessor,
      oldParent.name, oldParent.sql) === null
    || registeredModuleBody(parentModule, parent.revision, parent.predecessor, parent.name, parent.sql) === null) return [];
  before.predecessors = new Set([original.predecessor]);
  after.predecessors = new Set([active.predecessor]);
  const body = migrationBody(original.wrapper, before);
  const module = registeredModuleBody(originalModule, original.revision, original.predecessor, original.name, original.sql);
  if (body === null || body !== migrationBody(active.wrapper, after) || module === null
    || module !== registeredModuleBody(finalModule, active.revision, active.predecessor, active.name, active.sql)) return [];
  for (let offset = 0; offset < snapshots.length; offset += 4) {
    const matches = await Promise.all(snapshots.slice(offset, offset + 4).map(async snapshot => {
      const expected = snapshot.integrated ? finalFiles : authorFiles;
      return exactLedgerDelta(expected, await scopedLedger(args, snapshot.tree), []);
    }));
    if (matches.includes(false)) return [];
  }
  const proof = { classification: CLASS, repo: args.repo, headSha: evidence.headSha, primaryHead: evidence.primaryHead,
    mergeBase: evidence.mergeBase, path: source.filename, destination: destination.filename, primaryBlob: source.sha, blob: destination.sha,
    registryPath: ledgerRegistry, primaryRegistryBlob: shaAt(authorFiles, ledgerRegistry), registryBlob: shaAt(finalFiles, ledgerRegistry),
    modulePath, moduleDestination, primaryModuleBlob: shaAt(authorFiles, modulePath), moduleBlob: shaAt(finalFiles, moduleDestination),
    sqlPath: original.sqlPath, sqlDestination: active.sqlPath, primarySqlBlob: shaAt(authorFiles, original.sqlPath),
    sqlBlob: shaAt(finalFiles, active.sqlPath),
    chain: [{ headSha: evidence.primaryHead, path: source.filename, blob: source.sha, revisionNumber: before.number },
      { headSha: evidence.headSha, path: destination.filename, blob: destination.sha, revisionNumber: after.number }],
    mainIntegration: { baseSha: RSS_MAIN, observedBase: evidence.baseSha, comparisonMergeBase: evidence.comparisonMergeBase,
      additionalMainParents, snapshots, parent: { path: RSS_PARENT, revision: parent.revision,
      blob: shaAt(mainFiles, RSS_PARENT), modulePath, moduleBlob: shaAt(mainFiles, modulePath), sqlPath: parent.sqlPath,
      sqlBlob: shaAt(mainFiles, parent.sqlPath), registryBlob: shaAt(mainFiles, ledgerRegistry) } } };
  if (!boundIntegrationFiles(evidence, proof)) return [];
  // Only the native collector can issue this certificate. Keep the binding
  // outside of cached history, and reject copied or edited proof records.
  integrationProofs.set(proof, { evidence, serialized: JSON.stringify(proof) });
  return [proof];
}

// A descendant can repair a stale filename while advancing its declared
// revision. This extra authority is limited to SQL-origin wrappers: every
// selected predecessor wrapper, SQL source and operation module must be
// byte-identical to the snapshot's independently selected base.
async function certifyParentOperations(args, evidence, proof, snapshots) {
  if (proof.moduleOrigin !== 'author-sql') return null;
  const observations = [{ headSha: evidence.primaryHead, baseSha: evidence.mergeBase, parent: proof.authorParent },
    ...snapshots.map(batch => batch.find(item => item.path === proof.path))];
  const certified = [];
  for (const observation of observations) {
    const { headSha, parent } = observation;
    if (certified.length) {
      const previous = observations[certified.length - 1].headSha;
      const ancestry = await args.metadata(`repos/${args.repo}/compare/${previous}...${headSha}`);
      if (ancestry.status !== 'ahead' || ancestry.merge_base_commit?.sha !== previous || ancestry.total_commits !== 1) return null;
    }
    if (!parent || !parent.sourceName || parent.sourceName.includes('/')) return null;
    // Reuse the base already selected while proving this snapshot, including
    // SQL-only and unchanged-author observations before module introduction.
    const baseSha = observation.baseSha || observation.snapshotMergeBase;
    if (!SHA.test(baseSha || '') || await fileAt(args, baseSha, parent.path) !== parent.blob) return null;
    // Before module introduction, no registry edit has derived authority.
    const registry = await fileAt(args, headSha, proof.registryPath);
    if (observation.moduleOrigin !== 'author-sql'
      && (!registry || registry !== await fileAt(args, baseSha, proof.registryPath))) return null;
    if (observation.moduleOrigin === 'author-sql' && registry !== observation.registryBlob) return null;
    const paths = [posix.join(posix.dirname(proof.sqlPath), parent.sourceName),
      posix.join(posix.dirname(proof.moduleDestination), `r${parent.number}.py`)];
    const operations = [];
    for (const path of paths) {
      const sha = await fileAt(args, headSha, path);
      if (!sha || sha !== await fileAt(args, baseSha, path)) return null;
      operations.push({ path, blob: sha });
    }
    certified.push({ headSha, baseSha, path: parent.path, blob: parent.blob, registryBlob: registry, operations });
  }
  return certified;
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
async function migrationTree({ repo, get, treePolicy }, head, directory) {
  if (!treePolicy.walkOnly) {
    const whole = await get(`repos/${repo}/git/trees/${head}?recursive=1`);
    if (whole?.truncated === false && Array.isArray(whole.tree) && whole.tree.length <= 10000) return whole.tree;
    // This policy is shared across pairs and snapshots in this collection only.
    treePolicy.walkOnly = true;
  }
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
  const blob = verifiedBlobReader({ repo, get, signal: deadline });
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
        const parents = [];
        const wrapper = await blob(head === evidence.primaryHead ? pair.source.sha : pair.destination.sha);
        // Filename slots and declared revision numbers can temporarily differ
        // while a rebase repairs a collision. Only author-to-slot numbers are
        // mechanical, and the literal identity must still match the wrapper.
        // Author/final heads get no override: migrationBody checks their
        // declarations against the filename slot. An absent intermediate
        // override likewise leaves that body check strict, never unchecked.
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
          const parentBody = await blob(entry.sha), revision = scalarRevision(parentBody, 'revision');
          if (revision === target && revisionLiteral({ value: `"${revision}"` }, migration(entry.path))) {
            info.predecessors.add(revision);
            parents.push({ path: entry.path, blob: entry.sha, number,
              sourceName: scalarRevision(parentBody, 'SOURCE_NAME') });
          }
        }
        if (parents.length === 1) info.parent = parents[0];
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
      if (proof) proofs.push({ ...proof, revisionNumber: pair.after.revisionNumber ?? pair.after.number,
        parent: pair.after.parent, authorParent: pair.before.parent });
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

function recordDiagnostic(evidence, reason, headSha = evidence.headSha, path, detail) {
  const diagnostics = evidence.migrationRenumberDiagnostics ??= [];
  if (diagnostics.length === 128) diagnostics.shift();
  diagnostics.push({ proven: false, reason, headSha,
    ...(path ? { path } : {}), ...(detail ? { detail: String(detail).slice(0, 300) } : {}) });
}

// The array return remains compatible with callers. Every unsuccessful attempt
// records a structured refusal on the supplied transient evidence, outside the
// history cache, so a failed optional proof can explain the existing refusal.
export async function proveMigrationRenumbers(args, evidence) {
  evidence.migrationRenumberDiagnostics = [];
  delete evidence.migrationRenumberAncestry;
  if (Array.isArray(evidence.primaryFiles) && Array.isArray(evidence.finalFiles) && !candidates(evidence).length) return [];
  const record = (reason, headSha, path, detail) => recordDiagnostic(evidence, reason, headSha, path, detail);
  const refuse = reason => { record(reason); return []; };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('migration proof deadline exceeded', 'TimeoutError')),
    loadAwareTimeoutMs(90000));
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
    finalNumbers: new Map(), treePolicy: { walkOnly: false }, get: path => read(path, get),
    metadata: path => read(path, get.metadata || get, `metadata:${path}`) };
  try {
    const range = evidence.diagnosticCommitRange || [{ sha: evidence.headSha }];
    if (!Array.isArray(range) || !range.length || range.length > 64 || range.at(-1)?.sha !== evidence.headSha
      || range.some(entry => !SHA.test(entry?.sha || ''))
      || new Set(range.map(entry => entry.sha)).size !== range.length) return refuse('range-invalid');
    if (Array.isArray(evidence.primaryFiles) && Array.isArray(evidence.finalFiles)) {
      args.finalNumbers = new Map(candidates(evidence).map(pair => [pair.source.filename, pair.after.number]));
    }
    const integration = await proveMainIntegration(args, evidence, range);
    if (integration !== null) return integration.length ? integration : refuse('main-integration-unproven');
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
          batch.push({ path: proof.path, destination: proof.path, blob: proof.primaryBlob, headSha: entry.sha,
            revisionNumber: migration(proof.path).number, parent: proof.authorParent, unchangedAuthor: true });
        }
      }
      snapshots.push(batch.map(item => ({ ...item, baseSha: snapshot.merge_base_commit.sha })));
    }
    const complete = proofs.filter(proof => {
      let moduleSeen = false;
      if (snapshots.every(batch => batch.some(item => {
        if (item.path !== proof.path) return false;
        if (proof.moduleOrigin !== 'author-sql') return true;
        if (item.unchangedAuthor === true || item.sqlOnly === true) return !moduleSeen;
        if (item.moduleIdentity !== proof.moduleIdentity) return false;
        moduleSeen = true;
        return true;
      }))) return true;
      record('snapshot-proof-missing', evidence.headSha, proof.path);
      return false;
    });
    const result = [];
    for (const proof of complete) {
      let rebased = false, metadataRepair = false, parentOperations;
      const alembic = migration(proof.path).directory.endsWith('alembic/versions/');
      const chain = [{ headSha: evidence.primaryHead, path: proof.path, blob: proof.primaryBlob,
        ...(alembic ? { revisionNumber: migration(proof.path).number } : {}) }];
      for (const batch of snapshots) {
        const item = batch.find(item => item.path === proof.path);
        if (alembic && (!Number.isSafeInteger(item.revisionNumber)
          || item.revisionNumber < chain.at(-1).revisionNumber
          || item.revisionNumber > migration(proof.destination).number)) throw new Error('non-increasing renumber chain');
        if (chain.at(-1).path === item.destination && chain.at(-1).blob === item.blob) {
          if (chain.length > 1) chain.at(-1).headSha = item.headSha;
          continue;
        }
        const previous = migration(chain.at(-1).path), next = migration(item.destination);
        if (next.number <= previous.number && !rebased && !metadataRepair) {
          const ancestry = await args.metadata(`repos/${args.repo}/compare/${evidence.primaryHead}...${evidence.headSha}`);
          if (ancestry.status === 'diverged') rebased = true;
          else if (alembic && ancestry.status === 'ahead' && ancestry.merge_base_commit?.sha === evidence.primaryHead
            && ancestry.total_commits === range.length) {
            parentOperations = await certifyParentOperations(args, evidence, proof, snapshots);
            if (!parentOperations) throw new Error('uncertified repair predecessor');
            metadataRepair = true;
          } else throw new Error('non-increasing renumber chain');
          // Every proof uses this same immutable head-pair comparison. Its
          // status selects either divergence or ancestral repair for all
          // siblings; strictly increasing proofs need neither exception.
          evidence.migrationRenumberAncestry = { primaryHead: evidence.primaryHead, headSha: evidence.headSha, status: ancestry.status,
            ...(metadataRepair ? { mergeBase: ancestry.merge_base_commit.sha } : {}) };
        }
        if (metadataRepair && (next.number === previous.number && item.destination !== chain.at(-1).path
          || next.number < previous.number && item.revisionNumber <= chain.at(-1).revisionNumber)) throw new Error('non-increasing renumber chain');
        if (next.number < migration(proof.path).number) throw new Error('non-increasing renumber chain');
        chain.push({ headSha: item.headSha, path: item.destination, blob: item.blob,
          ...(alembic ? { revisionNumber: item.revisionNumber } : {}) });
      }
      result.push({ ...proof, chain, ...(rebased ? { rebased: true } : {}),
        ...(metadataRepair ? { metadataRepair: true, parentOperations } : {}) });
    }
    return result;
  } catch (error) {
    const reason = deadline.aborted ? (deadline.reason?.name === 'TimeoutError' ? 'deadline-exceeded' : 'aborted')
      : error?.message === 'migration read budget exhausted' ? 'read-budget-exhausted'
        : error?.message === 'non-increasing renumber chain' ? 'chain-non-increasing'
          : error?.message === 'uncertified repair predecessor' ? 'repair-predecessor-unproven'
          : error?.message === 'invalid migration ancestry' ? 'main-integration-ancestry-invalid'
          : error?.message === 'migration source name mismatch' ? 'main-integration-source-name-mismatch'
          : error?.message === 'missing migration blob' ? 'main-integration-blob-missing'
          : error?.message === 'missing migration directory' ? 'main-integration-directory-missing'
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

function verifiedMetadataRepair(evidence, proof, headSha) {
  const ancestry = evidence.migrationRenumberAncestry;
  const range = evidence.diagnosticCommitRange || [{ sha: headSha }];
  return proof.moduleOrigin === 'author-sql' && proof.rebased !== true
    && ancestry?.status === 'ahead' && ancestry.primaryHead === proof.primaryHead && ancestry.headSha === headSha
    && ancestry.mergeBase === proof.primaryHead
    && Array.isArray(range) && range.length > 0 && range.every(entry => SHA.test(entry?.sha || ''))
    && Array.isArray(proof.parentOperations) && proof.parentOperations.length === range.length + 1
    && proof.parentOperations.at(-1)?.baseSha === proof.snapshotMergeBase
    && proof.parentOperations.at(-1)?.registryBlob === proof.registryBlob
    && proof.parentOperations.every((entry, index) => entry && entry.headSha === (index ? range[index - 1].sha : evidence.primaryHead)
      && SHA.test(entry.baseSha || '') && SHA.test(entry.blob || '') && SHA.test(entry.registryBlob || '')
      && migration(entry.path)?.directory === migration(proof.path)?.directory
      && (!index ? entry.baseSha === evidence.mergeBase : true)
      && Array.isArray(entry.operations) && entry.operations.length === 2
      && entry.operations.every(operation => operation && typeof operation.path === 'string' && SHA.test(operation.blob || ''))
      && posix.dirname(entry.operations[0].path) === posix.dirname(proof.sqlPath)
      && entry.operations[1].path === posix.join(posix.dirname(proof.moduleDestination), `r${migration(entry.path).number}.py`));
}

export function verifiedMigrationRenumbers(evidence, headSha) {
  return (evidence.migrationRenumberProofs || []).filter(proof => {
    if (proof.mainIntegration) {
      const issuance = integrationProofs.get(proof);
      if (issuance?.evidence !== evidence || issuance.serialized !== JSON.stringify(proof)) {
        recordDiagnostic(evidence, 'main-integration-certificate-unbound', headSha, proof.path);
        return false;
      }
      return headSha === proof.headSha && boundIntegrationFiles(evidence, proof);
    }
    // Legacy paired-module proofs never claim a SQL source.
    return !(proof.modulePath && proof.sqlPath) && proof.classification === CLASS
    && migration(proof.path) && migration(proof.destination)
    && proof.headSha === headSha && proof.primaryHead === evidence.primaryHead && proof.mergeBase === evidence.mergeBase
    && (!migration(proof.path)?.directory.endsWith('alembic/versions/') || typeof proof.modulePath === 'string' || verifiedSqlBinding(evidence, proof))
    && Array.isArray(proof.chain) && proof.chain.length >= 2 && proof.chain.length <= 65
    && proof.chain[0].headSha === evidence.primaryHead && proof.chain[0].path === proof.path
    && proof.chain[0].blob === proof.primaryBlob && proof.chain.at(-1).path === proof.destination
    && proof.chain.at(-1).blob === proof.blob && proof.chain.at(-1).headSha === headSha
    && (!migration(proof.path).directory.endsWith('alembic/versions/')
      || proof.chain[0].revisionNumber === migration(proof.path).number
        && proof.chain.at(-1).revisionNumber === migration(proof.destination).number)
    && (proof.metadataRepair !== true || verifiedMetadataRepair(evidence, proof, headSha))
    && proof.chain.every((entry, index) => SHA.test(entry.headSha || '') && SHA.test(entry.blob || '')
      && migration(entry.path) && (!index || migration(entry.path).directory === migration(proof.path).directory
        && migration(entry.path).identity === migration(proof.path).identity
        && (!migration(proof.path).directory.endsWith('alembic/versions/')
          || Number.isSafeInteger(entry.revisionNumber) && entry.revisionNumber >= proof.chain[index - 1].revisionNumber
            && entry.revisionNumber <= migration(proof.destination).number)
        && (proof.metadataRepair === true ? migration(entry.path).number >= migration(proof.path).number
          && (migration(entry.path).number > migration(proof.chain[index - 1].path).number
            || entry.path === proof.chain[index - 1].path
            || migration(entry.path).number < migration(proof.chain[index - 1].path).number
              && entry.revisionNumber > proof.chain[index - 1].revisionNumber)
          : proof.rebased === true ? evidence.migrationRenumberAncestry?.status === 'diverged'
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
        final.filename === file.filename && final.status === file.status && final.sha === proof.registryBlob)));
  });
}

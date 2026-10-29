import { createHash } from 'node:crypto';
import { posix } from 'node:path';

const SHA = /^[0-9a-f]{40}$/i;
const LIMIT = 1024 * 1024;
const CLASS = 'mechanical-migration-renumber';
const blobSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

function migration(path) {
  if (typeof path !== 'string' || path.split('/').some(part => !part || part === '..' || part === '.')
    || /[\\\x00-\x1f]/.test(path)) return null;
  const match = /^(.*(?:^|\/)(?:migrations\/(?:versions\/)?|alembic\/versions\/))(\d+)_([a-zA-Z0-9_]+)\.py$/.exec(path);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return null;
  return { directory: match[1], number: Number(match[2]), name: match[3],
    identity: match[3].replace(/^\d{8}(?:_?\d{6})?_/, ''),
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
  const number = predecessor ? info.number - 1 : info.number;
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
      const normalized = parsed.value.replace(/^\d{8}(?:_?\d{6})?_/, '<timestamp>_');
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

function candidates(evidence) {
  const pairs = [];
  for (const source of evidence.primaryFiles || []) {
    const before = migration(source.filename);
    // Author-added files only. Restoring a pre-existing migration is never
    // disguised as a renumber, nor is renaming across migration directories.
    if (!before || source.status !== 'added' || !SHA.test(source.sha || '')
      || evidence.finalFiles?.some(file => file.filename === source.filename && file.status !== 'removed')) continue;
    const destinations = (evidence.finalFiles || []).filter(file => {
      const after = migration(file.filename);
      return after && after.directory === before.directory && after.identity === before.identity
        && after.number > before.number && SHA.test(file.sha || '')
        && (file.status === 'added' || file.status === 'renamed' && file.previous_filename === source.filename);
    });
    if (destinations.length === 1) pairs.push({ source, destination: destinations[0], before,
      after: migration(destinations[0].filename) });
  }
  return pairs;
}

async function proveSnapshot({ repo, get, signal }, evidence) {
  if (evidence.hasHammerCommits !== true || !SHA.test(evidence.headSha || '')
    || !SHA.test(evidence.primaryHead || '') || !SHA.test(evidence.mergeBase || '')
    || evidence.completeFileLists !== true && [evidence.primaryFiles, evidence.finalFiles].some(files => files?.length >= 300)) return [];
  const pairs = candidates(evidence);
  if (!pairs.length || pairs.length > 8) return [];
  const cache = new Map();
  const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]);
  const blob = async sha => {
    if (!cache.has(sha)) cache.set(sha, (async () => {
      deadline.throwIfAborted();
      const data = await new Promise((accept, reject) => {
        const abort = () => reject(deadline.reason);
        deadline.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => get(`repos/${repo}/git/blobs/${sha}`)).then(accept, reject)
          .finally(() => deadline.removeEventListener('abort', abort));
      });
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
  try {
    // Only body-verified pairs may share registry normalization. A changed
    // operation in a sibling migration must never gain registry authority.
    const verified = [];
    for (const pair of pairs) {
      if (pair.before.directory.endsWith('alembic/versions/')) {
        // A changed predecessor is authority only if its exact revision exists
        // in the immutable snapshot, outside the candidate wrapper itself.
        for (const [info, head, path] of [[pair.before, evidence.primaryHead, pair.source.filename],
          [pair.after, evidence.headSha, pair.destination.filename]]) {
          const tree = await get(`repos/${repo}/git/trees/${head}?recursive=1`);
          if (tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > 10000) throw new Error('incomplete migration tree');
          info.predecessors = new Set();
          const wrapper = await blob(head === evidence.primaryHead ? pair.source.sha : pair.destination.sha);
          const target = scalarRevision(wrapper, 'down_revision');
          const prefix = /^(\d+)(?:_|$)/.exec(target || ''), suffix = /_(\d+)$/.exec(target || '');
          const number = Number(prefix?.[1] ?? suffix?.[1]);
          if (!Number.isSafeInteger(number) || number >= info.number) continue;
          const entries = tree.tree.filter(entry => {
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
    }
    for (const pair of verified) {
      const { source, destination, before } = pair;
      if (before.directory.endsWith('alembic/versions/')) {
        const proof = await moduleProof(evidence, pair, blob);
        if (proof) proofs.push(proof);
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
  } catch { /* Optional proof failure retains the existing reversal refusal. */ }
  return proofs;
}

// Compare every observed hammer snapshot with the protected author head.
// This prevents a later renumber from replacing the author's original baseline.
export async function proveMigrationRenumbers(args, evidence) {
  const deadline = AbortSignal.any([...(args.signal ? [args.signal] : []), AbortSignal.timeout(15000)]);
  const cache = new Map(), get = args.get;
  args = { ...args, signal: deadline, get: path => {
    if (!cache.has(path)) cache.set(path, (async () => {
      deadline.throwIfAborted();
      if (cache.size >= 512) throw new Error('migration read budget exhausted');
      return new Promise((accept, reject) => {
        const abort = () => reject(deadline.reason);
        deadline.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => get(path)).then(accept, reject)
          .finally(() => deadline.removeEventListener('abort', abort));
      });
    })());
    return cache.get(path);
  } };
  const proofs = await proveSnapshot(args, evidence);
  if (!proofs.length) return [];
  const range = evidence.diagnosticCommitRange || [{ sha: evidence.headSha }];
  if (!range.length || range.length > 64 || range.at(-1).sha !== evidence.headSha
    || range.some(entry => !SHA.test(entry.sha || ''))) return [];
  try {
    const snapshots = [];
    for (const entry of range) {
      if (entry.sha === evidence.headSha) { snapshots.push(proofs); continue; }
      const snapshot = await args.get(`repos/${args.repo}/compare/${evidence.mergeBase}...${entry.sha}`);
      if (snapshot.merge_base_commit?.sha !== evidence.mergeBase || !Array.isArray(snapshot.files)
        || snapshot.filesComplete !== true && snapshot.files.length >= 300) return [];
      const batch = await proveSnapshot(args, { ...evidence, headSha: entry.sha,
        finalFiles: snapshot.files, completeFileLists: snapshot.filesComplete === true });
      // Remediation may precede the first renumber. Only the files participating
      // in this proof need remain at the author version in that snapshot.
      for (const proof of proofs) {
        const originals = [[proof.path, proof.primaryBlob], [proof.registryPath, proof.primaryRegistryBlob],
          ...(proof.modulePath ? [[proof.modulePath, proof.primaryModuleBlob]] : [])];
        if (originals.every(([path, sha]) => snapshot.files.some(file => file.filename === path
          && file.sha === sha && file.status === evidence.primaryFiles.find(source => source.filename === path)?.status))) {
          batch.push({ path: proof.path, destination: proof.path, blob: proof.primaryBlob, headSha: entry.sha });
        }
      }
      snapshots.push(batch);
    }
    return proofs.filter(proof => snapshots.every(batch => batch.some(item => item.path === proof.path)))
      .map(proof => {
        const chain = [{ headSha: evidence.primaryHead, path: proof.path, blob: proof.primaryBlob }];
        for (const batch of snapshots) {
          const item = batch.find(item => item.path === proof.path);
          if (chain.at(-1).path === item.destination && chain.at(-1).blob === item.blob) {
            if (chain.length > 1) chain.at(-1).headSha = item.headSha;
            continue;
          }
          const previous = migration(chain.at(-1).path), next = migration(item.destination);
          if (next.number <= previous.number) throw new Error('non-increasing renumber chain');
          chain.push({ headSha: item.headSha, path: item.destination, blob: item.blob });
        }
        return { ...proof, chain };
      });
  } catch { return []; }
}

export function verifiedMigrationRenumbers(evidence, headSha) {
  return (evidence.migrationRenumberProofs || []).filter(proof => proof.classification === CLASS
    && proof.headSha === headSha && proof.primaryHead === evidence.primaryHead && proof.mergeBase === evidence.mergeBase
    && (!migration(proof.path)?.directory.endsWith('alembic/versions/') || typeof proof.modulePath === 'string')
    && Array.isArray(proof.chain) && proof.chain.length >= 2 && proof.chain.length <= 65
    && proof.chain[0].headSha === evidence.primaryHead && proof.chain[0].path === proof.path
    && proof.chain[0].blob === proof.primaryBlob && proof.chain.at(-1).path === proof.destination
    && proof.chain.at(-1).blob === proof.blob && proof.chain.at(-1).headSha === headSha
    && proof.chain.every((entry, index) => SHA.test(entry.headSha || '') && SHA.test(entry.blob || '')
      && migration(entry.path) && (!index || migration(entry.path).directory === migration(proof.path).directory
        && migration(entry.path).identity === migration(proof.path).identity
        && migration(entry.path).number > migration(proof.chain[index - 1].path).number))
    && candidates(evidence).some(({ source, destination }) => source.filename === proof.path
      && source.sha === proof.primaryBlob && destination.filename === proof.destination && destination.sha === proof.blob)
    && (!proof.modulePath || evidence.primaryFiles.some(file => file.filename === proof.modulePath
      && file.status === 'added' && file.sha === proof.primaryModuleBlob
      && !evidence.finalFiles.some(final => final.filename === file.filename && final.status !== 'removed')
      && evidence.finalFiles.some(final => final.filename === proof.moduleDestination && final.sha === proof.moduleBlob
        && (final.status === 'added' || final.status === 'renamed' && final.previous_filename === file.filename))))
    && evidence.primaryFiles.some(file => file.filename === proof.registryPath && file.sha === proof.primaryRegistryBlob
      && ['added', 'modified'].includes(file.status) && evidence.finalFiles.some(final =>
        final.filename === file.filename && final.status === file.status && final.sha === proof.registryBlob)));
}

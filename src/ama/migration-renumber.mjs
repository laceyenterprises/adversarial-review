import { createHash } from 'node:crypto';
import { posix } from 'node:path';

const SHA = /^[0-9a-f]{40}$/i;
const LIMIT = 1024 * 1024;
const CLASS = 'mechanical-migration-renumber';
const blobSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

function migration(path) {
  if (typeof path !== 'string' || path.split('/').some(part => !part || part === '..' || part === '.')
    || /[\\\x00-\x1f]/.test(path)) return null;
  const match = /^(.*(?:^|\/)migrations\/(?:versions\/)?)(\d+)_([a-zA-Z0-9_]+)\.py$/.exec(path);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return null;
  return { directory: match[1], number: Number(match[2]), name: match[3],
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
  const number = predecessor ? info.number - 1 : info.number;
  if (parsed.quote) {
    const match = /^(\d+)(?:_([A-Za-z0-9_]+))?$/.exec(parsed.value);
    return !!match && Number(match[1]) === number && (predecessor || !match[2] || match[2] === info.name);
  }
  return Number(parsed.value) === number;
}

function replace(text, edits) {
  for (const { start, end, value } of edits.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, start) + value + text.slice(end);
  }
  return text;
}

function migrationBody(text, info) {
  const list = tokens(text), edits = [];
  let revision = 0, predecessor = 0;
  for (let index = 0; index < list.length; index++) {
    const token = list[index];
    if (['def', 'class', 'async'].includes(token.value)
      && (token.start === 0 || text[token.start - 1] === '\n')) break;
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
    edits.push({ ...value, value: '<revision>' });
    if (down) predecessor++; else revision++;
  }
  if (!revision || revision > 2 || predecessor !== 1) return null;
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

function registryBody(text, info) {
  const list = tokens(text), edits = [];
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
      || !/^\d+$/.test(number.value) || Number(number.value) !== info.number || !parsed?.quote
      || ![info.name, info.stem, `${info.stem}.py`].includes(parsed.value)) continue;
    edits.push({ ...number, value: '<revision>' }, { ...name, value: `${parsed.quote}<migration>${parsed.quote}` });
  }
  return edits.length === 2 ? replace(text, edits) : null;
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
      return after && after.directory === before.directory && after.name === before.name
        && after.number > before.number && SHA.test(file.sha || '')
        && (file.status === 'added' || file.status === 'renamed' && file.previous_filename === source.filename);
    });
    if (destinations.length === 1) pairs.push({ source, destination: destinations[0], before,
      after: migration(destinations[0].filename) });
  }
  return pairs;
}

export async function proveMigrationRenumbers({ repo, get, signal }, evidence) {
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
    for (const { source, destination, before, after } of pairs) {
      const original = migrationBody(await blob(source.sha), before);
      if (original === null || original !== migrationBody(await blob(destination.sha), after)) continue;
      const directory = before.directory.replace(/versions\/$/, '');
      const registries = (evidence.primaryFiles || []).filter(file =>
        posix.dirname(file.filename) + '/' === directory
        && ['__init__.py', 'registry.py', 'revisions.py'].includes(posix.basename(file.filename))
        && ['added', 'modified'].includes(file.status) && SHA.test(file.sha || ''));
      for (const registry of registries) {
        const final = evidence.finalFiles.find(file => file.filename === registry.filename && file.status === registry.status && SHA.test(file.sha || ''));
        if (!final || final.sha === registry.sha) continue;
        const initial = registryBody(await blob(registry.sha), before);
        if (initial === null || initial !== registryBody(await blob(final.sha), after)) continue;
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

export function verifiedMigrationRenumbers(evidence, headSha) {
  return (evidence.migrationRenumberProofs || []).filter(proof => proof.classification === CLASS
    && proof.headSha === headSha && proof.primaryHead === evidence.primaryHead && proof.mergeBase === evidence.mergeBase
    && candidates(evidence).some(({ source, destination }) => source.filename === proof.path
      && source.sha === proof.primaryBlob && destination.filename === proof.destination && destination.sha === proof.blob)
    && evidence.primaryFiles.some(file => file.filename === proof.registryPath && file.sha === proof.primaryRegistryBlob
      && ['added', 'modified'].includes(file.status) && evidence.finalFiles.some(final =>
        final.filename === file.filename && final.status === file.status && final.sha === proof.registryBlob)));
}

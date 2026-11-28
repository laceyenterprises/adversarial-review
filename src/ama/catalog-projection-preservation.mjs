import { createHash } from 'node:crypto';
import { CATALOG_PATH, CATALOG_REPO, readFailure } from './catalog-field-move.mjs';

const RECIPE_PATH = 'scripts/generate-data-model-catalog.mjs';
const ORDER_PATH = 'docs/data-model/catalog.d/legacy-order.json';
// Reviewed Agent OS assembler. A new revision requires reviewing its domain
// transformation and wire format before updating this pin.
const RECIPE = 'cb1847a96f043e91400fed5db9ba45e7656f02a5d9cf77214a64b199743c7bc1';
const SHA = /^[0-9a-f]{40}$/;
const DOMAIN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_BYTES = 4 * 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const gitBlob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const render = value => `${JSON.stringify(value, null, 2)
  .replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;
const fragmentPath = slug => `docs/data-model/catalog.d/domains/${slug}.json`;

function modifiedBlob(files, path) {
  const matches = files.filter(file => file.filename === path || file.previous_filename === path);
  const [file] = matches;
  return matches.length === 1 && file.status === 'modified' && !file.previous_filename
    && typeof file.patch === 'string' && file.patch.startsWith('@@ ') && SHA.test(file.sha || '') ? file.sha : null;
}

function binding(evidence, slug) {
  if (evidence.completeFileLists !== true || !Array.isArray(evidence.primaryFiles)
    || !Array.isArray(evidence.finalFiles) || typeof slug !== 'string' || !DOMAIN.test(slug)) return null;
  const { headSha, mergeBase, primaryHead, primaryFiles, finalFiles } = evidence;
  const refs = [headSha, mergeBase, primaryHead];
  if (!refs.every(ref => SHA.test(ref || '')) || new Set(refs).size !== refs.length
    || finalFiles.some(file => file.filename === CATALOG_PATH || file.previous_filename === CATALOG_PATH)) return null;
  const fragment = fragmentPath(slug);
  const primaryBlob = modifiedBlob(primaryFiles, CATALOG_PATH);
  const primaryFragment = modifiedBlob(primaryFiles, fragment);
  const headFragment = modifiedBlob(finalFiles, fragment);
  if (!primaryBlob || !primaryFragment || !headFragment) return null;
  return { headSha, mergeBase, primaryHead, primaryBlob, fragment, primaryFragment, headFragment };
}

export function verifiedCatalogProjection(evidence, path) {
  const proof = evidence.catalogProjectionProof;
  if (path !== CATALOG_PATH || evidence.repository !== CATALOG_REPO || !proof
    || proof.version !== 1 || proof.repository !== CATALOG_REPO || proof.path !== path
    || evidence.baseRef !== 'main' || evidence.baseSha !== proof.baseSha
    || proof.recipe !== RECIPE || ![proof.baseSha, proof.baseBlob, proof.orderBlob, proof.baseFragment]
      .every(sha => SHA.test(sha || '')) || proof.baseBlob !== proof.headBlob
    || proof.baseBlob === proof.primaryBlob || proof.baseFragment === proof.primaryFragment
    || proof.baseFragment === proof.headFragment) return null;
  const expected = binding(evidence, proof.slug);
  return expected && Object.entries(expected).every(([key, value]) => proof[key] === value) ? proof : null;
}

function parse(bytes, { fragment = false } = {}) {
  const text = bytes.toString('utf8');
  if (!bytes.equals(Buffer.from(text))) throw new Error('invalid UTF-8 in catalog input');
  const value = JSON.parse(text);
  if (fragment) {
    // Ignore layout and string escape spellings, but refuse lossy parses
    // (including duplicate keys anywhere in the fragment or order file).
    // This conservative round trip also refuses valid noncanonical numbers
    // (1.0, 1e3) and integer-like keys reordered by JavaScript. The assembler
    // accepts those inputs; this proof deliberately falls back to the gate.
    const compact = text.replace(/"(?:[^"\\]|\\.)*"|\s+/g,
      token => token[0] === '"' ? JSON.stringify(JSON.parse(token)) : '');
    if (compact !== JSON.stringify(value)) throw new Error('ambiguous catalog input');
  }
  return value;
}

// The reviewed assembler derives tableCount and orders the domain's immediate
// keys. Nested keys keep their input order. This proof only needs that slice of
// the recipe. It never loads executable code from either branch.
function projectDomain(domain, slug, order) {
  if (!object(domain) || domain.slug !== slug || !Array.isArray(domain.tables)
    || Object.hasOwn(domain, 'tableCount')) throw new Error('invalid catalog domain');
  const row = { ...domain, tableCount: domain.tables.length };
  return Object.fromEntries(Object.keys(row).sort((a, b) =>
    (order[a] ?? Infinity) - (order[b] ?? Infinity) || (a < b ? -1 : a > b ? 1 : 0))
    .map(key => [key, row[key]]));
}

export async function proveCatalogProjection(args, evidence, refusal) {
  let reason;
  const skipped = value => { reason = value; return null; };
  if (args.repo !== CATALOG_REPO || refusal.path !== CATALOG_PATH
    || refusal.reason !== 'primary-change-reverted' || refusal.missingEvidence?.path !== refusal.path
    || refusal.missingEvidence?.evidence !== 'reversal-authorization'
    || !refusal.missingEvidence.regions?.length || args.headSha !== evidence.headSha
    || evidence.completeFileLists !== true || !args.get.regularDataFile || !args.get.metadata) return null;
  const { repo, headSha, get, signal } = args;
  const { mergeBase, primaryHead } = evidence;
  if (![headSha, mergeBase, primaryHead].every(ref => SHA.test(ref || ''))
    || evidence.finalFiles?.some(file => file.filename === CATALOG_PATH || file.previous_filename === CATALOG_PATH)) return null;
  // Do not read live metadata or blobs when no authoritative fragment can
  // bind both comparisons. The catalog replay selects the exact slug later.
  if (!Array.isArray(evidence.primaryFiles) || !Array.isArray(evidence.finalFiles)
    || !evidence.primaryFiles.some(file =>
      /^docs\/data-model\/catalog\.d\/domains\/[a-z0-9]+(?:-[a-z0-9]+)*\.json$/.test(file.filename)
      && modifiedBlob(evidence.primaryFiles, file.filename) && modifiedBlob(evidence.finalFiles, file.filename))) return null;
  const prPath = `repos/${repo}/pulls/${args.prNumber}`;
  const isTrustedBase = base => base?.ref === 'main' && base.repo?.full_name === repo && SHA.test(base.sha || '');
  const show = async (ref, path) => {
    const bytes = await get.regularDataFile(repo, ref, path, { asBuffer: true });
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) throw new Error('invalid catalog proof blob');
    return bytes;
  };
  const ancestor = async (from, to) => {
    if (from === to) return true;
    const result = await get.metadata(`repos/${repo}/compare/${from}...${to}`);
    return result?.status === 'ahead' && result.merge_base_commit?.sha === from;
  };
  try {
    const live = await get(prPath);
    if (live?.head?.sha !== headSha) { reason = 'head-moved'; return { headMismatch: true }; }
    if (!isTrustedBase(live.base) || evidence.baseRef !== live.base.ref || evidence.baseSha !== live.base.sha) return skipped('base-mismatch');
    const baseSha = live.base.sha;
    // Resolve the recipe on the repository's live base independently of the
    // protected author and candidate. SHA-addressed PR content cannot opt in.
    if (sha256(await show(baseSha, RECIPE_PATH)) !== RECIPE) return skipped('recipe-drift');
    if (!await ancestor(mergeBase, baseSha) || !await ancestor(mergeBase, primaryHead)
      || !await ancestor(primaryHead, headSha)) return skipped('ancestry-mismatch');
    const baseBytes = await show(mergeBase, CATALOG_PATH);
    const primaryBytes = await show(primaryHead, CATALOG_PATH);
    const headBytes = await show(headSha, CATALOG_PATH);
    if (!headBytes.equals(baseBytes) || primaryBytes.equals(baseBytes)) return skipped('catalog-mismatch');
    reason = 'invalid-catalog';
    const base = parse(baseBytes);
    const primary = parse(primaryBytes);
    if (!object(base) || !object(primary) || !Array.isArray(base.domains)
      || !Array.isArray(primary.domains) || base.domains.length !== primary.domains.length
      || !baseBytes.equals(Buffer.from(render(base)))) return skipped('invalid-catalog');
    const changed = base.domains.map((domain, index) =>
      render(domain) === render(primary.domains[index]) ? -1 : index).filter(index => index !== -1);
    if (changed.length !== 1) return skipped('not-single-domain');
    const [index] = changed;
    const slug = base.domains[index]?.slug;
    const exact = binding(evidence, slug);
    if (!exact || base.domains.filter(domain => domain?.slug === slug).length !== 1
      || gitBlob(primaryBytes) !== exact.primaryBlob) return skipped('binding-mismatch');

    const orderBytes = await show(baseSha, ORDER_PATH);
    for (const ref of new Set([mergeBase, primaryHead, headSha])) {
      if (sha256(await show(ref, RECIPE_PATH)) !== RECIPE) return skipped('recipe-drift');
      if (!(await show(ref, ORDER_PATH)).equals(orderBytes)) return skipped('order-drift');
    }
    reason = 'invalid-order';
    const order = parse(orderBytes, { fragment: true })?.domainFields?.[slug];
    if (!object(order) || !Object.values(order).every(Number.isSafeInteger)) return skipped('invalid-order');
    reason = 'invalid-fragment';
    const beforeBytes = await show(mergeBase, exact.fragment);
    const authorBytes = await show(primaryHead, exact.fragment);
    const finalBytes = await show(headSha, exact.fragment);
    const baseFragment = gitBlob(beforeBytes);
    if (gitBlob(authorBytes) !== exact.primaryFragment || gitBlob(finalBytes) !== exact.headFragment
      || baseFragment === exact.primaryFragment || baseFragment === exact.headFragment) return skipped('fragment-mismatch');

    const before = projectDomain(parse(beforeBytes, { fragment: true }), slug, order);
    const author = projectDomain(parse(authorBytes, { fragment: true }), slug, order);
    const final = projectDomain(parse(finalBytes, { fragment: true }), slug, order);
    if (render(before) !== render(base.domains[index])) return skipped('base-projection-mismatch');
    // Only one added record in an existing domain qualifies. The candidate
    // must retain that record's identity. The ordinary predicate still checks
    // every source hunk, including edits to the record itself.
    const added = Object.keys(author).filter(key => !Object.hasOwn(before, key));
    if (added.length !== 1) return skipped('not-single-record');
    const [key] = added;
    const record = author[key];
    const retained = Object.hasOwn(final, key) ? final[key] : null;
    if (!object(record) || !object(retained)
      || !['source', 'documentation'].every(field => typeof record[field] === 'string' && record[field]
        && Object.hasOwn(retained, field) && retained[field] === record[field])
      || !Object.keys(record).every(field => Object.hasOwn(retained, field))) return skipped('record-mismatch');
    const remaining = { ...author };
    delete remaining[key];
    if (render(remaining) !== render(before)) return skipped('record-replacement');
    base.domains[index] = author;
    if (!primaryBytes.equals(Buffer.from(render(base)))) return skipped('replay-mismatch');

    const current = await get(prPath);
    signal?.throwIfAborted();
    if (current?.head?.sha !== headSha) { reason = 'head-moved'; return { headMismatch: true }; }
    if (!isTrustedBase(current.base) || current.base.sha !== baseSha) return skipped('base-mismatch');
    reason = null;
    return { proof: { ...exact, version: 1, repository: repo, path: CATALOG_PATH, recipe: RECIPE, slug,
      baseSha, baseBlob: gitBlob(baseBytes), headBlob: gitBlob(headBytes), orderBlob: gitBlob(orderBytes), baseFragment } };
  } catch (error) {
    signal?.throwIfAborted();
    if (readFailure(error)) {
      reason = 'read-failed';
      throw error;
    }
    reason ||= 'proof-input-invalid';
    return null;
  } finally {
    if (reason) console.warn('[catalog-projection] proof skipped: ' + JSON.stringify({
      repo: String(repo).replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 200),
      prNumber: Number.isSafeInteger(Number(args.prNumber)) ? Number(args.prNumber) : null,
      headSha: SHA.test(headSha || '') ? headSha : null,
      path: CATALOG_PATH, reason,
    }));
  }
}

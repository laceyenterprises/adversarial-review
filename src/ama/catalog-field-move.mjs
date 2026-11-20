import { isTransientGhError } from '../gh-cli.mjs';

// The Agent OS GENCONFLICT registry owns this specific projection. Only this
// reviewed policy selects the layout; files in the PR cannot opt into it.
export const CATALOG_REPO = 'laceyenterprises/agent-os';
export const CATALOG_PATH = 'docs/data-model/catalog.json';
const ORDER_PATH = 'docs/data-model/catalog.d/legacy-order.json';
const DERIVED_FIELDS = new Set(['databases', 'domains', 'crossDomainReferences', 'tableCount', 'domainCount']);
const readFailure = error => error?.primaryChangeReadFailed === true || error?.authOutage === true
  || error?.code === 'HISTORY_READ_INVALID' || error?.name === 'AbortError'
  || error?.code === 'ABORT_ERR' || isTransientGhError(error);

function canonicalJson(text) {
  const value = JSON.parse(text);
  const rendered = JSON.stringify(value, null, 2)
    .replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  // A round trip in the owner's exact wire format rejects duplicate keys at
  // every depth without normalizing objects, arrays or JSON string spellings.
  if (text !== `${rendered}\n` || !value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('expected a canonical JSON object');
  }
  return value;
}

function inIdentityOrder(catalog, order) {
  const keys = Object.keys(catalog);
  const sorted = [...keys].sort((a, b) =>
    (Object.hasOwn(order, a) ? order[a] : Infinity) - (Object.hasOwn(order, b) ? order[b] : Infinity)
    || (a < b ? -1 : a > b ? 1 : 0));
  return keys.every((key, index) => sorted[index] === key);
}

export async function proveCatalogFieldMove(args, evidence, insertion) {
  let reason;
  const skipped = value => { reason = value; return null; };
  try {
    // This proof covers exactly one stand-alone insertion of a top-level string.
    // A mixed edit at this anchor has only one preservation unit and cannot be split.
    const line = insertion.lines[0].slice(1);
    const key = line && /^ {2}"([a-zA-Z][a-zA-Z0-9]*)": "/.exec(line)?.[1];
    if (!key || DERIVED_FIELDS.has(key) || args.repo !== CATALOG_REPO) return skipped('unsupported-insertion');
    const fragmentPath = `docs/data-model/catalog.d/fields/${key}.json`;
    const { headSha, mergeBase, primaryHead } = evidence;
    if (!args.get.regularDataFile) return skipped('reader-unavailable');
    // An externally published head may not be visible in the worker clone.
    const show = (ref, path, options) => args.get.regularDataFile(args.repo, ref, path, options);
    const primaryText = await show(primaryHead, CATALOG_PATH);
    if (primaryText.split('\n')[insertion.next - 1] !== line) return skipped('insertion-mismatch');
    const reads = await Promise.allSettled([
      show(mergeBase, CATALOG_PATH),
      show(headSha, CATALOG_PATH),
      show(mergeBase, fragmentPath, { optional: true }),
      show(primaryHead, fragmentPath),
      show(headSha, fragmentPath),
      show(mergeBase, ORDER_PATH),
      show(primaryHead, ORDER_PATH),
      show(headSha, ORDER_PATH),
    ]);
    // Do not let an earlier semantic refusal hide a sibling transport failure.
    const failedRead = reads.find(result => result.status === 'rejected' && readFailure(result.reason));
    if (failedRead) throw failedRead.reason;
    const [baseText, finalText, baseFragment, primaryFragment, finalFragment, orderText, primaryOrder, finalOrder] =
      reads.map(result => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
      });
    if (baseFragment !== null || primaryFragment !== finalFragment) return skipped('fragment-mismatch');
    if (orderText !== primaryOrder || orderText !== finalOrder) return skipped('order-changed');

    reason = 'noncanonical-json';
    const base = canonicalJson(baseText);
    const primary = canonicalJson(primaryText);
    const final = canonicalJson(finalText);
    const fragment = canonicalJson(finalFragment);
    const order = canonicalJson(orderText).fields;
    reason = 'invalid-field-move';
    if (!order || typeof order !== 'object' || Array.isArray(order)
      || !Object.values(order).every(Number.isSafeInteger)
      || Object.hasOwn(order, key) || Object.hasOwn(base, key)
      || Object.keys(fragment).length !== 1 || !Object.hasOwn(fragment, key)
      || !Object.hasOwn(primary, key) || !Object.hasOwn(final, key)
      || typeof primary[key] !== 'string' || primary[key] !== fragment[key] || final[key] !== fragment[key]) return null;
    if (!inIdentityOrder(final, order)) return skipped('not-identity-order');
    if (Object.keys(primary).indexOf(key) === Object.keys(final).indexOf(key)) return skipped('field-unmoved');

    reason = null;
    return { path: CATALOG_PATH, start: insertion.old, end: insertion.old, insertionLine: line,
      headSha, mergeBase, primaryHead };
  } catch (error) {
    args.signal?.throwIfAborted();
    if (readFailure(error)) {
      reason = 'read-failed';
      throw error;
    }
    reason ||= 'proof-input-invalid';
    return null;
  } finally {
    if (reason) console.warn('[catalog-field-move] proof skipped: ' + JSON.stringify({
      repo: String(args.repo).replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 200),
      prNumber: Number.isSafeInteger(Number(args.prNumber)) ? Number(args.prNumber) : null,
      headSha: /^[0-9a-f]{40}$/.test(evidence.headSha || '') ? evidence.headSha : null,
      path: CATALOG_PATH, reason,
    }));
  }
}

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';

// The Agent OS GENCONFLICT registry owns this specific projection. Only this
// reviewed policy selects the layout; files in the PR cannot opt into it.
export const CATALOG_REPO = 'laceyenterprises/agent-os';
export const CATALOG_PATH = 'docs/data-model/catalog.json';
const ORDER_PATH = 'docs/data-model/catalog.d/legacy-order.json';
const DERIVED_FIELDS = new Set(['databases', 'domains', 'crossDomainReferences', 'tableCount', 'domainCount']);
const exec = promisify(execFile);

// Explicit local diagnostics can use a publisher clone. Read the named
// objects directly, without materializing its worktree or running a generator.
function localDataReader(repository, signal) {
  const cwd = resolve(repository);
  const git = async (...args) => {
    const { stdout } = await exec('git', ['--no-lazy-fetch', '--no-replace-objects',
      '--literal-pathspecs', ...args], { cwd, signal, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file', LC_ALL: 'C' } });
    return stdout;
  };
  return async (ref, path, { optional = false } = {}) => {
    if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error('invalid immutable catalog identity');
    const entry = await git('ls-tree', '--full-tree', '-z', `${ref}^{commit}`, '--', path);
    if (!entry && optional) return null;
    const [, oid, name] = /^100644 blob ([0-9a-f]{40})\t([^\0]+)\0$/.exec(entry) || [];
    if (name !== path) throw new Error('expected a regular data file in the Git tree');
    return git('cat-file', 'blob', oid);
  };
}

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
  // This proof covers exactly one stand-alone insertion of a top-level string.
  // A mixed edit at this anchor has only one preservation unit and cannot be split.
  const line = insertion.lines[0].slice(1);
  const key = line && /^ {2}"([a-zA-Z][a-zA-Z0-9]*)": "/.exec(line)?.[1];
  if (!key || DERIVED_FIELDS.has(key) || args.repo !== CATALOG_REPO) return null;
  const fragmentPath = `docs/data-model/catalog.d/fields/${key}.json`;
  const { headSha, mergeBase, primaryHead } = evidence;
  let show;
  if (args.localRepository) {
    const signal = AbortSignal.any([...(args.signal ? [args.signal] : []), AbortSignal.timeout(loadAwareTimeoutMs(30000))]);
    show = localDataReader(args.localRepository, signal);
  } else if (args.get.regularDataFile) {
    // An externally published head may not be visible in the worker clone.
    show = (ref, path, options) => args.get.regularDataFile(args.repo, ref, path, options);
  } else return null;
  try {
    const primaryText = await show(primaryHead, CATALOG_PATH);
    if (primaryText.split('\n')[insertion.next - 1] !== line) return null;
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
    const [baseText, finalText, baseFragment, primaryFragment, finalFragment, orderText, primaryOrder, finalOrder] =
      reads.map(result => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
      });
    if (baseFragment !== null || primaryFragment !== finalFragment
      || orderText !== primaryOrder || orderText !== finalOrder) return null;

    const base = canonicalJson(baseText);
    const primary = canonicalJson(primaryText);
    const final = canonicalJson(finalText);
    const fragment = canonicalJson(finalFragment);
    const order = canonicalJson(orderText).fields;
    if (!order || typeof order !== 'object' || Array.isArray(order)
      || !Object.values(order).every(Number.isSafeInteger)
      || Object.hasOwn(order, key) || Object.hasOwn(base, key)
      || Object.keys(fragment).length !== 1 || !Object.hasOwn(fragment, key)
      || !Object.hasOwn(primary, key) || !Object.hasOwn(final, key)
      || typeof primary[key] !== 'string' || primary[key] !== fragment[key] || final[key] !== fragment[key]
      || !inIdentityOrder(final, order)
      || Object.keys(primary).indexOf(key) === Object.keys(final).indexOf(key)) return null;

    return { path: CATALOG_PATH, start: insertion.old, end: insertion.old, insertionLine: line,
      headSha, mergeBase, primaryHead };
  } catch {
    args.signal?.throwIfAborted();
    return null;
  }
}

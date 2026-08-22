/**
 * Serving the ARF SPA (ARF-05).
 *
 * The frontend is `frontend/frontend`: plain HTML, CSS, and ES modules with no
 * build step, which is what lets ARF keep its zero-dependency boundary all the
 * way to the browser. So "serving the frontend" is genuinely just reading files,
 * and the only part that needs care is making sure it cannot read files it
 * shouldn't.
 *
 * ## The traversal guard
 *
 * A static handler is the classic place to leak `/etc/passwd`, and ARF's state
 * root sits next to a secret-reference manifest. Two independent defences:
 *
 *  1. The URL's pathname is used, which `node:http` has already percent-decoded
 *     and which cannot contain a raw `?` or `#`; it is then resolved against the
 *     frontend root and the result is required to still be *inside* that root.
 *     `resolve()` collapses `..` before the check, so the check sees what would
 *     actually be opened.
 *  2. Only a known extension is served. A file with no extension, a dotfile, or
 *     anything outside the small type table is a 404 — so even a path that got
 *     past the first guard could not return a key, a database, or a JSON config.
 *
 * ## No catch-all rewrite to `index.html`
 *
 * The usual SPA handler answers every unmatched path with the shell so the client
 * router can take over. ARF deliberately does not: the shell lives at `/`, and
 * anything else that is not a real file is a 404 from the API.
 *
 * The reason is that a catch-all makes every mistyped API path return `200
 * text/html`. `GET /v1/standup/identity/rolez` would come back as a page, and the
 * caller would get a JSON parse error somewhere else entirely instead of the 404
 * that says what actually happened. ARF's panel is one page with no client-side
 * routing, so the rewrite buys nothing and costs that. When a later screen needs
 * real client routes, it can name them rather than reinstating the wildcard.
 */

import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// src -> server -> arf -> frontend
export const FRONTEND_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend',
);

/** The only extensions that get served, and what they are served as. */
const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.png', 'image/png'],
  ['.woff2', 'font/woff2'],
]);

/**
 * Resolve a request pathname to a file inside the frontend root.
 *
 * @param {string} pathname
 * @returns {{path: string, contentType: string}|null} null when nothing may be served
 */
export function resolveStaticFile(pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const target = resolve(join(FRONTEND_ROOT, requested));

  // Escaping the root is the whole attack; `resolve` has already collapsed `..`,
  // so this compares the path that would really be opened. The separator check
  // stops `frontend-secrets/` from passing as a prefix match of `frontend`.
  if (target !== FRONTEND_ROOT && !target.startsWith(`${FRONTEND_ROOT}/`)) return null;

  let stats;
  try {
    stats = statSync(target);
  } catch {
    // Not a file ARF has. The caller's 404 applies — see the header for why there
    // is no rewrite to the shell here.
    return null;
  }

  const path = stats.isDirectory() ? join(target, 'index.html') : target;
  const contentType = CONTENT_TYPES.get(extname(path).toLowerCase());
  // An unlisted extension is not served at all, so the traversal guard is not
  // the only thing standing between a request and a file it should not get.
  if (!contentType) return null;
  return { path, contentType };
}

/**
 * Serve a static file if the path resolves to one.
 *
 * The body is read asynchronously: this process also holds long-lived SSE
 * streams, and a burst of asset requests read synchronously would stall every
 * one of them plus whatever API work is in flight, on the same single thread.
 * The `stat` in `resolveStaticFile` stays synchronous — it is a metadata lookup,
 * not a read, and keeping it so lets the routing decision ("is this a file ARF
 * serves at all?") stay a plain answer the router and its tests can use directly.
 *
 * @param {string} pathname
 * @param {import('node:http').ServerResponse} res
 * @param {{head?: boolean}} [options]
 * @returns {Promise<boolean>} whether the request was handled
 */
export async function serveStatic(pathname, res, { head = false } = {}) {
  const resolved = resolveStaticFile(pathname);
  if (!resolved) return false;

  let body;
  try {
    body = await readFile(resolved.path);
  } catch {
    // Resolved but unreadable — a missing index.html in a checkout without the
    // frontend tree. Not handled here, so the caller's 404 applies and says so.
    return false;
  }

  // The client may have gone while the read was in flight; writing to a socket
  // that is already destroyed raises an error into a promise nobody is waiting on.
  if (res.writableEnded || res.destroyed) return true;

  res.writeHead(200, {
    'content-type': resolved.contentType,
    'content-length': body.length,
    // The SPA is served from the same process as the API it calls; a cached
    // stale bundle talking to a newer API is a debugging session nobody needs.
    'cache-control': 'no-cache',
  });
  if (head) res.end();
  else res.end(body);
  return true;
}

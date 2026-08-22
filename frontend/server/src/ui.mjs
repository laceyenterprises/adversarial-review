/**
 * Serving the ARF frontend (SPEC §9: `frontend/frontend`).
 *
 * The frontend is plain ES modules and plain CSS with no build step, so serving
 * it is reading a file out of one directory. That is also the whole risk: a
 * static handler that maps a URL onto a path is the classic traversal bug, so
 * the resolved path is checked to be *inside* the frontend root after
 * resolution, not before — `..` survives every check that runs first.
 *
 * ARF-06 ships Screen C's harness panel here. `/` is served by `static.mjs` for
 * the identity standup panel, so `/ui/` uses its own harness shell instead of
 * sharing `index.html`.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// src -> server -> arf -> frontend
export const FRONTEND_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend',
);

/**
 * Content types for the file kinds a no-build-step frontend is made of. An
 * extension that is not here is not served at all — a deny-by-default list is
 * one fewer thing to get wrong than an escape hatch that guesses.
 */
const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.json', 'application/json; charset=utf-8'],
  ['.ico', 'image/x-icon'],
]);

function notFound(res, detail) {
  const payload = JSON.stringify({ error: 'not_found', detail });
  res.writeHead(404, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/**
 * Serve `/ui` and `/ui/*` from the frontend tree.
 *
 * @returns {Promise<boolean>} whether the request belonged to the UI surface
 */
export async function handleUiRequest(req, res, { pathname, method, root = FRONTEND_ROOT }) {
  if (pathname !== '/ui' && !pathname.startsWith('/ui/')) return false;

  if (method !== 'GET' && method !== 'HEAD') {
    const payload = JSON.stringify({ error: 'method_not_allowed', detail: `${method} is not supported` });
    res.writeHead(405, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
    return true;
  }

  // `/ui` without the slash would make every relative asset resolve against
  // `/`, so the page would load and none of its modules would.
  if (pathname === '/ui') {
    res.writeHead(302, { location: '/ui/', 'cache-control': 'no-store' });
    res.end();
    return true;
  }

  const requested = pathname.slice('/ui/'.length);
  const decoded = decodeURIComponent(requested);
  const relative = decoded === '' || decoded === 'index.html' ? 'harness.html' : decoded;
  const target = resolve(root, normalize(relative));

  // After resolution, not before: `normalize` collapses `..`, but only a
  // containment check on the final path can say whether the answer is still
  // inside the root (a symlinked entry inside the tree is resolved by `stat`
  // below, and a target outside it simply will not exist under this root).
  if (target !== root && !target.startsWith(root + sep)) {
    notFound(res, 'path escapes the frontend root');
    return true;
  }

  const contentType = CONTENT_TYPES.get(extname(target).toLowerCase());
  if (!contentType) {
    notFound(res, `ARF does not serve ${extname(target) || 'extensionless'} files`);
    return true;
  }

  let info;
  try {
    info = await stat(target);
  } catch {
    notFound(res, `no such asset ${relative}`);
    return true;
  }
  if (!info.isFile()) {
    notFound(res, `${relative} is not a file`);
    return true;
  }

  res.writeHead(200, {
    'content-type': contentType,
    'content-length': info.size,
    // The panel is served straight off disk with no build hash, so a cached
    // copy would survive an ARF upgrade and talk to an API that had moved.
    'cache-control': 'no-store',
  });
  if (method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(target).pipe(res);
  return true;
}

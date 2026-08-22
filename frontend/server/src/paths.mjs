/**
 * Path resolution shared by ARF's config source and its broker manifest.
 *
 * It lives in its own module rather than in `config.mjs` because
 * `broker/manifest.mjs` needs it too, and `config.mjs` already imports the
 * manifest — putting it there would close a cycle.
 *
 * The one rule worth stating: ARF's paths arrive from JSON config files, from
 * env vars set in a launchd plist, and from `rolesFile` entries — none of which
 * pass through a shell. So `~/.arf/roles.json` reaches the process with the
 * tilde intact, and `node:path` treats `~` as an ordinary directory name. Every
 * path key ARF accepts is expanded here, once, so an operator does not have to
 * remember which keys happen to go through which resolver.
 */

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Expand a leading `~/` — and a bare `~` — to the current user's home.
 *
 * Only the leading segment: a `~` anywhere else is a legal filename character
 * and expanding it would corrupt a path an operator meant literally.
 *
 * @param {string} value
 * @returns {string}
 */
export function expandHome(value) {
  const text = String(value);
  if (text === '~') return homedir();
  if (text.startsWith('~/')) return join(homedir(), text.slice(2));
  return text;
}

/**
 * `expandHome`, then resolve against `base` if what is left is still relative.
 *
 * @param {string} value
 * @param {string} base directory a relative path is anchored to
 * @returns {string} an absolute path
 */
export function absolutize(value, base) {
  const text = expandHome(value);
  return isAbsolute(text) ? resolve(text) : resolve(base, text);
}

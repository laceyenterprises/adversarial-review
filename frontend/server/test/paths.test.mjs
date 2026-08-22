/**
 * Path expansion shared by the config source and the broker manifest.
 *
 * ARF's paths come from JSON config files, launchd plist env vars, and
 * `rolesFile` entries — none of which pass through a shell, so `~` arrives
 * literal and `node:path` would treat it as an ordinary directory name.
 */

import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { absolutize, expandHome } from '../src/paths.mjs';

describe('expandHome', () => {
  it('expands a leading ~/ and a bare ~', () => {
    assert.equal(expandHome('~/.arf/roles.json'), join(homedir(), '.arf', 'roles.json'));
    assert.equal(expandHome('~'), homedir());
  });

  it('leaves a tilde that is not the leading segment alone', () => {
    // `~` is a legal filename character; expanding it anywhere but the front
    // would corrupt a path an operator meant literally.
    assert.equal(expandHome('/srv/~backup/roles.json'), '/srv/~backup/roles.json');
    assert.equal(expandHome('~user/roles.json'), '~user/roles.json');
    assert.equal(expandHome('roles~.json'), 'roles~.json');
  });

  it('passes ordinary absolute and relative paths through unchanged', () => {
    assert.equal(expandHome('/etc/arf/roles.json'), '/etc/arf/roles.json');
    assert.equal(expandHome('roles.json'), 'roles.json');
  });
});

describe('absolutize', () => {
  it('anchors a relative path to the given base', () => {
    assert.equal(absolutize('roles.json', '/srv/arf'), '/srv/arf/roles.json');
  });

  it('ignores the base for an absolute path', () => {
    assert.equal(absolutize('/etc/arf/roles.json', '/srv/arf'), '/etc/arf/roles.json');
  });

  it('treats an expanded ~/ as absolute, not as relative to the base', () => {
    assert.equal(absolutize('~/.arf/roles.json', '/srv/arf'), join(homedir(), '.arf', 'roles.json'));
  });
});

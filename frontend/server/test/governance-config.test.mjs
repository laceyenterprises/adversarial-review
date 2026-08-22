/**
 * The governance config source, and the tiny YAML reader under it (ARF-04).
 *
 * The property both halves exist to hold: a value ARF reports is a value it can
 * vouch for, and everything else is `known: false`. A wrong `true` here becomes
 * an `armed` on the panel, which is the failure this ticket is about.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ENV_LAYER_UNOBSERVABLE, readGovernanceConfig } from '../src/governance/config-source.mjs';
import { readScalarYaml } from '../src/governance/scalar-yaml.mjs';

const roots = [];
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'arf-governance-'));
  roots.push(root);
  return root;
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A minimal merge-authority block at the nesting the real config uses. */
function mergeAuthorityYaml(body) {
  return ['roles:', '  adversarial:', '    merge_authority:', ...body.map((line) => `      ${line}`), ''].join('\n');
}

function layer(root, name, text) {
  const path = join(root, name);
  writeFileSync(path, text);
  return { path, label: name };
}

describe('scalar YAML reader', () => {
  it('reads a nested scalar at the depth the pipeline config uses', () => {
    const doc = readScalarYaml(mergeAuthorityYaml([
      'autonomous_merge_execution_enabled: true',
      'strict_mode: false',
      'hammer_lifetime_ceiling: 6',
    ]));
    assert.equal(doc.get('roles.adversarial.merge_authority.autonomous_merge_execution_enabled'), true);
    assert.equal(doc.get('roles.adversarial.merge_authority.strict_mode'), false);
    assert.equal(doc.get('roles.adversarial.merge_authority.hammer_lifetime_ceiling'), 6);
  });

  it('ignores comments, including a trailing one on a value', () => {
    const doc = readScalarYaml([
      '# leading comment',
      'roles:',
      '  # nested comment',
      '  adversarial:',
      '    merge_authority:',
      '      enabled: false   # the master switch',
      '',
    ].join('\n'));
    assert.equal(doc.get('roles.adversarial.merge_authority.enabled'), false);
  });

  it('keeps a "#" that is part of a value', () => {
    const doc = readScalarYaml('a:\n  b: sha#1234\n');
    assert.equal(doc.get('a.b'), 'sha#1234');
  });

  it('does not let a sequence leak its item keys into the parent namespace', () => {
    // `- name: x` under `list:` would otherwise register as `list.name`.
    const doc = readScalarYaml([
      'watcher:',
      '  enabled: true',
      '  events:',
      '    - name: health.worker.*',
      '      enabled: false',
      '',
    ].join('\n'));
    assert.equal(doc.get('watcher.enabled'), true);
    assert.equal(doc.get('watcher.events.enabled'), undefined);
    assert.match(doc.refusalFor('watcher.events'), /sequence/);
  });

  it('drops the whole subtree a refused construct sits in, including values already read', () => {
    const doc = readScalarYaml([
      'block:',
      '  keep: true',
      '  items:',
      '    - one',
      '',
    ].join('\n'));
    assert.equal(doc.get('block.keep'), true, 'a sibling subtree is untouched');
    assert.equal(doc.get('block.items'), undefined);
  });

  it('skips a block scalar body rather than reading it as structure', () => {
    const doc = readScalarYaml([
      'a:',
      '  note: |',
      '    enabled: true',
      '    autonomous_merge_execution_enabled: true',
      '  enabled: false',
      '',
    ].join('\n'));
    // The keys inside the block body are prose, not config.
    assert.equal(doc.get('a.enabled'), false);
    assert.equal(doc.get('a.note.enabled'), undefined);
    assert.match(doc.refusalFor('a.note'), /block scalar/);
  });

  it('refuses flow collections, anchors, aliases, and tags', () => {
    const doc = readScalarYaml([
      'a: [1, 2]',
      'b: &anchor',
      'c: !!str x',
      '',
    ].join('\n'));
    assert.equal(doc.get('a'), undefined);
    assert.match(doc.refusalFor('a'), /flow collection/);
    assert.match(doc.refusalFor('b'), /anchor/);
    assert.match(doc.refusalFor('c'), /anchor|tag/);
  });

  it('refuses a whole document with tab indentation or multiple documents', () => {
    const tabbed = readScalarYaml('a:\n\tb: true\n');
    assert.equal(tabbed.get('a.b'), undefined);
    assert.match(tabbed.fatal, /tab/);

    const multi = readScalarYaml('a: true\n---\na: false\n');
    assert.equal(multi.get('a'), undefined);
    assert.match(multi.fatal, /multi-document/);
  });

  it('leaves YAML 1.1 boolean spellings as strings rather than guessing', () => {
    // `yes`/`on` mean different things in YAML 1.1 and 1.2. Guessing here would
    // put a fabricated boolean behind a kill switch.
    const doc = readScalarYaml('a: yes\nb: on\n');
    assert.equal(doc.get('a'), 'yes');
    assert.equal(doc.get('b'), 'on');
  });

  it('unquotes simple quoted scalars', () => {
    const doc = readScalarYaml('a: "x y"\nb: \'z\'\n');
    assert.equal(doc.get('a'), 'x y');
    assert.equal(doc.get('b'), 'z');
  });
});

describe('governance config layering', () => {
  it('resolves an unset key to the pipeline schema default when a layer was read', () => {
    const root = workspace();
    const result = readGovernanceConfig({
      files: [layer(root, 'config.yaml', 'roles:\n  adversarial:\n    handoff:\n      enabled: false\n')],
    });
    // Not set anywhere -> the schema default from config-loader.mjs, and the
    // two headline defaults are opposites.
    assert.equal(result.keys.enabled.value, false);
    assert.equal(result.keys.enabled.source, 'default');
    assert.equal(result.keys.autonomousMergeExecutionEnabled.value, true);
    assert.equal(result.keys.autonomousMergeExecutionEnabled.source, 'default');
  });

  it('refuses to fall back to defaults when no layer could be read at all', () => {
    // A deploy pointed at a pipeline that is not there does not get to report
    // the pipeline's schema defaults as if they were live values.
    const result = readGovernanceConfig({ files: [{ path: join(workspace(), 'absent.yaml') }] });
    assert.equal(result.anySourceReadable, false);
    assert.equal(result.keys.enabled.known, false);
    assert.equal(result.keys.enabled.value, null);
    assert.match(result.keys.enabled.reason, /no governance config source/);
  });

  it('lets a higher layer override a lower one', () => {
    const root = workspace();
    const result = readGovernanceConfig({
      files: [
        layer(root, 'module.yaml', mergeAuthorityYaml(['autonomous_merge_execution_enabled: true'])),
        layer(root, 'module.local.yaml', mergeAuthorityYaml(['autonomous_merge_execution_enabled: false'])),
      ],
    });
    assert.equal(result.keys.autonomousMergeExecutionEnabled.value, false);
    assert.equal(result.keys.autonomousMergeExecutionEnabled.sourcePath, join(root, 'module.local.yaml'));
    assert.equal(result.keys.autonomousMergeExecutionEnabled.setIn.length, 2);
  });

  it('turns a value of the wrong type into unknown rather than coercing it', () => {
    const root = workspace();
    const result = readGovernanceConfig({
      files: [layer(root, 'config.yaml', mergeAuthorityYaml(['enabled: maybe']))],
    });
    assert.equal(result.keys.enabled.known, false);
    assert.match(result.keys.enabled.reason, /wrong type/);
  });

  it('turns a layer it cannot read into unknown even when a lower layer set the key', () => {
    // The unreadable layer outranks the readable one, so it could be setting
    // the key to anything. Reporting the lower layer's value would be a guess.
    const root = workspace();
    const result = readGovernanceConfig({
      files: [
        layer(root, 'low.yaml', mergeAuthorityYaml(['enabled: true'])),
        layer(root, 'high.yaml', [
          'roles:',
          '  adversarial:',
          '    merge_authority:',
          '      - enabled: false',
          '',
        ].join('\n')),
      ],
    });
    assert.equal(result.keys.enabled.known, false);
    assert.match(result.keys.enabled.reason, /cannot read/);
  });
});

describe('the environment layer', () => {
  it('reports itself unobservable by default and caveats every env-overridable key', () => {
    const root = workspace();
    const result = readGovernanceConfig({
      files: [layer(root, 'config.yaml', mergeAuthorityYaml(['enabled: true']))],
    });
    assert.equal(result.envLayer.observable, false);
    assert.match(result.envLayer.reason, /cannot read another process/);
    assert.ok(result.keys.enabled.caveats.includes(ENV_LAYER_UNOBSERVABLE));
    assert.ok(
      result.keys.autonomousMergeExecutionEnabled.caveats.includes(ENV_LAYER_UNOBSERVABLE),
    );
    // A key with no env override carries no such caveat.
    assert.deepEqual(result.keys.strictNonBlockingRemediation.caveats, []);
  });

  it('lets a configured snapshot override every file layer', () => {
    const root = workspace();
    const envFile = join(root, 'daemon-env.json');
    writeFileSync(envFile, JSON.stringify({
      AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_AUTONOMOUS_MERGE_EXECUTION_ENABLED: 'false',
    }));
    const result = readGovernanceConfig({
      files: [layer(root, 'config.yaml', mergeAuthorityYaml(['autonomous_merge_execution_enabled: true']))],
      envFile,
    });
    assert.equal(result.envLayer.observable, true);
    assert.equal(result.keys.autonomousMergeExecutionEnabled.value, false);
    assert.equal(result.keys.autonomousMergeExecutionEnabled.source, 'env');
    assert.deepEqual(result.keys.autonomousMergeExecutionEnabled.caveats, []);
  });

  it('turns an uninterpretable env value into unknown', () => {
    const root = workspace();
    const envFile = join(root, 'daemon-env.json');
    writeFileSync(envFile, JSON.stringify({
      AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_ENABLED: 'perhaps',
    }));
    const result = readGovernanceConfig({
      files: [layer(root, 'config.yaml', mergeAuthorityYaml(['enabled: true']))],
      envFile,
    });
    assert.equal(result.keys.enabled.known, false);
    assert.match(result.keys.enabled.reason, /not a boolean/);
  });

  it('does not read the ambient process environment', async () => {
    // ARF's own env is not the daemon's. Presenting it as such would be a
    // confident wrong answer about a kill switch.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      fileURLToPath(new URL('../src/governance/config-source.mjs', import.meta.url)),
      'utf8',
    );
    // Comments stripped: the module documents *why* it does not read
    // `process.env`, and the guard is about the code, not the explanation.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/process\.env/.test(code), 'config-source must never read process.env');
  });
});

/**
 * Installing / verifying a harness runtime (ARF-06 step 3).
 *
 * Two of these cases are about safety rather than about runtimes: the command
 * allowlist (this step runs on behalf of an HTTP POST) and the install gate.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  RuntimeProbeError, probeRuntime, resolveExecutable, satisfiesMinVersion,
} from '../src/standup/runtime-probe.mjs';
import { fakeBinary, fakeExecFile, tmpStateRoot } from './helpers/standup-fixtures.mjs';

const ALLOWLIST = ['claude', 'codex', 'node'];

function runtime(overrides = {}) {
  return {
    command: 'claude', versionArgs: ['--version'], installCommand: null, installArgs: [],
    minVersion: null, ...overrides,
  };
}

describe('runtime probe', () => {
  it('resolves the binary and reports the path and version it found', async () => {
    // Which binary was probed matters: two `claude` on one machine is ordinary.
    const dir = join(tmpStateRoot(), 'bin');
    const path = fakeBinary(dir, 'claude');
    const result = await probeRuntime({
      runtime: runtime(),
      allowlist: ALLOWLIST,
      searchPath: [dir],
      env: { PATH: '' },
      execFileImpl: fakeExecFile({ claude: { stdout: 'claude 1.4.2\n' } }),
    });
    assert.equal(result.verified, true);
    assert.equal(result.resolvedPath, path);
    assert.equal(result.version, 'claude 1.4.2');
  });

  it('takes the version off stderr when that is where the tool prints it', async () => {
    const dir = join(tmpStateRoot(), 'bin');
    fakeBinary(dir, 'claude');
    const result = await probeRuntime({
      runtime: runtime(),
      allowlist: ALLOWLIST,
      searchPath: [dir],
      env: { PATH: '' },
      execFileImpl: fakeExecFile({ claude: { stdout: '', stderr: 'claude 0.9.0\n' } }),
    });
    assert.equal(result.version, 'claude 0.9.0');
  });

  it('refuses a command that is not in the configured allowlist', async () => {
    // The spec arrives in a request body. If the command came with it, this
    // endpoint would be remote command execution.
    await assert.rejects(
      probeRuntime({ runtime: runtime({ command: 'curl' }), allowlist: ALLOWLIST }),
      (err) => {
        assert.ok(err instanceof RuntimeProbeError);
        assert.equal(err.code, 'runtime_command_refused');
        return true;
      },
    );
  });

  it('explains a not-found runtime in terms of the daemon PATH', async () => {
    await assert.rejects(
      probeRuntime({
        runtime: runtime(),
        allowlist: ALLOWLIST,
        searchPath: [],
        env: { PATH: '/nonexistent' },
        execFileImpl: fakeExecFile({}),
      }),
      (err) => {
        assert.equal(err.code, 'runtime_not_found');
        assert.match(err.message, /background service inherits a minimal PATH/);
        return true;
      },
    );
  });

  it('separates "did not answer" from "answered no"', async () => {
    const dir = join(tmpStateRoot(), 'bin');
    fakeBinary(dir, 'claude');
    const timedOut = Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' });
    await assert.rejects(
      probeRuntime({
        runtime: runtime(),
        allowlist: ALLOWLIST,
        searchPath: [dir],
        env: { PATH: '' },
        execFileImpl: fakeExecFile({ claude: { error: timedOut } }),
      }),
      (err) => {
        assert.equal(err.code, 'runtime_unresponsive');
        return true;
      },
    );

    const failed = Object.assign(new Error('exit 1'), { code: 1, signal: null });
    await assert.rejects(
      probeRuntime({
        runtime: runtime(),
        allowlist: ALLOWLIST,
        searchPath: [dir],
        env: { PATH: '' },
        execFileImpl: fakeExecFile({ claude: { error: failed, stderr: 'not logged in\n' } }),
      }),
      (err) => {
        assert.equal(err.code, 'runtime_unhealthy');
        assert.match(err.message, /not logged in/);
        return true;
      },
    );
  });

  it('keeps every line of a failed probe, not just the header', async () => {
    // A tool that fails puts the header on line one and the reason underneath.
    // Reporting only the first line reports the least useful line.
    const dir = join(tmpStateRoot(), 'bin');
    fakeBinary(dir, 'claude');
    const failed = Object.assign(new Error('exit 1'), { code: 1, signal: null });
    const stderr = 'claude: error: authentication failed\n\n'
      + '  token expired at 2026-08-19T04:00:00Z\n'
      + '  run `claude login` to refresh it\n';
    await assert.rejects(
      probeRuntime({
        runtime: runtime(),
        allowlist: ALLOWLIST,
        searchPath: [dir],
        env: { PATH: '' },
        execFileImpl: fakeExecFile({ claude: { error: failed, stderr } }),
      }),
      (err) => {
        assert.equal(err.code, 'runtime_unhealthy');
        assert.match(err.message, /authentication failed/);
        assert.match(err.message, /token expired at 2026-08-19T04:00:00Z/);
        assert.match(err.message, /run `claude login` to refresh it/);
        // Blank lines go; the lines that carry the reason stay.
        assert.ok(!/\n\n/.test(err.message), 'blank lines are collapsed');
        return true;
      },
    );
  });

  it('reports what a runtime said before it was killed for hanging', async () => {
    // "unresponsive" plus the login prompt it printed is a fixable problem;
    // "unresponsive" alone is a shrug.
    const dir = join(tmpStateRoot(), 'bin');
    fakeBinary(dir, 'claude');
    const timedOut = Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' });
    await assert.rejects(
      probeRuntime({
        runtime: runtime(),
        allowlist: ALLOWLIST,
        searchPath: [dir],
        env: { PATH: '' },
        execFileImpl: fakeExecFile({
          claude: { error: timedOut, stderr: 'waiting for browser login\nvisit https://example.test/auth\n' },
        }),
      }),
      (err) => {
        assert.equal(err.code, 'runtime_unresponsive');
        assert.match(err.message, /did not respond/);
        assert.match(err.message, /waiting for browser login/);
        assert.match(err.message, /visit https:\/\/example\.test\/auth/);
        // Node's own "Command failed" adds nothing once we have said it timed out.
        assert.ok(!err.message.includes('Command failed'), 'no redundant node error text');
        return true;
      },
    );
  });

  it('keeps every line of a failed install, and reads stdout when stderr is silent', async () => {
    const dir = join(tmpStateRoot(), 'bin');
    fakeBinary(dir, 'node');
    const failed = Object.assign(new Error('exit 1'), { code: 1, signal: null });
    // An installer script that reports on stdout and exits non-zero would
    // otherwise collapse to an errorless "Command failed".
    const stdout = 'installing claude\nfatal: no write access to /usr/local/bin\nsee ./install.log\n';
    await assert.rejects(
      probeRuntime({
        runtime: runtime({ installCommand: 'node', installArgs: ['install.js'] }),
        allowlist: ALLOWLIST,
        searchPath: [dir],
        env: { PATH: '' },
        allowInstall: true,
        execFileImpl: fakeExecFile({ node: { error: failed, stdout, stderr: '' } }),
      }),
      (err) => {
        assert.equal(err.code, 'runtime_install_failed');
        assert.match(err.message, /fatal: no write access to \/usr\/local\/bin/);
        assert.match(err.message, /see \.\/install\.log/);
        return true;
      },
    );
  });

  it('bounds a runaway output block and says that it did', async () => {
    // A cap that silently drops the tail reads as output that never explained
    // itself, so the message has to admit the truncation.
    const dir = join(tmpStateRoot(), 'bin');
    fakeBinary(dir, 'claude');
    const failed = Object.assign(new Error('exit 1'), { code: 1, signal: null });
    const stderr = `${Array.from({ length: 900 }, (_, i) => `line ${i} of noise`).join('\n')}\n`;
    await assert.rejects(
      probeRuntime({
        runtime: runtime(),
        allowlist: ALLOWLIST,
        searchPath: [dir],
        env: { PATH: '' },
        execFileImpl: fakeExecFile({ claude: { error: failed, stderr } }),
      }),
      (err) => {
        assert.match(err.message, /output truncated at 4000 of \d+ characters/);
        assert.match(err.message, /line 0 of noise/);
        assert.ok(err.message.length < 5000, 'the step record stays bounded');
        return true;
      },
    );
  });

  it('still reports the version as a single line on success', async () => {
    // The multi-line rule is about diagnostics; a version banner is one line and
    // is what the minimum-version check parses.
    const dir = join(tmpStateRoot(), 'bin');
    fakeBinary(dir, 'claude');
    const result = await probeRuntime({
      runtime: runtime(),
      allowlist: ALLOWLIST,
      searchPath: [dir],
      env: { PATH: '' },
      execFileImpl: fakeExecFile({
        claude: { stdout: 'claude 1.4.2\nnode v22.1.0\nplatform darwin-arm64\n' },
      }),
    });
    assert.equal(result.version, 'claude 1.4.2');
  });

  it('will not install unless an operator has allowed it in config', async () => {
    const dir = join(tmpStateRoot(), 'bin');
    const exec = fakeExecFile({ node: { stdout: 'installed\n' } });
    await assert.rejects(
      probeRuntime({
        runtime: runtime({ installCommand: 'node', installArgs: ['install.js'] }),
        allowlist: [...ALLOWLIST],
        searchPath: [dir],
        env: { PATH: '' },
        allowInstall: false,
        execFileImpl: exec,
      }),
      (err) => {
        assert.equal(err.code, 'runtime_install_gated');
        return true;
      },
    );
    assert.deepEqual(exec.calls, [], 'nothing was executed');
  });

  it('installs when allowed, then re-resolves the binary', async () => {
    const dir = join(tmpStateRoot(), 'bin');
    const installer = fakeBinary(dir, 'node');
    const spawned = [];
    const exec = (command, args, options, callback) => {
      spawned.push(command);
      if (String(command).endsWith('node')) {
        // The "installer" is what puts the binary where the probe can find it.
        fakeBinary(dir, 'claude');
        setImmediate(() => callback(null, 'installed\n', ''));
        return;
      }
      setImmediate(() => callback(null, 'claude 2.0.0\n', ''));
    };
    const result = await probeRuntime({
      runtime: runtime({ installCommand: 'node', installArgs: ['install.js'] }),
      allowlist: ALLOWLIST,
      searchPath: [dir],
      env: { PATH: '' },
      allowInstall: true,
      execFileImpl: exec,
    });
    assert.equal(result.installed, true);
    assert.equal(result.verified, true);
    assert.equal(result.version, 'claude 2.0.0');
    // The installer is spawned by the absolute path the search path resolved,
    // not by the bare name it was configured under.
    assert.equal(spawned[0], installer);
  });

  it('resolves the installer on runtimeSearchPath, not just on PATH', async () => {
    // The regression this guards: a daemon inherits launchd's minimal PATH, so
    // a Homebrew `npm`/`brew` is reachable only through runtimeSearchPath. An
    // installer passed to execFile as a bare name dies with ENOENT and takes
    // allowRuntimeInstall with it.
    const dir = join(tmpStateRoot(), 'bin');
    const installer = fakeBinary(dir, 'node');
    const exec = fakeExecFile({ node: { stdout: 'installed\n' }, claude: { stdout: 'claude 3.1.0\n' } });
    const result = await probeRuntime({
      runtime: runtime({ installCommand: 'node', installArgs: ['install.js'] }),
      allowlist: ALLOWLIST,
      searchPath: [dir],
      // Empty PATH is the whole point: only the configured search path can find it.
      env: { PATH: '' },
      allowInstall: true,
      execFileImpl: (command, args, options, callback) => {
        if (String(command).endsWith('node')) fakeBinary(dir, 'claude');
        exec(command, args, options, callback);
      },
    });
    assert.equal(result.installed, true);
    assert.equal(exec.calls[0].command, installer);
    assert.ok(!exec.calls.some((call) => call.command === 'node'), 'no bare-name spawn');
  });

  it('says the installer itself is missing rather than failing with a bare ENOENT', async () => {
    const dir = join(tmpStateRoot(), 'bin');
    const exec = fakeExecFile({});
    await assert.rejects(
      probeRuntime({
        runtime: runtime({ installCommand: 'node', installArgs: ['install.js'] }),
        allowlist: ALLOWLIST,
        searchPath: [dir],
        env: { PATH: '' },
        allowInstall: true,
        execFileImpl: exec,
      }),
      (err) => {
        assert.equal(err.code, 'runtime_installer_not_found');
        assert.match(err.message, /standup\.runtimeSearchPath/);
        return true;
      },
    );
    assert.deepEqual(exec.calls, [], 'nothing was executed');
  });

  it('retries transient installer failures before escalating', async () => {
    const dir = join(tmpStateRoot(), 'bin');
    const installer = fakeBinary(dir, 'node');
    let calls = 0;
    const exec = (command, args, options, callback) => {
      calls += 1;
      if (calls === 1) {
        const err = Object.assign(new Error('TLS handshake timeout'), { code: 1, signal: null });
        setImmediate(() => callback(err, '', 'npm ERR! network timeout\n'));
        return;
      }
      if (String(command) === installer) {
        fakeBinary(dir, 'claude');
        setImmediate(() => callback(null, 'installed\n', ''));
        return;
      }
      setImmediate(() => callback(null, 'claude 3.2.1\n', ''));
    };
    const result = await probeRuntime({
      runtime: runtime({ installCommand: 'node', installArgs: ['install.js'] }),
      allowlist: ALLOWLIST,
      searchPath: [dir],
      env: { PATH: '' },
      allowInstall: true,
      execFileImpl: exec,
      sleepImpl: async () => {},
    });
    assert.equal(result.installed, true);
    assert.equal(result.version, 'claude 3.2.1');
    assert.equal(calls, 3, 'one failed install, one retry, one version probe');
  });

  it('does not retry deterministic installer failures', async () => {
    const dir = join(tmpStateRoot(), 'bin');
    fakeBinary(dir, 'node');
    const failed = Object.assign(new Error('exit 1'), { code: 1, signal: null });
    const exec = fakeExecFile({ node: { error: failed, stderr: 'package name is invalid\n' } });
    await assert.rejects(
      probeRuntime({
        runtime: runtime({ installCommand: 'node', installArgs: ['install.js'] }),
        allowlist: ALLOWLIST,
        searchPath: [dir],
        env: { PATH: '' },
        allowInstall: true,
        execFileImpl: exec,
        sleepImpl: async () => {},
      }),
      (err) => {
        assert.equal(err.code, 'runtime_install_failed');
        assert.match(err.message, /package name is invalid/);
        return true;
      },
    );
    assert.equal(exec.calls.length, 1);
  });

  it('reports an undeclared runtime as undeclared rather than passing', async () => {
    const result = await probeRuntime({ runtime: null, allowlist: ALLOWLIST });
    assert.equal(result.declared, false);
    assert.equal(result.verified, false);
    assert.match(result.reason, /no runtime declared/);
  });

  it('does not execute anything in a dry run', async () => {
    const dir = join(tmpStateRoot(), 'bin');
    fakeBinary(dir, 'claude');
    const exec = fakeExecFile({ claude: { stdout: 'claude 1.0.0\n' } });
    const result = await probeRuntime({
      runtime: runtime(), allowlist: ALLOWLIST, searchPath: [dir], env: { PATH: '' },
      execFileImpl: exec, dryRun: true,
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.verified, false);
    assert.ok(result.resolvedPath);
    assert.deepEqual(exec.calls, []);
  });
});

describe('resolveExecutable', () => {
  it('prefers the configured search path over PATH', async () => {
    const first = join(tmpStateRoot(), 'first');
    const second = join(tmpStateRoot(), 'second');
    const wanted = fakeBinary(first, 'claude');
    fakeBinary(second, 'claude');
    assert.equal(await resolveExecutable('claude', { searchPath: [first], env: { PATH: second } }), wanted);
  });

  it('returns null for a non-executable file', async () => {
    const dir = join(tmpStateRoot(), 'bin');
    fakeBinary(dir, 'claude', 'not executable');
    const { chmodSync } = await import('node:fs');
    chmodSync(join(dir, 'claude'), 0o644);
    assert.equal(await resolveExecutable('claude', { searchPath: [dir], env: { PATH: '' } }), null);
  });
});

describe('satisfiesMinVersion', () => {
  it('compares the first dotted-numeric run component-wise', () => {
    assert.equal(satisfiesMinVersion('claude 1.4.2 (build 9)', '1.4.0'), true);
    assert.equal(satisfiesMinVersion('claude 1.3.9', '1.4.0'), false);
    assert.equal(satisfiesMinVersion('2.0', '1.9.9'), true);
  });

  it('passes a banner it cannot parse rather than failing the step', () => {
    // ARF's parsing limits are ARF's problem, not the operator's.
    assert.equal(satisfiesMinVersion('nightly', '1.0.0'), true);
  });
});

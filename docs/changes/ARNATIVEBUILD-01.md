# ARNATIVEBUILD-01 — verified native-build headers and bounded recovery

## Summary

The existing Test workflow prepares headers for the running Node version with
`node-gyp@12.4.0 install --ensure` before running dependency lifecycle scripts.
Node-gyp verifies the downloaded archive against `SHASUMS256.txt`. Both matrix
versions remain; the Node 26.10.0 compatibility pin remains.

`npm ci --foreground-scripts --loglevel verbose` runs with `V=1` and uses the
prepared headers. Each attempt streams its complete compiler output while the
install runs. Terminal styling is stripped only for failure classification;
printed diagnostics retain their original formatting. Only a
failure with node-gyp's working directory identifying `node_modules/fs-ext`
clears the current version's header cache, prepares verified headers again, and
retries once. Unrelated failures and a failed second attempt remain failures.
Other Node versions' caches are retained.

## Interface changes

`node bin/ci-install.mjs` replaces bare `npm ci` inside the existing install
step. This is a CI installation helper, not an additional check. Runtime locking,
dependency versions, the lockfile, workflow triggers, and the job matrix are
unchanged. The offline test suite exercises it with synthetic subprocesses and
temporary caches, without fetching headers or installing packages.

## Diagnosis

[Diagnostic run 42457728790](https://github.com/laceyenterprises/adversarial-review/actions/runs/42457728790)
passed six fresh-cache default installs and one fresh-cache foreground install
on **each** matrix version. Both used Ubuntu GCC 13.3.0; Node 22.23.4 used
node-gyp 11.5.0 and `-std=gnu++17`, while Node 26.10.0 used node-gyp 12.4.0 and
`-std=gnu++20`. Neither passing build needed an additional compiler flag.

The compiler include arguments, expressed relative to the version's header root
`<headers>`, were:

```text
-I<headers>/include/node
-I<headers>/src
-I<headers>/deps/openssl/config
-I<headers>/deps/openssl/openssl/include
-I<headers>/deps/uv/include
-I<headers>/deps/zlib
-I<headers>/deps/v8/include
-I../../nan
```

[Earlier failing main run 42442668603](https://github.com/laceyenterprises/adversarial-review/actions/runs/42442668603)
identified fs-ext, Node 22.23.4, node-gyp 11.5.0 and undeclared V8 types, but did
not print the compiler command or standard flag. The diagnostic run did not
reproduce that failure. The confirmed problem is intermittent native installation
without useful compiler diagnostics or recovery; header-cache corruption is a
hypothesis, not an established root cause. There is no failing/passing command
comparison supporting a compiler flag, NAN override, or removal of the Node 26
pin. The retained verbose output makes a future failure directly comparable.

## Verification

Final comment-only remediation:

- Ten offline installer tests passed from both the repository root and `test/`,
  using module-relative executable resolution and isolated temporary working
  directories. Cases include styled fs-ext recovery, styled unrelated-addon
  refusal, and a subprocess handshake proving progress arrives before exit.
- Targeted ESLint and `git diff --check`: passed.
- Full-suite validation remains owned by PR-head CI for this remediation.

Initial implementation:

- Synthetic installer tests: seven passed, covering initial success, one clean
  retry, persistent failure, unrelated npm failure, another addon's failure, and
  failure of either header-preparation attempt.
- ESLint on the installer and its tests: passed.
- Repository lint: zero errors (existing warnings).
- Contract typecheck and offline byte-equivalence demo: passed.
- Full offline suite: 18,629 passed, 11 skipped, three environment failures in
  untouched tests. `derived-artifacts.test.mjs` cannot spawn `ps` in the worker
  sandbox; two `dispatch-read-context.test.mjs` assertions receive the validation
  wrapper's CPU-sample diagnostic on stderr where they expect empty output.
- The diagnostic CI workflow passed both matrix versions. Final PR workflow
  evidence is recorded in the PR body.

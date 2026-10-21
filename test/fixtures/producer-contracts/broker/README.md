# Broker readiness captures (PRM-02)

Owner: `oauth_broker.server.readyz` / `_readyz_inner`; definitions:
[`status_contract.py`](../../../src/oauth_broker/status_contract.py)
(`ReadyzPayload`, `ProviderState`, `RollStatusPayload`, `GrantObservation`). `roll_status_payload`
adds credential-free grant and refresh-flight observations. Existing
`ProviderStatus` types provider health input; it is not the emitted wire type.

The producer's aggregate `providers` map applies blocking/tolerance policy.
`provider_states.<name>.ready` is explicit provider readiness; `can_serve` is
cached-token servability. A degraded provider may serve with positive expiry
runway, and a tolerated corporate provider can have aggregate `providers=true`
while its explicit `ready=false`. Readers must preserve those distinctions.

Status vocabulary is `ready`, `degraded`, `not_ready`; `kind` is a provider-owned
string or null. Required state fields are `state`, `kind`, `ready`, `can_serve`.
`grants.*.seconds_since_last_refresh` is optional: store observations supply
it, while cache-hydrated grants supply only last refresh, fingerprint and provider.
Refresh ownership, failure/age/runway, worker-grant and provider-health fields
are optional extensions. Ages and epoch timestamps are seconds. Absent owner
or deadline observations remain null. Disabled providers are omitted from both
maps and named in optional `disabled_providers`; absent configuration and
provider degradation use their existing separate maps. Authentication status,
provider details, store errors, instance identity, grants and refresh flight
remain present on readyz output. `/readyz` is unauthenticated; readiness HTTP
200/503 and the aggregate status are not per-provider token verdicts.

Wire identifiers are registered names: `codex`, `codex-corp`, `claude-code`,
`claude-code-corp`, `gemini`, and registered `github-app-*` names. Quota aliases
`openai`, `anthropic`, `google` belong to the existing consumer resolver, not
this wire contract. `forward_status.build_forward_status` retains its separate
forward classification and existing exits (0 healthy/degraded, 2 outage,
64 usage); no forward-health or watchdog policy changes here.

The shared Python readiness mechanism is
`agent_os_core.broker_evidence.provider_evidence`. Wire definitions stay
dependency-free in `oauth_broker.status_contract`. It supports explicit provider states, legacy
`providers` booleans and the fleet CLI's legacy flat map. Historical truthiness
is opt-in for the CLI; harness health uses the strict `ready_bool` accessor,
which returns null for malformed legacy readiness values. The raw `ready`
value remains available for compatibility.
Malformed/absent fields and unrecognized statuses name producer and field;
compatibility coercions and owner servability policy do not gain new holds.

## Provenance and recapture

Repository: `agent-os`; producer logic revision:
`2f686a90a102cf52e631dbf597d3e85826dc7b5d`. PRM-02 only annotates existing broker
output; serialization and readiness policy are unchanged. Capture inputs and
fake transport are in
[`test_endpoints.py::test_readyz_producer_capture_parity`](../../integration/test_endpoints.py).
`StubProvider` supplies provider bootstrap/health results without external I/O;
the real broker app, token cache, roll-status builder and HTTP serializer run
against disposable stores and TestServer loopback ports.

The four examples record HTTP status and complete decoded bodies:
`readyz-ready.json` has fresh cached tokens; `readyz-unavailable.json` has no
bootstrap tokens; `readyz-degraded.json` has transient health failure with fresh
servable tokens; `readyz-disabled.json` disables Gemini. All cover primary and
corporate Codex/Claude, Gemini and a GitHub App provider. The input wall clock is
1800000000, tokens have 3600 seconds of runway, and refresh-age clock is 20
seconds after broker start. A real `grant_record(auth_payload())` from synthetic
credentials supplies the Codex token metadata; the actual cache/roll serializer
emits its non-secret fingerprint prefix, provider and epoch/age fields.
Instance runtime is explicitly native. Normalization
replaces only PID with 1, volatile instance identifiers with `<instance>` when
present, and temporary-root path prefixes with `<scratch>`. Types, keys, nulls,
status, durations, percentages and fake-token fingerprints are preserved.

From the repository root (using the broker's hydrated test environment):

```bash
export NETGUARD_ROOT="${NETGUARD_ROOT:?set to your provisioned netguard root}"
test -d "$NETGUARD_ROOT/bin" && test -d "$NETGUARD_ROOT/site-liveports"
NETGUARD_LOG=/tmp/prm02-broker-recapture.log \
PATH="$NETGUARD_ROOT/bin:$PATH" PYTHONPATH="$NETGUARD_ROOT/site-liveports" \
PRM_RECAPTURE=1 "${PYTHON:-python3}" -c 'import subprocess,sys; raise SystemExit(subprocess.run([sys.executable,"-m","pytest","tests/integration/test_endpoints.py","-k","producer_capture_parity","-q","--disable-warnings"],cwd="platform/oauth-broker",timeout=120).returncode)'
```

The operator authorized `site-liveports` for PRM-02: it blocks off-host and
already-listening ports while allowing the disposable servers created by these
tests. The provisioned `bin` directory must contain guarded command wrappers;
`site-liveports` must contain a Python startup guard permitting only new
loopback listeners, and `site` the socket-free guard. Keep `NETGUARD_LOG`.
Set `PYTHON` to an interpreter with the broker test dependencies installed.
Capture tests freeze broker module clock bindings without modifying the shared
process clock. `PRM_RECAPTURE=1` writes captures and marks those tests skipped;
rerun without it to verify parity. Producer tests compare the real normalized
response against each example. Worker fleet-envelope and harness-health tests
read these same files. `test_readyz_provider_states.py` labels malformed
mutations as negative tests, and verifies legacy policy separately.

No service activation or policy change is required for these annotations.
Existing state-machine transitions, readiness promises, smoke checks and service
owner/restart paths remain unchanged; no smoke or state declaration is added.

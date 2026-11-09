// Only disposable conformance subprocesses import this file.
import os from 'node:os';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

let at = 0;
const clocks = [];
if (/\/hammer-(?:context|predicate-inputs)\.mjs$/.test(process.argv[1] || '')) {
  const { closureGateClock } = await import('../../src/ama/closure-gate-read.mjs');
  clocks.push(closureGateClock);
}
if (process.argv[1]?.endsWith('/hammer-conflict-primary.mjs')) {
  const { hammerNetworkClock } = await import('../../src/ama/hammer-api-network.mjs');
  clocks.push(hammerNetworkClock);
}
if (process.argv[1]?.endsWith('/hammer-controller.mjs')) {
  await import('../helpers/dispatch-read-fixture.mjs');
  await import('../helpers/dispatch-files-preload.mjs');
  const { launchEnvironmentClock } = await import('../../src/ama/hammer-controller.mjs');
  clocks.push(launchEnvironmentClock);
  const { dispatchReadTransport } = await import('../../src/dispatch-read-client.mjs');
  const lookup = dispatchReadTransport.lookup;
  dispatchReadTransport.lookup = async (selector, args) => {
    if (selector.observation) return lookup(selector, args);
    return { schema_version: 1, status: 'found', complete: true,
      roots: ['lrq_contract'], retry_edges: [], items: [{
        launch_request_id: 'lrq_contract', status: 'running', ticket_ref: 'SYNTHETIC',
        target_repo: 'fixture/repo', head_sha: null, failure_detail: null,
        updated_at: '2026-01-01T00:00:00Z',
      }] };
  };
}
for (const clock of clocks) {
  clock.now = () => at;
  clock.sleep = async ms => { at += ms; };
}
os.loadavg = () => [0, 0, 0];
const offline = () => { throw Error('conformance fixture forbids network'); };
net.connect = net.createConnection = tls.connect = offline;
http.request = http.get = https.request = https.get = offline;
globalThis.fetch = offline;
syncBuiltinESMExports();

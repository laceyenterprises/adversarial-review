# ARWATCHERRSS-02

## Summary

Reuse the watcher's native child latency histograms across polls. A controlled
replay attributed synthetic RSS growth to recreating the histograms every
pass. The SEV3 report records the reproduction and the remaining uncertainty
about the full service growth rate.
[SEV3 report](../postmortems/SEV3-watcher-native-histogram-allocation-ARWATCHERRSS-02.md)

## Interface changes

`NODE_DEBUG=adversarial-watcher-memory` enables a per-poll debug line with
`rss`, `heapUsed`, `external` and `arrayBuffers` in bytes.

## Verification

- `node test/run-tests.mjs test/watcher-poll-memory.test.mjs test/watcher-latency.test.mjs test/watcher-claim-loop.test.mjs`
  passed all 191 tests.
- `npm run lint` passed with zero errors. `npm run typecheck:contracts` and
  `bash demo/research-finding-walkthrough.sh` passed.

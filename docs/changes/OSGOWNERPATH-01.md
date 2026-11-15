# OSGOWNERPATH-01

## Summary

Resolve reviewer-arm Python launches from the configured deployment, supplying
explicit package roots and interpreter precedence. Preserve default routing
while distinguishing transport failures and allowing loaded-host startup.
See the [SEV3 report](../postmortems/SEV3-OSGOWNERPATH-01-reviewer-owner-could-not-import-2026-11-15.md)
for incident evidence, sibling audit and validation limits.

## Interface changes

The owner uses existing deployment and load-aware configuration; no schema keys
are added. Its five-second nominal timeout scales up to 30 seconds. Failure
reasons distinguish spawn, import, timeout, exit and invalid JSON. Raw stderr
remains private. The README documents the launch and timeout contract.
The deployment configuration fallback honors the supplied environment's
`AGENT_OS_CONFIG_PATH` rather than ambient process configuration. Import failure
classification also covers Python `ImportError` symbol resolution failures.

## Verification

- `node --test test/osg-reviewer-arm.test.mjs`: 13 passed, individually bounded
  to 600 seconds through worker validation, with netguard.
- Changed-source ESLint autofix: passed with no rewrites.
- `npm run lint`: passed, zero errors; 149 warnings outside changed sources.
- `npm run typecheck:contracts`: passed.
- Full suite and walkthrough demo omitted under this ticket's scoped-test
  restriction.

Final comment-only remediation validation:

- `bash bin/run-bounded.sh --timeout 60 --tail-bytes 6000 -- node --test test/osg-reviewer-arm.test.mjs`:
  14 passed, including isolated configuration paths and missing-symbol imports
  with private diagnostics and default routing preserved in apply/shadow.
- `npm run lint`: passed, zero errors and 149 existing warnings.
- `npm run typecheck:contracts`: passed.
- `git diff --check`: passed.

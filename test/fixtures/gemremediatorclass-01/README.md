# Frozen downstream seams

`sources.json` records immutable GitHub source commits, paths and SHA-256 of
verbatim function extracts. Keep `adapters.py`, `agy_builder.py` and
`gemini_runtime.py` unchanged when formatting this fixture. `classes.json`
contains the two named registry entries from merged REMGEMINI-01.

`consumer.py` supplies synthetic configuration and registry plumbing and
executes those source functions. It does not mock successful native identity:
the real dedicated-builder selector sees an empty pool and refuses `gemini`.
The rendered AR remediation request avoids that builder-only selector while
retaining the native launch IDs, network and registered model policy.
No worker, sudo, credential check or provider request is executed.

This fixture composes two pinned source versions. It does not assert that
unrebased #10117 already includes #10087, nor replace exact-head paired
integration and normal cross-model review.

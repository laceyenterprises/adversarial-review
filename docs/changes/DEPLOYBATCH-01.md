# DEPLOYBATCH-01

Mirror `main_catchup.deploy_batch_window_seconds` in the strict Node CFG reader:
integer, minimum zero, default 1200 seconds. Python main-catchup owns cadence;
this reader only accepts the shared configuration. Land this companion before
the agent-os config addition to preserve all three strict loaders' parity.
Offline fixtures cover defaults, overrides and invalid types/ranges through
both strict and runtime readers. No service or live configuration change.

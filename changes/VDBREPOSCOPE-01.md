# VDBREPOSCOPE-01

Accept `session_ledger.vdb.clone_repos` as a list of repository strings, defaulting
to `[agent-os]`, alongside the agent-os Python and shell configuration readers.
This lets strict Node readers load the workspace-scoped clone policy without
rejecting the new key. AR is explicitly included in agent-os configuration
because its tests use session-ledger fixtures and environment selectors.

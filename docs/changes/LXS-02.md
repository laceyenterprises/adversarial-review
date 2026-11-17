# LXS-02 — Relay CFG reader parity

Spec: `lacey-studio@2e0c25ed669c`.

A focused offline regression verifies that the Node reader ignores Python-owned
`app_relay.apps` in checked-in and local configuration, through strict and
runtime loaders. Existing reader scoping already provides this behavior; no
production loader change or new configuration/environment variable is needed
in this repository. The daemon and authoritative schema ship in Agent OS.

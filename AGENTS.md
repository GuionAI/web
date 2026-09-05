# AGENTS.md

## Platform validation

Repository CI and local tests target Linux. Treat Windows behavior as best-effort here: keep Windows runners, Windows-specific smoke scripts, and simulated Windows tests out of this repository. Validate published packages on real Windows only in the downstream project that owns Windows usage.

## DSH rc.1 Loader validation

For profile-local packaged plugins on DSH `0.1.2-rc.1` with Node 24, install the official rc.1 CLI into a test-owned disposable directory and validate its real installed graph through the Node entrypoint with internals enabled: `node --expose-internals <disposable-install>/node_modules/@deepseek-ai/dsh/lib/bin.js ...`. Keep `DSH_HOME` test-owned and disposable, do not use a deployed runtime or live credentials, and do not add custom runtime overrides or compatibility layers.

## Managed DSH presets

The supported preset workflow is explicit: run `web dsh sync` before installing
or activating `@guionai/dsh-web`, then run `web dsh doctor` and require a zero
exit status. Sync owns only marked copies of `standard`, `ptc`, `cordis`, and
`minimal` under the test-owned DSH user preset root; it must refuse unmarked
same-id conflicts and must not mutate shipped presets, ordinary user presets,
credentials, or sessions. Tests use fixture source trees and disposable
`DSH_HOME` directories. End-to-end validation exercises the packed artifact
through the real Linux rc.1 Loader path and records the disposable paths and
results in the implementation report. Do not validate this integration by
redirecting an agent home to a live deployment or by adding runtime overrides.

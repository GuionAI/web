# AGENTS.md

## Platform validation

Repository CI and local tests target Linux. Treat Windows behavior as best-effort here: keep Windows runners, Windows-specific smoke scripts, and simulated Windows tests out of this repository. Validate published packages on real Windows only in the downstream project that owns Windows usage.

## DSH rc.1 Loader validation

For profile-local packaged plugins on DSH `0.1.2-rc.1` with Node 24, validate on the NUC through its installed official `dsh` CLI and real Loader. Keep `DSH_HOME` and every generated profile test-owned and disposable; the installed CLI and preset package are read-only inputs. Never use live profiles, presets, credentials, overrides, or services, and do not add custom runtime overrides or compatibility layers.

## Managed DSH presets

The supported preset workflow is explicit: run `web dsh sync` before installing
or activating `@guionai/dsh-web`, then run `web dsh doctor` and require a zero
exit status. Sync compares `standard`, `ptc`, `cordis`, and `minimal` with the
official and compatible trees; modified same-id content requires interactive
confirmation or `--yes`. It must not mutate shipped presets, unrelated user
presets, credentials, or sessions. Tests use fixture source trees and
disposable `DSH_HOME` directories. End-to-end validation runs on the NUC with
its installed official CLI, a disposable `DSH_HOME`, and current packed Guion
artifacts, and records the paths and results in the implementation report.

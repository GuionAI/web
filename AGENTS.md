# AGENTS.md

## Platform validation

Repository CI and local tests target Linux. Treat Windows behavior as best-effort here: keep Windows runners, Windows-specific smoke scripts, and simulated Windows tests out of this repository. Validate published packages on real Windows only in the downstream project that owns Windows usage.

## DSH alpha.3 Loader validation

For profile-local packaged plugins on DSH `0.1.2-alpha.3` with Node 24, run Host and browser acceptance through the deployed Node entrypoint with internals enabled: `node --expose-internals /home/neil/.local/share/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js ...`. The plain shebang `dsh ...` entrypoint is diagnostic-only on this host/version and is not a supported acceptance path because it cannot resolve profile-local bare plugin specifiers. Use a test-owned disposable `DSH_HOME` and no live credentials.

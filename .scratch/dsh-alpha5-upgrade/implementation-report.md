# DSH Web 0.1.2-rc.1 implementation report

## Scope

- Repository: `guionai/web`
- Branch: `dsh-alpha5-upgrade`
- Fixed point: `d65ad78`
- Delivery boundary: the Target Amendment in `spec.md`, including tickets 01
  and 02. Code review and deployment were excluded.

The Target Amendment reopened the previously completed tickets and superseded
their prior target. Ticket 01 was retargeted first, followed by ticket 02's
documentation and loader guidance. Both tickets and the spec are now recorded
as complete.

## Ticket outcomes

### 01 — Run Guion DSH Web on the rc.1 package contract

- Replaced every owned DSH peer and development dependency in
  `packages/dsh-web/package.json` with the exact `0.1.2-rc.1` version. Cordis,
  Schemastery, React, and the ordinary Web/Pi package contracts were unchanged.
- Regenerated `pnpm-lock.yaml` atomically. The owned DSH Web importer entries
  and package snapshots now resolve the rc.1 family, with no alpha.5 entries.
- Updated the package and provider seam assertions to name rc.1. Existing
  provider search, credentials, browser rendering, settings, and tool-card
  behavior required no source migration, compatibility adapter, or runtime
  override.
- The packed-artifact smoke continues to exercise host registration, search,
  HTTP and browser rendering, links, tool registration, patch metadata, and the
  lazy browser client against the exact rc.1 package contract.

### 02 — Document Guion DSH Web's rc.1 package contract

- Updated the DSH package description, README, profile-patch comment, and
  package-facing test wording to identify `0.1.2-rc.1`.
- Updated `AGENTS.md` with the verified official rc.1 CLI/Loader workflow:
  install the CLI in a disposable directory, use a disposable `DSH_HOME`,
  invoke its `lib/bin.js` entrypoint with Node 24 `--expose-internals`, and use
  no live credentials or custom runtime overrides.
- Inspected the root `README.md`; it makes no DSH release-version promise, so
  no root README change was needed.

## Verification

All checks passed on Linux:

- `pnpm install --frozen-lockfile --ignore-scripts`
- `pnpm --filter @guionai/dsh-web run typecheck`
- `pnpm --filter @guionai/dsh-web run test` — 6 files, 26 tests passed
- `pnpm --filter @guionai/dsh-web run build`
- `pnpm --filter @guionai/dsh-web run test:pack` — packed artifact passed
- `pnpm typecheck`
- `pnpm format:check`
- `pnpm test:release`
- `pnpm test` — 20 files, 153 tests passed
- `pnpm build` — all four workspace packages built
- `pnpm test:pack` — Web, Pi, and DSH packed smokes passed
- `git diff --check`

The official CLI check used an isolated temporary install of
`@deepseek-ai/dsh@0.1.2-rc.1` (213 DSH packages in its installed graph) and a
separate disposable `DSH_HOME`. The Node entrypoint reported `0.1.2-rc.1`,
installed the packed Guion artifact into the disposable `web` profile,
composed `--dump-config` with the Guion patch and bundle, and booted the web
profile successfully with `--help` and the local server path. No live
credentials, deployed profiles, browsers, or production services were used.

Vitest emitted the existing non-failing missing source-map warning from the
DSH primitives package. Package smokes used injected operations, local
fixtures, and test-owned temporary package/cache paths.

## Changed paths

- `AGENTS.md`
- `packages/dsh-web/package.json`
- `packages/dsh-web/README.md`
- `packages/dsh-web/cordis.patch.yml`
- `packages/dsh-web/test/artifact.test.ts`
- `packages/dsh-web/test/package.test.ts`
- `pnpm-lock.yaml`
- `.scratch/dsh-alpha5-upgrade/implementation-report.md`

No DSH product source, ordinary Web package, or Pi Web package contract
changed. The local spec and issue files were updated in place; they remain
project scratch records and are ignored by the repository's global scratch
ignore rule.

## LOC accounting

Against fixed point `d65ad78`, excluding the lockfile, generated artifacts,
the report, and ignored tracker files:

| Category | Additions | Deletions |
| --- | ---: | ---: |
| Product code | 0 | 0 |
| Tests | 3 | 3 |
| Configuration and docs | 33 | 33 |
| **Total** | **36** | **36** |

The 72 touched lines are within the spec's 25–75 changed-LOC estimate. The
focused size reflects a dependency/documentation contract update that reuses
the existing provider, UI, artifact, and CLI verification seams.

## Acceptance result

The rc.1 Target Amendment, tickets 01 and 02, and the existing DSH Web
behavior are implemented and verified. Guion DSH Web now publishes one exact
`0.1.2-rc.1` peer/dev contract with a refreshed lockfile, package/test/docs
assertions, and passing packed validation against the official rc.1 CLI graph.

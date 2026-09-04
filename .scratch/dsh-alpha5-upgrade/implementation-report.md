# DSH Web alpha.5 implementation report

## Scope

- Repository: `guionai/web`
- Branch: `dsh-alpha5-upgrade`
- Fixed point: `8e2218136ec71c2b66213804e4533af3bc782038`
- Delivery boundary: the complete `dsh-alpha5-upgrade` spec and tickets 01 and
  02. Code review and deployment were excluded.

The dependency frontier was implemented in order: the package contract first,
then its documentation and loader guidance.

The project-local completion record now also reflects the verified result:
`spec.md` and both issue files have `Status: complete`, and all six ticket
acceptance criteria are checked.

## Ticket outcomes

### 01 — Run Guion DSH Web on the alpha.5 package contract

- Replaced every owned DSH peer and development dependency in
  `packages/dsh-web/package.json` with the exact `0.1.2-alpha.5` version. The
  Cordis `4.0.2`, Schemastery `3.18.2`, React, and ordinary Web/Pi package
  contracts were left unchanged.
- Regenerated `pnpm-lock.yaml` atomically and installed it with
  `--frozen-lockfile`; the direct DSH importer entries resolve to alpha.5.
- Alpha.5 preserves the imported Host, WebRuntime, credential, settings, tool,
  and browser-client seams, so no Session compatibility adapter or product-code
  migration was needed. Existing provider search, credentials, rendering,
  settings, and tool behavior remain covered by the package tests.
- Updated package-facing alpha assertions and gave the packed host test a
  30-second per-test budget for the larger alpha.5 host bundle.

### 02 — Document Guion DSH Web's alpha.5 package contract

- Updated the DSH package description, README, and profile-patch comment to
  identify the exact `0.1.2-alpha.5` contract.
- Updated `AGENTS.md` to the alpha.5 Loader rule. Published alpha.5 metadata
  keeps the existing `lib/bin.js` CLI entrypoint, so the disposable Node 24
  `--expose-internals` workflow and its no-live-credentials boundary remain
  valid; the plain shebang remains diagnostic-only on this host.
- Inspected the root `README.md`; it contains no alpha-specific DSH version
  promise, so no root documentation change was needed.

## Verification

All checks passed on Linux:

- `pnpm install --frozen-lockfile --ignore-scripts`
- `pnpm --filter @guionai/dsh-web run typecheck`
- `pnpm --filter @guionai/dsh-web run test` — 6 files, 26 tests passed
- `pnpm --filter @guionai/dsh-web run build`
- `pnpm --filter @guionai/dsh-web run test:pack` — 2 packed-artifact tests
- `pnpm typecheck`
- `pnpm format:check`
- `pnpm test:release`
- `pnpm test` — 20 files, 153 tests passed
- `pnpm build` — all four workspace packages built
- `pnpm test:pack` — Web, Pi, and DSH packed smokes passed
- `git diff --check`

Vitest emitted the existing non-failing missing source-map warning from the DSH
primitives package. Tests used injected operations, local fixtures, and
test-owned temporary package/cache paths; no live credentials, profiles,
browsers, production services, or host state were used.

## Changed paths

- `packages/dsh-web/package.json`
- `packages/dsh-web/README.md`
- `packages/dsh-web/cordis.patch.yml`
- `packages/dsh-web/test/artifact.test.ts`
- `packages/dsh-web/test/package.test.ts`
- `pnpm-lock.yaml`
- `AGENTS.md`

No DSH product source, ordinary Web package, or Pi Web package contract
changed. The lockfile is excluded from LOC accounting below, as are generated
artifacts and this report.

## LOC accounting

Against fixed point `8e2218136ec71c2b66213804e4533af3bc782038`, excluding the
lockfile, generated files, and this report:

| Category | Additions | Deletions |
| --- | ---: | ---: |
| Product code | 0 | 0 |
| Tests | 4 | 4 |
| Configuration and docs | 33 | 33 |
| **Total** | **37** | **37** |

The 74 touched lines are within the spec's 25–75 changed-LOC estimate. The
focused size reflects a dependency/documentation contract update that reuses
the existing provider, UI, artifact, and verification seams.

## Acceptance result

Tickets 01 and 02 and the complete `dsh-alpha5-upgrade` spec are implemented
and verified. Guion DSH Web now publishes one exact alpha.5 peer/dev contract,
with refreshed lockfile, package/test/docs assertions, and passing packed
provider and client validation. The spec and ticket tracker statuses and
criteria are recorded as complete.

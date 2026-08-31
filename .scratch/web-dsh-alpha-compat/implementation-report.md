# DSH Web alpha.3 implementation report

## Scope

- Repository: `guionai/web`
- Branch: `web-dsh-alpha-compat`
- Fixed point: `bafb7cb0b2c3ad0987c98a1ae95f80f7272992d6`
- Implementation commit: `3e83537` (`feat(dsh-web): migrate plugin to DSH alpha.3`)
- Authority: published DSH `0.1.2-alpha.3` packages and current official Harness source. The browser settings scope follows alpha's `packages/client/ui-settings/src/client/settings-contract.ts` and `settings-scope.ts` contract.

The complete dependency frontier was implemented in ticket order:

### 01 — Run the Web provider on alpha.3

- Replaced the retired `@deepseek-ai/dsh-client-runtime` import, client injection, peer dependency, dev dependency, and bundle external with the alpha UI renderer seam.
- Updated the declared DSH peer and development dependency family to `0.1.2-alpha.3`, with Cordis `4.0.2` and Schemastery `3.18.2`.
- Migrated credential calls to the alpha direct `remote.credentials` API and alpha `RemoteResult` shape while preserving search, fetch, link, provider, tool-result, and error behavior.

### 02 — Run Web tool and settings surfaces on alpha.3

- Migrated browser client context and settings scope imports to alpha owners.
- Uses alpha browser services (`remote`, `remote.credentials`, `settingsScope`, and `slots`) and the alpha credentials event `credentials/reference-updated`.
- Keeps the existing Web tool renderer registration, settings card interactions, native slot seam, and CSS/theme behavior; no official conversation DOM or compatibility adapter was introduced.
- Registers the package settings namespace through the alpha literal namespace contract.

### 03 — Verify the packed alpha Web artifact

- Extended the existing isolated packed-artifact test to assert alpha peer versions, absence of the retired Runtime and `0.1.1-rc.2` paths, Host registration, and lazy browser-client loading.
- Temporary package installs and host fakes remain test-owned; no live credentials, browsers, profile state, or research services are used.

## Changed paths

- `packages/dsh-web/package.json`
- `packages/dsh-web/src/client.ts`
- `packages/dsh-web/src/index.ts`
- `packages/dsh-web/tsup.config.ts`
- `packages/dsh-web/test/client.test.ts`
- `packages/dsh-web/test/artifact.test.ts`
- `packages/dsh-web/test/package.test.ts`
- `packages/dsh-web/README.md`
- `packages/dsh-web/cordis.patch.yml`
- `pnpm-lock.yaml`

## Verification

All checks completed successfully on Linux:

- `pnpm install --frozen-lockfile`
- `pnpm --filter @guionai/dsh-web run typecheck`
- `pnpm --filter @guionai/dsh-web run build`
- `pnpm --filter @guionai/dsh-web run test:pack` — 2 tests passed
- `pnpm --filter @guionai/dsh-web test` — 5 files, 17 tests passed
- `pnpm run typecheck`
- `pnpm run build` — all 4 packages built
- `pnpm test` — 15 files, 83 tests passed
- `pnpm test:release`
- `pnpm format:check`
- `git diff --check`

The alpha primitives package emits a non-failing missing source-map warning during Vitest; it does not affect the results. No code review or deployment was performed, as excluded by the request.

## LOC variance

Excluding the lockfile and generated artifacts, the implementation changed 139 lines added and 110 removed (249 total changed lines). The estimate was 270–510 changed lines, so the result is 21 lines below the lower bound. The variance is due to a focused contract migration that reuses the existing provider, UI, test, and artifact infrastructure instead of adding adapters or new product behavior.

## Acceptance result

Tickets 01, 02, and 03 are complete. The packed artifact has no bundled DSH internals, no retired Runtime path, and no old `0.1.1-rc.2` contract; Host and lazy browser client loading are verified in isolated temporary state.

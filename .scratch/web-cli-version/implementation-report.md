# Embedded Web CLI version implementation report

## Scope

- Repository: `guionai/web`
- Branch: `web-cli-version`
- Fixed point: `89cfe70cc33ccb10d403444fcaa2ee0ec083c2fa`
- Implementation commit: `1092788229ff08d25577b77bec8b8000c67cea83`
  (`feat(cli): report embedded package version`)
- Delivery boundary: the complete `web-cli-version` spec and ticket 01.
  Code review and deployment were excluded.

## Ticket outcome

### 01 — Report the embedded Web CLI version

- The root Commander program now exposes the standard `-V, --version` option.
  Both flags write exactly the Web package version and a newline to stdout,
  return success, and bypass all research operations and credential loading.
- The Web tsup build reads `packages/web/package.json` while building and
  replaces a dedicated compile-time token with that manifest version. The
  bundled CLI contains the literal and does not read Git or package metadata at
  invocation time. Release checkout synchronization therefore supplies the
  tag-derived value, while local builds use the local manifest value.
- The packed Web smoke test invokes both flags, compares stdout with the
  packed manifest version, changes the test-owned installed manifest, and
  verifies that both flags still report the original packed value.
- The root README documents `web --version` and `web -V` in the CLI guidance.

## Verification

All relevant checks passed on Linux:

- `pnpm format:check` — all repository formatting checks passed.
- `pnpm exec prettier --check vitest.config.ts packages/web/src/version.ts` —
  the root config and new source module also match Prettier.
- `git diff --check` — no whitespace errors.
- `pnpm typecheck` — TypeScript completed successfully.
- `pnpm exec vitest run packages/web/test/program.test.ts` — 17 tests passed,
  including both Commander version flags and the no-operation/no-credential
  contract.
- `pnpm test` — 19 files and 144 tests passed. The existing missing DSH
  primitive source-map warning was non-fatal.
- `pnpm build` — all four workspace packages built and Web generated
  `packages/web/dist/openapi.yaml`.
- `pnpm test:release` — release version synchronization fixtures passed.
- `pnpm test:pack` — Web, Pi, and DSH packed-installation/host-loading checks
  passed; the DSH artifact suite passed its 2 tests.

The packed smoke uses test-owned temporary package, cache, and browser-fixture
paths. No live credentials, production services, or persistent user state were
used.

## Changed paths and size

Against the fixed point, excluding generated `dist` output, lockfiles, and
this report:

- Product code: 12 additions and 1 deletion across the Commander adapter,
  runner, and embedded-version module.
- Build/test configuration: 21 additions in the Web tsup define and Vitest
  test define.
- Tests: 58 additions covering both flags, output routing, no credentials or
  operations, and packed-manifest mutation.
- Documentation: 1 addition in the root README.
- Total: 92 additions and 1 deletion (93 touched lines). This is 25 lines
  above the spec's 28–68-line estimate because the implementation includes
  both a direct Commander contract test and a two-stage packed smoke assertion
  plus the manifest-derived test define needed for synchronized release
  versions.

## Remaining concerns

- Code review and deployment were intentionally not run, as excluded by the
  request.
- Version commands are scoped to the Web executable; MCP metadata and the Pi,
  DSH, and Web Core package versions remain unchanged as required.

## Acceptance result

Ticket 01 and the complete `web-cli-version` spec are implemented, committed,
and verified.
